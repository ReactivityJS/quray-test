// ════════════════════════════════════════════════════════════════════════════
// QuRay — backends/blobstore.js
// Hybrid Blob-Storage: OPFS für große Dateien, IDB als universeller Fallback.
//
// ┌─ Warum kein base64? ──────────────────────────────────────────┐
// │  base64 = 33% mehr Speicher + CPU für En/Decode.              │
// │  IDB kann native Blob-Objekte speichern — direkt, ohne        │
// │  Konvertierung. Für große Dateien (Video, Audio) ist das      │
// │  der Unterschied zwischen "funktioniert" und "hängt".         │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ Hybrid-Strategie ────────────────────────────────────────────┐
// │  < IDB_THRESHOLD (1 MB):  IDB als nativer Blob                │
// │  ≥ IDB_THRESHOLD:         OPFS (Origin Private File System)   │
// │  OPFS nicht verfügbar:    IDB-Fallback für alle Größen        │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ OPFS Vorteile ───────────────────────────────────────────────┐
// │  - Kein IDB-Timeout-Risiko bei großen Writes (Android!)       │
// │  - Synchroner Zugriff im Worker (schnellste Option)           │
// │  - Kein Quota-Druck (eigenes Storage-Kontingent)              │
// │  - Chrome 86+, Firefox 111+, Safari 15.2+                    │
// └───────────────────────────────────────────────────────────────┘
//
// Interface:
//   put(hash, blobOrBuffer, meta?)  → Promise<{ hash, size, mime, storage }>
//   get(hash)                       → Promise<Blob | null>
//   getUrl(hash)                    → Promise<string | null>  (Object URL)
//   getMeta(hash)                   → Promise<meta | null>
//   del(hash)                       → Promise<void>
//   has(hash)                       → Promise<boolean>
//   list()                          → Promise<[{ hash, meta }]>
//   clear()                         → Promise<void>
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// KONSTANTEN
// ─────────────────────────────────────────────────────────────────────────────

// Unter diesem Wert → IDB, darüber → OPFS (wenn verfügbar)
const IDB_SIZE_THRESHOLD_BYTES = 1 * 1024 * 1024   // 1 MB

// IDB-Datenbank für Blob-Inhalte (getrennt von Daten-IDB!)
const BLOB_IDB_NAME      = 'quray-blobs'
const BLOB_IDB_VERSION   = 1
const BLOB_STORE_NAME    = 'blobs'     // native Blob-Objekte
const META_STORE_NAME    = 'meta'      // { hash, mime, name, size, storage, ts }

// OPFS-Verzeichnis
const OPFS_DIR_NAME = 'quray-blobs'

// IDB-Timeouts (Android-Guards)
const IDB_OPEN_TIMEOUT_MS = 8_000
const IDB_TX_TIMEOUT_MS   = 15_000   // Blobs brauchen länger als Daten

// Speicherorte
const STORAGE_LOCATION = {
  IDB:  'idb',
  OPFS: 'opfs',
}


// ─────────────────────────────────────────────────────────────────────────────
// MIME-SNIFFING aus Magic Bytes
// file.type ist auf Firefox/Mobile/Android oft leer — Magic Bytes sind zuverlässig
// ─────────────────────────────────────────────────────────────────────────────
const sniffMimeType = (buffer) => {
  const bytes = new Uint8Array(
    buffer instanceof ArrayBuffer ? buffer : buffer.buffer ?? buffer,
    0,
    Math.min(16, buffer.byteLength ?? buffer.length ?? 0)
  )
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF)                       return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)                       return 'image/gif'
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4'
  if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) return 'video/webm'
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)                       return 'audio/mpeg'
  if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) return 'audio/flac'
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf'
  if (bytes[0] === 0x50 && bytes[1] === 0x4B)                                            return 'application/zip'
  return 'application/octet-stream'
}


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE IDB-HILFSKLASSE (für Blobs — getrennte DB von Daten!)
// ─────────────────────────────────────────────────────────────────────────────
const _openBlobIdb = (() => {
  let _dbInstance  = null
  let _openPromise = null

  return () => {
    if (_dbInstance)  return Promise.resolve(_dbInstance)
    if (_openPromise) return _openPromise

    _openPromise = new Promise((resolve, reject) => {
      const timeoutId   = setTimeout(() => {
        _openPromise = null
        reject(new Error(`BlobStore IDB open Timeout: ${BLOB_IDB_NAME}`))
      }, IDB_OPEN_TIMEOUT_MS)

      const openRequest = indexedDB.open(BLOB_IDB_NAME, BLOB_IDB_VERSION)

      openRequest.onupgradeneeded = ({ target: { result: db } }) => {
        // Zwei Object Stores: blob-Inhalte und Metadaten getrennt
        if (!db.objectStoreNames.contains(BLOB_STORE_NAME)) db.createObjectStore(BLOB_STORE_NAME)
        if (!db.objectStoreNames.contains(META_STORE_NAME)) db.createObjectStore(META_STORE_NAME)
        /*DEBUG*/ console.info('[QuRay:BlobStore] IDB Schema erstellt:', BLOB_IDB_NAME)
      }

      openRequest.onsuccess = (event) => {
        clearTimeout(timeoutId)
        _dbInstance  = event.target.result
        _openPromise = null

        _dbInstance.onversionchange = () => {
          _dbInstance?.close()
          _dbInstance  = null
          _openPromise = null
        }
        resolve(_dbInstance)
      }

      openRequest.onerror = (event) => {
        clearTimeout(timeoutId)
        _openPromise = null
        reject(event.target.error)
      }
    })

    return _openPromise
  }
})()

// IDB-Transaktion mit Timeout-Guard
const _runBlobIdbTx = async (storeName, mode, operationFn) => {
  const db = await _openBlobIdb()
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`BlobStore IDB Tx Timeout: ${storeName}`))
    }, IDB_TX_TIMEOUT_MS)

    try {
      const tx      = db.transaction(storeName, mode)
      const store   = tx.objectStore(storeName)
      const request = operationFn(store)
      request.onsuccess = (e) => { clearTimeout(timeoutId); resolve(e.target.result ?? null) }
      request.onerror   = (e) => { clearTimeout(timeoutId); reject(e.target.error) }
    } catch (txError) {
      clearTimeout(timeoutId)
      reject(txError)
    }
  })
}


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE OPFS-HILFSKLASSE
// ─────────────────────────────────────────────────────────────────────────────
const _isOpfsAvailable = () =>
  typeof navigator !== 'undefined' &&
  'storage' in navigator &&
  typeof navigator.storage.getDirectory === 'function'

let _opfsRoot = null

const _getOpfsDir = async () => {
  if (_opfsRoot) return _opfsRoot
  const root    = await navigator.storage.getDirectory()
  _opfsRoot     = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: true })
  return _opfsRoot
}

const _writeOpfsBlob = async (blobHash, blobObject) => {
  const dir         = await _getOpfsDir()
  const fileHandle  = await dir.getFileHandle(blobHash, { create: true })
  const writable    = await fileHandle.createWritable()
  await writable.write(blobObject)
  await writable.close()
}

const _readOpfsBlob = async (blobHash) => {
  try {
    const dir        = await _getOpfsDir()
    const fileHandle = await dir.getFileHandle(blobHash)
    return fileHandle.getFile()   // gibt File-Objekt zurück (ist ein Blob)
  } catch {
    return null
  }
}

const _deleteOpfsBlob = async (blobHash) => {
  try {
    const dir = await _getOpfsDir()
    await dir.removeEntry(blobHash)
  } catch { /* nicht vorhanden — kein Fehler */ }
}

const _hasOpfsBlob = async (blobHash) => {
  try {
    const dir = await _getOpfsDir()
    await dir.getFileHandle(blobHash)
    return true
  } catch {
    return false
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// BLOBSTORE FACTORY
//
//   BlobStore(options?) → blobStoreInstance
//
// options.idbThreshold:   Byte-Grenze für IDB vs OPFS, default 1 MB
// options.useOpfs:        true | false | 'auto' (default: 'auto')
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Content-addressed binary storage for files, images, audio and video.
 * Files are stored by their SHA-256 hash (base64url) — identical content
 * is deduplicated automatically. Integrates with QuSync for upload/download.
 *
 * Status lifecycle:  pending → ready (local blob URL available)
 *                    pending → awaiting-user (file exceeds blobAutoLoadLimit)
 *                    pending → error (download failed)
 *
 * @group Blob
 * @since 0.1.0
 *
 * @example
 * // Upload
 * const buf  = await file.arrayBuffer()
 * const hash = await KEY.sha256url(buf)
 * await db.blobs.put(hash, buf, { mime: file.type, name: file.name, size: buf.byteLength })
 *
 * @example
 * // Reactive download
 * const off = db.blobs.on(hash, state => {
 *   if (state?.url) img.src = state.url   // object URL for display
 * })
 * db.blobs.load(hash)  // trigger download
 *
 * @example
 * // Check status
 * const st = db.blobs.status(hash)
 * // { status: 'ready', url: 'blob:...', meta: { mime, name, size } }
 */
const BlobStore = (options = {}) => {
  const _idbThreshold  = options.idbThreshold ?? IDB_SIZE_THRESHOLD_BYTES
  const _opfsEnabled   = options.useOpfs !== false && _isOpfsAvailable()

  // Object-URL Cache: hash → { url, refCount } (für Garbage Collection)
  const _urlCache      = new Map()

  /*DEBUG*/ console.info('[QuRay:BlobStore] init — OPFS:', _opfsEnabled ? 'verfügbar' : 'nicht verfügbar', '| IDB-Threshold:', Math.round(_idbThreshold / 1024) + ' KB')


  // ── Blob/Buffer normalisieren ─────────────────────────────────────────────

  // Alles zu einem Blob normalisieren — einheitlich weiterverarbeiten
  const _toBlob = (blobOrBuffer, mimeType = 'application/octet-stream') => {
    if (blobOrBuffer instanceof Blob)   return blobOrBuffer
    if (blobOrBuffer instanceof ArrayBuffer || ArrayBuffer.isView(blobOrBuffer)) {
      return new Blob([blobOrBuffer], { type: mimeType })
    }
    throw new Error('BlobStore.put: ungültiger Eingabe-Typ — erwartet Blob oder ArrayBuffer')
  }


  // ── Speicherort entscheiden ───────────────────────────────────────────────

  const _chooseStorage = (byteSize) =>
    _opfsEnabled && byteSize >= _idbThreshold
      ? STORAGE_LOCATION.OPFS
      : STORAGE_LOCATION.IDB


  // ── put ───────────────────────────────────────────────────────────────────

  const put = async (blobHash, blobOrBuffer, meta = {}) => {
    const blobObject = _toBlob(blobOrBuffer, meta.mime)

    // MIME ermitteln: übergeben > sniffed > Blob-Type > fallback
    let resolvedMime = meta.mime
    if (!resolvedMime || resolvedMime === 'application/octet-stream') {
      const sniffBuffer  = await blobObject.slice(0, 16).arrayBuffer()
      const sniffedMime  = sniffMimeType(sniffBuffer)
      resolvedMime       = sniffedMime !== 'application/octet-stream' ? sniffedMime
                         : blobObject.type || 'application/octet-stream'
    }

    const byteSize        = blobObject.size
    const storageLocation = _chooseStorage(byteSize)

    const metaRecord = {
      hash:     blobHash,
      mime:     resolvedMime,
      name:     meta.name     ?? '',
      size:     byteSize,
      storage:  storageLocation,
      ts:       Date.now(),
    }

    try {
      if (storageLocation === STORAGE_LOCATION.OPFS) {
        await _writeOpfsBlob(blobHash, blobObject)
        /*DEBUG*/ console.debug('[QuRay:BlobStore] OPFS put:', blobHash.slice(0, 16), Math.round(byteSize / 1024) + ' KB', resolvedMime)
      } else {
        // IDB: natives Blob-Objekt speichern — kein base64!
        await _runBlobIdbTx(BLOB_STORE_NAME, 'readwrite', store => store.put(blobObject, blobHash))
        /*DEBUG*/ console.debug('[QuRay:BlobStore] IDB put:', blobHash.slice(0, 16), Math.round(byteSize / 1024) + ' KB', resolvedMime)
      }

      // Metadaten immer in IDB (kleine JSON-Objekte — kein OPFS nötig)
      await _runBlobIdbTx(META_STORE_NAME, 'readwrite', store => store.put(metaRecord, blobHash))

    } catch (putError) {
      /*DEBUG*/ console.error('[QuRay:BlobStore] put Fehler:', blobHash.slice(0, 16), putError.message)
      throw putError
    }

    return metaRecord
  }


  // ── get ───────────────────────────────────────────────────────────────────

  const get = async (blobHash) => {
    const metaRecord = await getMeta(blobHash)
    if (!metaRecord) return null

    try {
      if (metaRecord.storage === STORAGE_LOCATION.OPFS) {
        return await _readOpfsBlob(blobHash)
      } else {
        return await _runBlobIdbTx(BLOB_STORE_NAME, 'readonly', store => store.get(blobHash))
      }
    } catch (getError) {
      /*DEBUG*/ console.warn('[QuRay:BlobStore] get Fehler:', blobHash.slice(0, 16), getError.message)
      return null
    }
  }


  // ── getUrl — Object URL mit Cache ─────────────────────────────────────────

  // Object URLs werden gecacht und müssen explizit via releaseUrl() freigegeben werden
  // um Memory-Leaks zu verhindern (URL.revokeObjectURL).
  const getUrl = async (blobHash) => {
    // Cache-Hit
    if (_urlCache.has(blobHash)) {
      const cached = _urlCache.get(blobHash)
      cached.refCount++
      return cached.url
    }

    const blobObject = await get(blobHash)
    if (!blobObject) return null

    const objectUrl = URL.createObjectURL(blobObject)
    _urlCache.set(blobHash, { url: objectUrl, refCount: 1 })

    /*DEBUG*/ console.debug('[QuRay:BlobStore] Object URL erstellt:', blobHash.slice(0, 16))
    return objectUrl
  }

  // releaseUrl — Object URL freigeben wenn nicht mehr gebraucht
  const releaseUrl = (blobHash) => {
    const cached = _urlCache.get(blobHash)
    if (!cached) return
    cached.refCount--
    if (cached.refCount <= 0) {
      URL.revokeObjectURL(cached.url)
      _urlCache.delete(blobHash)
      /*DEBUG*/ console.debug('[QuRay:BlobStore] Object URL freigegeben:', blobHash.slice(0, 16))
    }
  }


  // ── getMeta ───────────────────────────────────────────────────────────────

  const getMeta = async (blobHash) => {
    try {
      return await _runBlobIdbTx(META_STORE_NAME, 'readonly', store => store.get(blobHash))
    } catch (metaError) {
      /*DEBUG*/ console.warn('[QuRay:BlobStore] getMeta Fehler:', blobHash.slice(0, 16))
      return null
    }
  }


  // ── del ───────────────────────────────────────────────────────────────────

  const del = async (blobHash) => {
    const metaRecord = await getMeta(blobHash)
    if (!metaRecord) return

    try {
      if (metaRecord.storage === STORAGE_LOCATION.OPFS) {
        await _deleteOpfsBlob(blobHash)
      } else {
        await _runBlobIdbTx(BLOB_STORE_NAME, 'readwrite', store => store.delete(blobHash))
      }
      await _runBlobIdbTx(META_STORE_NAME, 'readwrite', store => store.delete(blobHash))

      // Object URL freigeben falls vorhanden
      if (_urlCache.has(blobHash)) {
        URL.revokeObjectURL(_urlCache.get(blobHash).url)
        _urlCache.delete(blobHash)
      }

      /*DEBUG*/ console.debug('[QuRay:BlobStore] gelöscht:', blobHash.slice(0, 16))
    } catch (delError) {
      /*DEBUG*/ console.warn('[QuRay:BlobStore] del Fehler:', blobHash.slice(0, 16), delError.message)
    }
  }


  // ── has ───────────────────────────────────────────────────────────────────

  const has = async (blobHash) => {
    const metaRecord = await getMeta(blobHash)
    if (!metaRecord) return false

    // Existenz im tatsächlichen Storage prüfen
    if (metaRecord.storage === STORAGE_LOCATION.OPFS) {
      return _hasOpfsBlob(blobHash)
    } else {
      const blobResult = await _runBlobIdbTx(BLOB_STORE_NAME, 'readonly', store => store.get(blobHash))
        .catch(() => null)
      return blobResult != null
    }
  }


  // ── list ──────────────────────────────────────────────────────────────────

  const list = async () => {
    const db = await _openBlobIdb().catch(() => null)
    if (!db) return []

    return new Promise((resolve, reject) => {
      const results   = []
      const timeoutId = setTimeout(() => resolve(results), IDB_TX_TIMEOUT_MS)

      try {
        const request = db.transaction(META_STORE_NAME, 'readonly')
          .objectStore(META_STORE_NAME)
          .openCursor()

        request.onsuccess = (event) => {
          const cursor = event.target.result
          if (cursor) {
            results.push({ hash: cursor.key, meta: cursor.value })
            cursor.continue()
          } else {
            clearTimeout(timeoutId)
            resolve(results)
          }
        }
        request.onerror = (event) => { clearTimeout(timeoutId); reject(event.target.error) }
      } catch (listError) {
        clearTimeout(timeoutId)
        reject(listError)
      }
    })
  }


  // ── clear ─────────────────────────────────────────────────────────────────

  const clear = async () => {
    // Object URLs freigeben
    for (const [, cached] of _urlCache) URL.revokeObjectURL(cached.url)
    _urlCache.clear()

    try {
      await _runBlobIdbTx(BLOB_STORE_NAME, 'readwrite', store => store.clear())
      await _runBlobIdbTx(META_STORE_NAME, 'readwrite', store => store.clear())
    } catch (clearError) {
      /*DEBUG*/ console.warn('[QuRay:BlobStore] clear Fehler:', clearError.message)
    }

    if (_opfsEnabled) {
      try {
        const dir = await _getOpfsDir()
        // OPFS: alle Einträge im Verzeichnis löschen
        for await (const [name] of dir.entries()) {
          await dir.removeEntry(name).catch(() => {})
        }
      } catch (opfsClearError) {
        /*DEBUG*/ console.warn('[QuRay:BlobStore] OPFS clear Fehler:', opfsClearError.message)
      }
    }

    /*DEBUG*/ console.info('[QuRay:BlobStore] clear: alles gelöscht')
  }


  // ── Speicherplatz-Info ────────────────────────────────────────────────────

  const getStorageInfo = async () => {
    const allMeta   = await list()
    const totalSize = allMeta.reduce((sum, { meta }) => sum + (meta.size ?? 0), 0)
    const opfsCount = allMeta.filter(({ meta }) => meta.storage === STORAGE_LOCATION.OPFS).length
    const idbCount  = allMeta.filter(({ meta }) => meta.storage === STORAGE_LOCATION.IDB).length

    let quotaInfo = null
    if (navigator.storage?.estimate) {
      quotaInfo = await navigator.storage.estimate().catch(() => null)
    }

    return {
      totalBlobs:  allMeta.length,
      totalBytes:  totalSize,
      opfsBlobs:   opfsCount,
      idbBlobs:    idbCount,
      quota:       quotaInfo,
    }
  }


  return {
    put,
    get,
    getUrl,
    releaseUrl,
    getMeta,
    del,
    has,
    list,
    clear,
    getStorageInfo,
    sniffMimeType,

    get opfsEnabled() { return _opfsEnabled },
    get idbThreshold() { return _idbThreshold },

    STORAGE_LOCATION,
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export { BlobStore, sniffMimeType, IDB_SIZE_THRESHOLD_BYTES, STORAGE_LOCATION }
