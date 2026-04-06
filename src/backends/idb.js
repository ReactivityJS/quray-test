// ════════════════════════════════════════════════════════════════════════════
// QuRay — backends/idb.js
// IndexedDB Storage-Backend.
//
// Android-Timeout-Guards:
//   IDB-open und IDB-Transaktionen können auf Android Chrome unter Last
//   still hängen — bekannter Browser-Bug. Beide Operationen haben
//   konfigurierbare Timeouts mit sauberem Fehler statt Deadlock.
//
// Cursor-basierte query():
//   Nutzt IDBKeyRange.bound() für effiziente Prefix-Suche —
//   kein vollständiger Tabellen-Scan bei großen Datenmengen.
//
// Backend-Interface (alle Backends implementieren exakt dieses):
//   get(key)          → Promise<value | null>
//   set(key, value)   → Promise<void>
//   del(key)          → Promise<void>
//   query(prefix)     → Promise<[{ key, val }, ...]>  sortiert aufsteigend
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// IDB BACKEND FACTORY
//
//   IdbBackend(options?) → backendInstance
//
// options.name:        IDB-Datenbankname, default 'quray-data'
// options.version:     IDB-Schema-Version, default 1
// options.openTimeout: ms bis Timeout bei db-open, default 8_000
// options.txTimeout:   ms bis Timeout bei Transaktion, default 10_000
// ─────────────────────────────────────────────────────────────────────────────
/**
 * IndexedDB storage backend. Used by QuRay for persistent browser storage.
 * Automatically creates and migrates the IDB schema.
 *
 * @param {object} [options]
 * @param {string} [options.name='quray-data'] - IDB database name
 * @param {number} [options.openTimeout=8000] - Open timeout in ms
 * @param {number} [options.txTimeout=10000] - Transaction timeout in ms
 * @returns {Backend} - { get, set, del, scan, close }
 * @group Backend
 * @since 0.1.0
 *
 * @example
 * // Automatic via QuRay.init() — one IDB per identity pub key.
 * // Manual:
 * import { IdbBackend } from './dist/quray-core.js'
 * const idb = IdbBackend({ name: 'my-app-data' })
 */
const IdbBackend = (options = {}) => {
  const _dbName        = options.name        ?? 'quray-data'
  const _dbVersion     = options.version     ?? 1
  const _openTimeoutMs = options.openTimeout ?? 8_000
  const _txTimeoutMs   = options.txTimeout   ?? 10_000

  let _dbInstance = null    // gecachte IDB-Instanz
  let _openPromise = null   // verhindert parallele open()-Aufrufe


  // ── IDB öffnen ────────────────────────────────────────────────────────────

  const _openDatabase = () => {
    // Bereits geöffnet
    if (_dbInstance) return Promise.resolve(_dbInstance)

    // Bereits am Öffnen — denselben Promise zurückgeben
    if (_openPromise) return _openPromise

    _openPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        _openPromise = null
        reject(new Error(`IDB open Timeout nach ${_openTimeoutMs}ms: ${_dbName}`))
      }, _openTimeoutMs)

      const openRequest = indexedDB.open(_dbName, _dbVersion)

      openRequest.onupgradeneeded = ({ target: { result: freshDb } }) => {
        if (!freshDb.objectStoreNames.contains('kv')) {
          freshDb.createObjectStore('kv')
        }
        /*DEBUG*/ console.info('[QuRay:IdbBackend] Schema erstellt:', _dbName)
      }

      openRequest.onsuccess = (successEvent) => {
        clearTimeout(timeoutId)
        _dbInstance  = successEvent.target.result
        _openPromise = null

        // Verbindungsabbruch durch Browser (z.B. bei versionchange)
        _dbInstance.onversionchange = () => {
          _dbInstance?.close()
          _dbInstance  = null
          _openPromise = null
          /*DEBUG*/ console.warn('[QuRay:IdbBackend] IDB versionchange — Verbindung getrennt:', _dbName)
        }

        /*DEBUG*/ console.info('[QuRay:IdbBackend] Geöffnet:', _dbName)
        resolve(_dbInstance)
      }

      openRequest.onerror = (errorEvent) => {
        clearTimeout(timeoutId)
        _openPromise = null
        const idbError = errorEvent.target.error
        /*DEBUG*/ console.error('[QuRay:IdbBackend] open Fehler:', _dbName, idbError)
        reject(idbError)
      }

      openRequest.onblocked = () => {
        /*DEBUG*/ console.warn('[QuRay:IdbBackend] open blockiert — anderer Tab hält Verbindung:', _dbName)
        // Nicht sofort ablehnen — warten bis der andere Tab schließt
      }
    })

    return _openPromise
  }


  // ── Transaktions-Hilfsfunktion ────────────────────────────────────────────

  // _runInTransaction: führt eine Funktion in einer IDB-Transaktion aus
  // mit Timeout-Guard gegen Android-Hänger.
  //
  // fn(objectStore) → IDBRequest
  // Gibt Promise<result> zurück
  const _runInTransaction = async (transactionMode, operationFn) => {
    const db = await _openDatabase()

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`IDB Transaktion Timeout nach ${_txTimeoutMs}ms: ${_dbName}`))
      }, _txTimeoutMs)

      let idbRequest
      try {
        const transaction  = db.transaction('kv', transactionMode)
        const objectStore  = transaction.objectStore('kv')
        idbRequest         = operationFn(objectStore)
      } catch (transactionCreateError) {
        clearTimeout(timeoutId)
        // IDB-Verbindung möglicherweise ungültig — Cache leeren für nächsten Versuch
        _dbInstance  = null
        _openPromise = null
        reject(transactionCreateError)
        return
      }

      idbRequest.onsuccess = (successEvent) => {
        clearTimeout(timeoutId)
        resolve(successEvent.target.result ?? null)
      }

      idbRequest.onerror = (errorEvent) => {
        clearTimeout(timeoutId)
        reject(errorEvent.target.error)
      }
    })
  }


  // ── Backend-Interface ─────────────────────────────────────────────────────

  const get = async (keyString) => {
    try {
      const result = await _runInTransaction('readonly', store => store.get(keyString))
      return result ?? null
    } catch (getError) {
      /*DEBUG*/ console.warn('[QuRay:IdbBackend] get Fehler:', keyString, getError.message)
      return null   // Fehler → null zurückgeben statt werfen (Lesefehler sind tolerierbar)
    }
  }

  const set = async (keyString, value) => {
    try {
      await _runInTransaction('readwrite', store => store.put(value, keyString))
    } catch (setError) {
      /*DEBUG*/ console.error('[QuRay:IdbBackend] set Fehler:', keyString, setError.message)
      throw setError
    }
  }


  const del = async (keyString) => {
    try {
      await _runInTransaction('readwrite', store => store.delete(keyString))
    } catch (deleteError) {
      /*DEBUG*/ console.warn('[QuRay:IdbBackend] del Fehler:', keyString, deleteError.message)
    }
  }

  // query: alle Keys die mit prefix beginnen, sortiert aufsteigend
  // Nutzt Cursor mit IDBKeyRange für Effizienz — kein Full-Table-Scan
  const query = async (prefixString) => {
    const db = await _openDatabase().catch(openError => {
      /*DEBUG*/ console.warn('[QuRay:IdbBackend] query: DB nicht verfügbar:', openError.message)
      return null
    })
    if (!db) return []

    return new Promise((resolve, reject) => {
      const results   = []
      const timeoutId = setTimeout(() => {
        /*DEBUG*/ console.warn('[QuRay:IdbBackend] query Timeout — leeres Ergebnis zurückgegeben')
        resolve(results)   // Timeout → leeres Ergebnis statt Deadlock
      }, _txTimeoutMs)

      try {
        // IDBKeyRange.bound: von prefix bis prefix + höchstes Unicode-Zeichen
        // \uffff matcht alle möglichen Zeichen nach dem Prefix
        const keyRange   = prefixString
          ? IDBKeyRange.bound(prefixString, prefixString + '\uffff')
          : undefined   // kein Prefix → alle Keys

        const transaction = db.transaction('kv', 'readonly')
        const cursorRequest = transaction.objectStore('kv').openCursor(keyRange)

        cursorRequest.onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result
          if (cursor) {
            results.push({ key: cursor.key, val: cursor.value })
            cursor.continue()
          } else {
            clearTimeout(timeoutId)
            resolve(results)   // kein weiterer Cursor → fertig
          }
        }

        cursorRequest.onerror = (errorEvent) => {
          clearTimeout(timeoutId)
          reject(errorEvent.target.error)
        }

      } catch (queryError) {
        clearTimeout(timeoutId)
        _dbInstance  = null   // IDB-Cache leeren bei Transaktion-Fehler
        _openPromise = null
        reject(queryError)
      }
    })
  }

  // close: IDB-Verbindung manuell schließen (z.B. bei Identitätswechsel)
  const close = () => {
    if (_dbInstance) {
      _dbInstance.close()
      _dbInstance  = null
      _openPromise = null
      /*DEBUG*/ console.info('[QuRay:IdbBackend] Verbindung geschlossen:', _dbName)
    }
  }


  return {
    name: 'idb',
    get,
    set,
    del,
    query,
    close,
    get dbName() { return _dbName },
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export { IdbBackend }
