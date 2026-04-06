// ════════════════════════════════════════════════════════════════════════════
// QuRay — core/db.js
// Reactive storage core with mount-based backend routing, middleware pipelines
// and explicit event scopes for data, blobs and delivery state.
//
// Mount routing rules:
//   '~'     → all user-space keys   (~pub64/...)
//   '@'     → all shared-space keys (@spaceId/...)
//   '>'     → all inbox keys        (>pub64/...)
//   'sys/'  → ephemeral runtime keys
//   'conf/' → local configuration keys
//   'blobs/'→ binary content-addressed blob storage
//
// The longest matching mount prefix wins.
// Debug output is marked with /*DEBUG*/ so production builds can strip it.
// ════════════════════════════════════════════════════════════════════════════

import { Hook, EventBus, runMiddleware, PrioStack } from './events.js'
import { createQuBit, isValidQuBit, isDeletedQuBit, KEY }           from './qubit.js'
import { DeliveryTracker, DELIVERY_STATE }           from './delivery.js'
import { isLocalOnly, isHardDelete, LOCAL_ONLY_RE }  from './mounts.js'


// ─────────────────────────────────────────────────────────────────────────────
// BLOB-STATUS-ENUM
// ─────────────────────────────────────────────────────────────────────────────

const BLOB_STATUS = {
  READY:         'ready',          // Available locally and backed by an object URL.
  PENDING:       'pending',        // Download in progress or still waiting to start.
  AWAITING_USER: 'awaiting-user',  // Larger than blobAutoLoadLimit, waits for explicit user action.
  ERROR:         'error',          // Download or restore failed.
}


// ─────────────────────────────────────────────────────────────────────────────
// QUDB FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Core reactive database. Routes keys to backends, runs middleware pipeline,
 * fires reactive listeners on every write. Works offline — no relay required.
 *
 * Key prefixes determine which backend stores the data:
 *   ~{pub}/   → IDB (user-space, signed, synced)
 *   @{id}/    → IDB (app-space / spaces, synced)
 *   >{pub}/   → IDB (inbox, synced)
 *   sys/      → Memory (ephemeral, never persisted)
 *   conf/     → LocalStorage (config, never synced)
 *   blobs/    → IDB blob store (binary content)
 *
 * @param {object} config
 * @param {object} config.backends - Map of prefix → Backend
 * @param {object} [config.identity] - Identity for signing
 * @returns {QuDBInstance} - { put, get, del, query, on, use, delivery, blobs }
 * @group Database
 * @since 0.1.0
 *
 * @example
 * // Standard usage — via QuRay.init():
 * const { db } = await QuRay.init({ relay: 'wss://...' })
 *
 * @example
 * // Manual / test usage with memory backends + plugins:
 * import { QuDB } from './src/core/db.js'
 * import { MemoryBackend } from './src/backends/memory.js'
 * import { StoreOutPlugin, StoreInPlugin } from './src/plugins/store.js'
 * import { DispatchPlugin } from './src/plugins/dispatch.js'
 * const db = QuDB({ backends: {
 *   '~': MemoryBackend(), '@': MemoryBackend(), '>': MemoryBackend(),
 *   'sys/': MemoryBackend(), 'conf/': MemoryBackend(), 'blobs/': MemoryBackend(),
 * }})
 * db.use(StoreOutPlugin())
 * db.use(StoreInPlugin())
 * db.use(DispatchPlugin())
 * await db.init()
 * await db.put('~pub/test', 'hello')
 * const q = await db.get('~pub/test')
 * console.log(q?.data)  // 'hello'
 */
const QuDB = (config = {}) => {
  const _backends          = new Map()   // prefix -> adapter, sorted by longest prefix first
  const _blobStatusMap     = new Map()   // hash -> { status, url, meta }
  const _blobWaiters       = new Map()   // hash -> [callbackFn, ...]
  const _blobAutoLoadLimit = config.blobAutoLoadLimit ?? 512 * 1024

  const _changeEventBus = EventBus({ separator: '/' })
  const _inPipeline     = Hook(runMiddleware, PrioStack())
  const _outPipeline    = Hook(runMiddleware, PrioStack())
  const _queue          = config.queue ?? null


  // ── Backend-Management ───────────────────────────────────────────────────

  const mountBackend = (prefixString, adapterInstance) => {
    _backends.set(prefixString, adapterInstance)
    // Sort longer prefixes first so the most specific mount always wins.
    const sorted = [..._backends.entries()].sort(([a], [b]) => b.length - a.length)
    _backends.clear()
    for (const [p, a] of sorted) _backends.set(p, a)
    /*DEBUG*/ console.debug('[QuRay:QuDB] mounted backend:', prefixString)
  }

  // Resolve the adapter responsible for a storage key.
  // Sigil prefixes (~, @, >) and path prefixes (sys/, conf/, blobs/) all use
  // startsWith(prefix) matching because mounts are already sorted by length.
  const _resolveBackend = (keyString) => {
    if (!keyString) return null   // guard: empty/undefined key → silent null
    for (const [prefix, adapter] of _backends) {
      if (keyString.startsWith(prefix)) return adapter
    }
    if (keyString) /*DEBUG*/ console.warn('[QuRay:QuDB] no backend mounted for key:', keyString)
    return null
  }

  // Remove the matched mount prefix before forwarding a key to a backend.
  // Example: '~pub64/alias' with mount '~' becomes 'pub64/alias'.
  const _stripPrefix = (keyString) => {
    for (const [prefix] of _backends) {
      if (keyString.startsWith(prefix)) return keyString.slice(prefix.length)
    }
    return keyString
  }

  const _mountPrefix = (keyString) => {
    for (const [prefix] of _backends) {
      if (keyString.startsWith(prefix)) return prefix
    }
    return ''
  }


  // ── Change-Events ────────────────────────────────────────────────────────

  const _fireChange = (keyString, qubitOrNull, event = 'put', source = 'local') =>
    _changeEventBus.emit(keyString, qubitOrNull, { event, key: keyString, source })

  const _blobPattern = (patternString) =>
    patternString?.startsWith('blobs/') ? patternString : 'blobs/' + patternString

  const _eventMeta = (scopeString, currentValue, metaObject = {}) => ({
    ...metaObject,
    scope: scopeString,
    current: metaObject.current ?? currentValue ?? null,
    previous: metaObject.previous ?? null,
    value: scopeString === 'data'
      ? (metaObject.current ?? currentValue)?.data
      : (metaObject.current ?? currentValue),
    oldValue: scopeString === 'data'
      ? (metaObject.previous ? metaObject.previous.data : null)
      : (metaObject.previous ?? null),
    changed: (metaObject.current ?? currentValue) !== (metaObject.previous ?? null),
  })

  const _callAdapter = async (operationFn, fallbackValue, onError) => {
    try {
      return await Promise.resolve().then(operationFn)
    } catch (error) {
      onError?.(error)
      return fallbackValue
    }
  }


  // ── Core-Storage ─────────────────────────────────────────────────────────

  /**
   * Read the latest QuBit for the given key.
   * @param {string} keyString - Storage key
   * @param {object} [options]
   * @returns {Promise<QuBit|null>} QuBit with fields { id, key, type, from, ts, data, sig } or null
   * @group Database
   * @since 0.1.0
   * @example
   * const q = await db.get('~' + me.pub + '/alias')
   * console.log(q?.data, q?.ts, q?.from)
   */
  const get = async (keyString, options = {}) => {
    const { decrypt = false, resolve = false, resolveDepth = 1, includeDeleted = false } = options
    const adapter = _resolveBackend(keyString)
    if (!adapter) return null

    let qubit = await _callAdapter(
      () => adapter.get(_stripPrefix(keyString)),
      null,
      (error) => { /*DEBUG*/ console.warn('[QuRay:QuDB] get failed:', keyString, error?.message ?? error) }
    )

    if (!qubit) return null
    if (isDeletedQuBit(qubit) && !includeDeleted) return null

    if (decrypt && qubit.enc && config.identity) {
      try {
        const plain = await config.identity.decrypt(qubit.data)
        qubit = { ...qubit, data: JSON.parse(plain) }
      } catch (err) {
        /*DEBUG*/ console.warn('[QuRay:QuDB] decrypt failed:', keyString, err)
      }
    }

    if (resolve && qubit.refs?.length > 0 && resolveDepth > 0) {
      qubit = await _resolveRefs(qubit, resolveDepth)
    }

    return qubit
  }

  /**
   * Scan all keys matching the given prefix. Returns QuBits sorted by key (default)
   * or by a field when order option is given.
   *
   * @param {string} prefixString - Key prefix to scan (e.g. '@space/chat/')
   * @param {object} [options]
   * @param {string} [options.order] - Sort field: 'ts' | 'key' | 'data.{field}'
   * @param {'asc'|'desc'} [options.dir='asc'] - Sort direction
   * @param {number} [options.limit] - Maximum number of results
   * @param {boolean} [options.includeDeleted=false] - Include soft-deleted items
   * @returns {Promise<QuBit[]>}
   * @group Database
   * @since 0.1.0
   *
   * @example
   * const msgs = await db.query('@space/chat/', { order: 'ts', limit: 100 })
   * const users = await db.query('~', { order: 'ts', dir: 'desc' })
   */
  const query = async (prefixString, options = {}) => {
    const { order = 'ts', limit, filter, since, includeDeleted = false } = options
    const adapter = _resolveBackend(prefixString)
    if (!adapter) return []

    const stripped  = _stripPrefix(prefixString)

    const rawResults = await _callAdapter(
      () => adapter.query(stripped),
      [],
      (error) => { /*DEBUG*/ console.warn('[QuRay:QuDB] query error:', prefixString, error?.message ?? error) }
    )

    let qubits = rawResults
      .map(({ val }) => val)
      .filter(isValidQuBit)
      .filter((qubit) => includeDeleted || !isDeletedQuBit(qubit))
      // KEY FIX: filter by full qubit.key prefix to avoid cross-sigil contamination
      // (~, @, > all share the same IDB — stripping removes the sigil, so adapter.query('')
      // returns everything; we must re-filter on the original full key.
      .filter(q => {
        if (!prefixString) return true
        if (q.key === prefixString) return true
        if (prefixString.endsWith('/')) return q.key.startsWith(prefixString)
        // Single-char sigil prefix like '~', '@', '>' — match keys starting with that sigil
        if (prefixString.length === 1) return q.key.startsWith(prefixString)
        // Otherwise require trailing slash for path prefix
        return q.key.startsWith(prefixString + '/')
      })

    if (since)  qubits = qubits.filter(q => q.ts > since)
    if (filter) qubits = qubits.filter(filter)

    qubits = _sort(qubits, order)
    if (limit) qubits = qubits.slice(0, limit)

    return qubits
  }

  /**
   * Store a value at the given key. Runs through the full middleware pipeline:
   * sign → store → dispatch (fires db.on() listeners) → sync queue.
   *
   * @param {string} keyString - Storage key (e.g. '~pub/alias', '@space/chat/001')
   * @param {*} dataPayload - Any JSON-serialisable value
   * @param {object} [options]
   * @param {string} [options.type='data'] - QuBit type
   * @param {boolean|string} [options.sync=true] - Sync mode ('lazy', false, true)
   * @param {string} [options.enc] - Encryption target (epub of recipient)
   * @returns {Promise<void>}
   * @group Database
   * @since 0.1.0
   *
   * @example
   * await db.put('~' + me.pub + '/alias', 'Alice')
   * await db.put('@space/chat/001', { text: 'Hello!', pub: me.pub })
   * await db.put('@space/file', data, { type: 'blob.meta', sync: 'lazy' })
   */
  const put = async (keyString, dataPayload, options = {}) => {
    const {
      type   = 'data',
      sync   = true,
      enc    = null,
      refs   = [],
      order  = null,
      from   = config.identity?.pub ?? '',
      deleted = false,
    } = options

    const qubit = createQuBit({ key: keyString, from, type, data: dataPayload, enc, refs, order, deleted })

    await _outPipeline.run({ qubit, key: keyString, syncMode: sync, encTarget: enc, netPacket: null })
  }

  /**
   * Delete a key. Syncable mounts use signed tombstones by default so deletions
   * can propagate to relays and other peers. Local-only mounts still hard-delete.
   *
   * @param {string} keyString - Storage key to delete
   * @returns {Promise<void>}
   * @group Database
   * @since 0.1.0
   *
   * @example
   * await db.del('~' + me.pub + '/draft')
   */
  const del = async (keyString, options = {}) => {
    const adapter = _resolveBackend(keyString)
    if (!adapter) return

    const {
      hard = false,
      sync = true,
      reason = null,
      from = config.identity?.pub ?? '',
    } = options

    const previousQuBit = await _callAdapter(
      () => adapter.get(_stripPrefix(keyString)),
      null,
      (error) => { /*DEBUG*/ console.warn('[QuRay:QuDB] del pre-read error:', keyString, error?.message ?? error) }
    )

    const usesLocalOnlyMount = isLocalOnly(keyString)
    const shouldHardDelete = hard || usesLocalOnlyMount

    if (!previousQuBit && shouldHardDelete) return

    if (shouldHardDelete) {
      await _callAdapter(
        () => adapter.del(_stripPrefix(keyString)),
        undefined,
        (error) => { /*DEBUG*/ console.warn('[QuRay:QuDB] del error:', keyString, error?.message ?? error) }
      )

      await _changeEventBus.emit(keyString, null, {
        event: 'del',
        key: keyString,
        source: 'local',
        previous: previousQuBit,
        current: null,
      })
      /*DEBUG*/ console.debug('[QuRay:QuDB] hard delete:', keyString)
      return
    }

    const tombstoneValue = {
      deleted: true,
      deletedBy: from || null,
      deletedTs: Date.now(),
      reason,
    }

    await put(keyString, tombstoneValue, {
      sync,
      from,
      deleted: true,
      type: previousQuBit?.type ?? 'data',
      enc: previousQuBit?.enc ?? null,
      refs: previousQuBit?.refs ?? [],
      order: previousQuBit?.order ?? null,
    })

    /*DEBUG*/ console.debug('[QuRay:QuDB] tombstone delete:', keyString)
  }

  // rawWrite — direkt schreiben ohne Pipeline (nur für Middleware-Plugins).
  // Schreibt direkt ins Backend ohne Events zu feuern.
  // Events sind ausschließlich Sache der DispatchPlugins (IN/OUT).
  // Callers:
  //   StoreOutPlugin('local') — lokaler Put, DispatchOut feuert Event
  //   StoreInPlugin('sync')   — eingehende Relay-Daten, DispatchIn feuert Event
  //   sync.js status update   — reine Status-Änderung, kein Event nötig
  const rawWrite = async (keyString, qubitValue, _source = 'sync') => {
    const adapter = _resolveBackend(keyString)
    if (!adapter) return

    try {
      const result = adapter.set(_stripPrefix(keyString), qubitValue)
      // adapter.set may be sync (FsBackend) or async (IDBBackend) — handle both
      if (result && typeof result.catch === 'function') await result
    } catch (err) {
      /*DEBUG*/ console.error('[QuRay:QuDB] rawWrite Fehler:', keyString, err)
    }
  }


  // ── Blobs ────────────────────────────────────────────────────────────────

  const putBlob = async (blobHash, blobBuffer, metaObject, options = {}) => {
    const { sync = true, enc = null } = options
    const blobBackend = _resolveBackend('blobs/')
    if (!blobBackend) {
      /*DEBUG*/ console.error('[QuRay:QuDB] putBlob: missing blobs/ backend')
      return
    }

    await _callAdapter(
      () => blobBackend.set(blobHash, blobBuffer),
      undefined,
      (error) => { /*DEBUG*/ console.error('[QuRay:QuDB] putBlob error:', blobHash, error?.message ?? error) }
    )

    const objectUrl = URL.createObjectURL(new Blob([blobBuffer], { type: metaObject.mime }))
    _blobStatusMap.set(blobHash, { status: BLOB_STATUS.READY, url: objectUrl, meta: metaObject })

    if (config.identity) {
      const metaKey = KEY.user(config.identity.pub).blob(blobHash)
      await put(metaKey, { ...metaObject, hash: blobHash }, { type: 'blob.meta', sync, enc })
      // Blob bytes now in local IDB
      _getDelivery()?.set(metaKey, 'blob_local').catch(() => {})
    }

    // Enqueue upload to relay (persistent queue → retried on reconnect)
    if (sync !== false && _queue) {
      await _queue.enqueue('blob.upload', { hash: blobHash, mime: metaObject.mime, name: metaObject.name }, {
        dedupKey: 'blobup-' + blobHash,
        persistent: true,
      })
      if (config.identity) {
        const metaKey = KEY.user(config.identity.pub).blob(blobHash)
        _getDelivery()?.set(metaKey, 'queued').catch(() => {})
      }
    }

    _notifyBlobWaiters(blobHash, objectUrl, metaObject)
    /*DEBUG*/ console.debug('[QuRay:QuDB] putBlob:', blobHash.slice(0, 16) + '…', metaObject.mime)
  }

  // _hydrateUrl: create Object URL from IDB for blobs restored without URL
  const _hydrateUrl = async (blobHash, currentEntry) => {
    if (currentEntry?.url) return  // already has URL
    const blobBackend = _resolveBackend('blobs/')
    if (!blobBackend) return
    try {
      const buffer = await _callAdapter(() => blobBackend.get(blobHash), null)
      if (!buffer) return
      const mime = currentEntry?.meta?.mime ?? ''
      const url  = URL.createObjectURL(new Blob([buffer], { type: mime }))
      const meta = currentEntry?.meta ?? {}
      await _setBlobStatus(blobHash, BLOB_STATUS.READY, url, meta)
    } catch(e) {
      /*DEBUG*/ console.warn('[QuRay:QuDB] hydrateUrl error:', blobHash.slice(0,12), e.message)
    }
  }

  const getBlob = (blobHash) => {
    const entry = _blobStatusMap.get(blobHash)
    if (!entry) return null
    // Lazily create Object URL if blob is READY but URL wasn't created yet (e.g. after reload)
    if (entry.status === BLOB_STATUS.READY && !entry.url) {
      _hydrateUrl(blobHash, entry)  // async, fires onBlob when done
    }
    return { ...entry }
  }

  const onBlob = (blobHash, callbackFn) => {
    const entry = _blobStatusMap.get(blobHash)

    // Already have a terminal state — fire immediately and return off()
    if (entry?.status === BLOB_STATUS.READY) {
      try { callbackFn(entry) } catch(e) {}
      return () => {}
    }
    if (entry?.status === BLOB_STATUS.ERROR) {
      try { callbackFn(entry) } catch(e) {}
      return () => {}
    }

    // Fire with current state immediately so UI can show PENDING spinner
    if (entry) {
      try { callbackFn(entry) } catch(e) {}
    }

    // Register for future state changes
    if (!_blobWaiters.has(blobHash)) _blobWaiters.set(blobHash, [])
    _blobWaiters.get(blobHash).push(callbackFn)

    return () => {
      const list = _blobWaiters.get(blobHash)
      if (list) {
        const i = list.indexOf(callbackFn)
        if (i >= 0) list.splice(i, 1)
      }
    }
  }

  const loadBlob = (blobHash, metaHint = {}) => {
    const entry = _blobStatusMap.get(blobHash)
    // Allow load() for: AWAITING_USER (user confirmed) or null/unknown (explicit request)
    // Do NOT re-download if already READY, PENDING, or ERROR
    const status = entry?.status
    if (status === BLOB_STATUS.PENDING) return
    if (status === BLOB_STATUS.READY) {
      // If READY but no URL yet (restored from IDB without Object URL), hydrate
      if (!entry?.url) _hydrateUrl(blobHash, entry)
      return
    }

    const meta = entry?.meta ?? metaHint
    _blobStatusMap.set(blobHash, { status: BLOB_STATUS.PENDING, url: null, meta })
    _changeEventBus.emit('blobs/' + blobHash, _blobStatusMap.get(blobHash), { event: 'blob-status' })

    if (_queue) _queue.enqueue('blob.download', { hash: blobHash, ...meta }, { dedupKey: 'blob-' + blobHash })
  }

  const _setBlobStatus = async (blobHash, statusString, urlOrNull, metaObject) => {
    const previousEntry = _blobStatusMap.get(blobHash) ?? null
    const entry = { status: statusString, url: urlOrNull, meta: metaObject }
    _blobStatusMap.set(blobHash, entry)
    // Fire EventBus (db.on('blobs/hash') listeners — catches ALL status changes)
    await _changeEventBus.emit('blobs/' + blobHash, entry, {
      event: 'blob-status',
      key: 'blobs/' + blobHash,
      scope: 'blob',
      current: entry,
      previous: previousEntry,
    })
    // Fire all registered onBlob() watchers on EVERY status change
    // (previously only fired on READY — this prevented PENDING/ERROR from reaching UI)
    const waiters = _blobWaiters.get(blobHash)
    if (waiters?.length) {
      waiters.forEach(fn => { try { fn(entry) } catch(e) { /*DEBUG*/ } })
      if (statusString === BLOB_STATUS.READY || statusString === BLOB_STATUS.ERROR) {
        _blobWaiters.delete(blobHash)  // auto-cleanup on terminal states
      }
    }
  }

  const _notifyBlobWaiters = (blobHash, urlString, metaObject) => {
    const waiters = _blobWaiters.get(blobHash)
    if (!waiters?.length) return
    const payload = { status: BLOB_STATUS.READY, url: urlString, meta: metaObject }
    for (const cb of waiters) {
      try { cb(payload) } catch (e) {
      /*DEBUG*/ console.warn('[QuRay:QuDB] Blob-Waiter Fehler:', e)
    }
    }
    _blobWaiters.delete(blobHash)
  }


  // ── Reactive listeners ───────────────────────────────────────────────────

  /**
   * Subscribe to reactive changes matching a key pattern.
   * Fires on every db.put() or incoming sync for matching keys.
   * Returns an off() function — always call it to avoid memory leaks.
   *
   * Pattern syntax (EventBus separator: '/'):
   *   '~pub/alias'        exact key
   *   '~pub/**'           all keys under ~pub/ (recursive, requires known pub)
   *   '@space/chat/*'     one level wildcard under @space/chat/
   *   '**'                all keys
   *
   * ⚠️  SIGIL GOTCHA: The sigils (~, @, >) are KEY PREFIXES, not path separators.
   *   '~pub64'  is ONE segment  →  '~**' will NOT match '~pub/alias'
   *   Correct patterns for "all user-space keys":
   *     '**'  combined with a prefix check in the callback, or
   *     `~${me.pub64}/**`  for the own user space.
   *   Example:
   *     db.on('**', (q, { key }) => { if (key?.startsWith('~')) handleUserKey(key) })
   *
   * @param {string} patternString - Key pattern with optional * and ** wildcards
   * @param {function} callbackFn - Called with (QuBit|null, { key, event, source })
   * @returns {function} off - Call to unsubscribe
   * @group Database
   * @since 0.1.0
   *
   * @example
   * const off = db.on('~' + me.pub + '/**', (q, ctx) => {
   *   console.log(ctx.key, q?.data)
   * })
   * // later:
   * off()
   *
   * @example
   * // Watch ALL user-space keys (correct: use ** + prefix filter)
   * db.on('**', (q, { key }) => {
   *   if (key?.startsWith('~')) handleAnyUserKey(key)
   * })
   *
   * @example
   * // In a Custom Element:
   * this._offFns.push(db.on('@space/chat/**', q => this._render(q)))
   */
  const on = (patternString, callbackFn, options = {}) => {
    const {
      scope = 'data',
      once = false,
      immediate = true,
    } = options

    if (scope === 'blob') {
      const pattern = _blobPattern(patternString)
      const matcher = _changeEventBus.match
      let active = true
      const offFn = _changeEventBus.on(pattern, (entry, meta = {}) => {
        if (!active) return
        const eventMeta = _eventMeta('blob', entry, meta)
        try { callbackFn(entry, eventMeta) } finally {
          if (once) stop()
        }
      })

      if (immediate && !pattern.includes('*')) {
        const hash = pattern.replace(/^blobs\//, '')
        const current = getBlob(hash)
        if (current) {
          try {
            callbackFn(current, _eventMeta('blob', current, {
              event: 'blob-status',
              key: pattern,
              current,
              previous: null,
              replay: true,
            }))
          } catch {}
          if (once) {
            active = false
            offFn()
            return () => {}
          }
        }
      } else if (immediate && pattern === 'blobs/**') {
        for (const [hash, current] of _blobStatusMap.entries()) {
          if (!active || !matcher(pattern, 'blobs/' + hash)) continue
          try {
            callbackFn(current, _eventMeta('blob', current, {
              event: 'blob-status',
              key: 'blobs/' + hash,
              current,
              previous: null,
              replay: true,
            }))
          } catch {}
          if (once) break
        }
        if (once) {
          active = false
          offFn()
          return () => {}
        }
      }

      const stop = () => { active = false; offFn() }
      return stop
    }

    if (scope === 'delivery') {
      const matcher = _changeEventBus.match
      let active = true
      const stop = _getDelivery()?.onAny((entry, meta = {}) => {
        const deliveryKey = meta.key
        if (!active || !deliveryKey || !matcher(patternString, deliveryKey)) return
        const eventMeta = _eventMeta('delivery', entry, meta)
        try { callbackFn(entry, eventMeta) } finally {
          if (once) offDelivery()
        }
      }, { once: false }) ?? (() => {})

      const offDelivery = () => { active = false; stop() }

      if (immediate && !patternString.includes('*')) {
        _getDelivery()?.get(patternString).then((current) => {
          if (!active || !current) return
          try {
            callbackFn(current, _eventMeta('delivery', current, {
              event: 'delivery-state',
              key: patternString,
              current,
              previous: null,
              replay: true,
            }))
          } catch {}
          if (once) offDelivery()
        }).catch(() => {})
      }

      return offDelivery
    }

    let isActive = true
    const stopListening = _changeEventBus.on(patternString, (qubit, meta = {}) => {
      if (!isActive) return
      const eventMeta = _eventMeta('data', qubit, meta)
      callbackFn(qubit, eventMeta)
    }, { once })

    if (immediate && !patternString.includes('*')) {
      get(patternString).then((currentQuBit) => {
        if (!isActive || !currentQuBit) return
        callbackFn(currentQuBit, _eventMeta('data', currentQuBit, {
          event: 'put',
          key: patternString,
          current: currentQuBit,
          previous: null,
          replay: true,
        }))
        if (once) stopDataListening()
      }).catch(() => {})
    }

    const stopDataListening = () => {
      isActive = false
      stopListening()
    }

    return stopDataListening
  }

  const off = (patternString) => _changeEventBus.off(patternString)

  // signal exposes a small reactive wrapper around a single storage key.
  //   const aliasSignal = db.signal('~pub64/alias')
  //   aliasSignal.on(val => render(val))
  //   await aliasSignal.set('Neuer Name')
  const signal = (keyString) => {
    let _current = null
    get(keyString).then(q => { _current = q }).catch(() => {})

    const offFn = on(keyString, (q) => { _current = q })

    return {
      get:     ()      => _current,
      set:     (value) => put(keyString, value),
      on:      (fn)    => on(keyString, fn),
      destroy: ()      => offFn(),
    }
  }

  const subscriptions = () => _changeEventBus.patterns()


  // ── Middleware ───────────────────────────────────────────────────────────

  const useIn  = (fn, priority = 50) => _inPipeline.use(fn,  { priority })
  const useOut = (fn, priority = 50) => _outPipeline.use(fn, { priority })
  const use    = (pluginFactory)     => pluginFactory(api)


  // ── Hilfsfunktionen ──────────────────────────────────────────────────────

  const syncState = async (keyString) => (await get(keyString))?._status ?? null

  const syncAll = async () => {
    const pending = []
    for (const [prefix, adapter] of _backends) {
      if (['sys/', 'conf/', 'blobs/'].includes(prefix)) continue
      const rows = await _callAdapter(() => adapter.query(''), [])
      for (const { val } of rows) {
        if (isValidQuBit(val) && val._status === 'pending') pending.push(val)
      }
    }
    /*DEBUG*/ console.info('[QuRay:QuDB] syncAll:', pending.length, 'pending')
    for (const qubit of pending) {
      await _outPipeline.run({ qubit, key: qubit.key, syncMode: true, netPacket: null })
    }
  }

  const configure = (patch) => Object.assign(config, patch)

  const _sort = (qubits, mode) => {
    if (mode === 'ts-desc')    return [...qubits].sort((a, b) => b.ts - a.ts)
    if (mode === 'data.order') return [...qubits].sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
    return [...qubits].sort((a, b) => a.ts - b.ts)
  }

  const _resolveRefs = async (qubit, depth) => {
    if (!qubit.refs?.length || depth <= 0) return qubit
    const resolved = await Promise.all(
      qubit.refs.map(async (ref) => {
        const key = typeof ref === 'string' ? ref : ref.key
        return { key, resolved: await get(key, { resolve: depth > 1, resolveDepth: depth - 1 }) }
      })
    )
    return { ...qubit, refs: resolved }
  }


  // ── Init ─────────────────────────────────────────────────────────────────

  const init = async () => {
    if (config.backends) {
      for (const [prefix, adapter] of Object.entries(config.backends)) {
        mountBackend(prefix, adapter)
      }
    }

    // ── Restore blob status map from IDB on reload ─────────────────────────
    // _blobStatusMap is in-memory only — lost on every page reload.
    // Strategy: scan blobs/ IDB for stored hashes, mark as READY.
    // Meta (mime/name/size) is recovered from ~pub/blob/{hash} QuBits.
    // Runs async after init to not block startup.
    Promise.resolve().then(async () => {
      const blobBackend = _backends.get('blobs/') ?? null
      if (!blobBackend?.query) return
      try {
        const rows = await _callAdapter(() => blobBackend.query(''), [])
        let count = 0
        for (const row of rows ?? []) {
          const hash = row.key
          if (!hash || _blobStatusMap.has(hash)) continue
          // Blob binary exists in IDB → it's READY (Object URL created on demand)
          _blobStatusMap.set(hash, { status: BLOB_STATUS.READY, url: null, meta: {} })
          count++
        }
        // Enrich meta from QuBit ~pub/blob/{hash} for any restored blob
        // (non-blocking — happens lazily when status() is called)
        if (count > 0) {
          /*DEBUG*/ console.info('[QuRay:QuDB] blob status restored:', count, 'cached blobs')
          // Fire status changes for any waiters that registered before init completed
          for (const [hash, entry] of _blobStatusMap) {
            if (entry.status === BLOB_STATUS.READY && _blobWaiters.has(hash)) {
              const waiters = _blobWaiters.get(hash)
              waiters?.forEach(fn => { try { fn(entry) } catch(e) {} })
              _blobWaiters.delete(hash)
            }
          }
        }
      } catch(e) {
        /*DEBUG*/ console.warn('[QuRay:QuDB] blob restore error:', e.message)
      }
    })

    /*DEBUG*/ console.info('[QuRay:QuDB] init, Backends:', [..._backends.keys()])
  }


  // ── Public API ───────────────────────────────────────────────────────────

  const blobs = {
    // put(hash, buf, meta)         → store in IDB + enqueue upload to relay
    // stage(hash, buf, meta)       → store in IDB + ObjectURL only (no upload yet)
    // upload(hash)                 → enqueue upload for already-staged blob (e.g. on Send)
    put:    putBlob,
    stage:  (hash, buf, meta) => putBlob(hash, buf, meta, { sync: false }),
    upload: async (hash) => {
      if (!_queue) return
      const entry = _blobStatusMap.get(hash)
      if (!entry) return  // not staged
      await _queue.enqueue('blob.upload',
        { hash, mime: entry.meta?.mime ?? '', name: entry.meta?.name ?? '' },
        { dedupKey: 'blobup-' + hash, persistent: true })
      if (config.identity) {
        const metaKey = KEY.user(config.identity.pub).blob(hash)
        _getDelivery()?.set(metaKey, 'queued').catch(() => {})
      }
    },
    status: getBlob,
    get:    getBlob,
    on:     onBlob,
    load:   loadBlob,
    STATUS: BLOB_STATUS,
  }

  // ── Delivery Tracker ─────────────────────────────────────────────────────
  // Tracks 6-stage delivery state for every QuBit key.
  // Persistent in conf/delivery/ (local-only, survives reload).
  // Updated internally by db.put, sync.js, and relay ACKs.
  // Apps read reactively via: db.delivery.on(key, fn)
  // DeliveryTracker: created lazily after init() mounts backends.
  // Relay has no conf/ backend → tracker stays null there.
  let _delivery = null
  const _getDelivery = () => {
    if (!_delivery) {
      const hasConf = [..._backends.keys()].some(k => k === 'conf/' || k === '')
      // Pass rawWrite (bypasses pipeline/StoreOutPlugin) to avoid infinite recursion:
      // delivery.set() → db.put() → StoreOutPlugin → delivery.set() → loop!
      // rawWrite writes directly to backend without triggering delivery tracking again.
      if (hasConf) _delivery = DeliveryTracker({ rawWrite, get, del: del })
    }
    return _delivery
  }

  const _internal = {
    pipeline:      { in: _inPipeline, out: _outPipeline },
    bus:           _changeEventBus,
    setBlobStatus: _setBlobStatus,
    write:         rawWrite,
    get delivery() { return _getDelivery() },
    // Read raw blob buffer from backend (for upload to relay)
    readBlobBuffer: async (hash) => {
      const backend = _resolveBackend('blobs/')
      if (!backend) return null
      const data = await _callAdapter(() => backend.get(hash), null)
      if (!data) return null
      if (data instanceof ArrayBuffer) return data
      if (data?.arrayBuffer) return await data.arrayBuffer()
      return null
    },
  }

  // ── db.sync: Stable interface for the sync engine ──────────────────────
  // QuSync is the only consumer of this API.
  // All other modules use the public db.put/get/del/on/query API.
  // This separation keeps QuDB purely local — it has no knowledge of network topology.
  const syncApi = {
    // Write an incoming remote QuBit directly to the backend (bypasses OUT pipeline).
    // Source flag 'remote' prevents re-enqueuing in sync queue.
    writeRemote: (key, qubit) => rawWrite(key, qubit, 'remote'),

    // Run an incoming QuBit through the full IN pipeline:
    //   VerifyPlugin → StoreInPlugin (conflict resolve, rawWrite) → DispatchPlugin (db.on fires)
    // This is the canonical way for QuSync to handle incoming data.
    processIn: (qubit, src) => _inPipeline.run({ qubit, src }),

    // Delivery state: 6-stage funnel (local → queued → relay_in → peer_sent → peer_recv → peer_read)
    setDelivery: (key, state) => _getDelivery()?.set(key, state),

    // Blob status: update download/upload progress reactively (fires db.blobs.on listeners)
    setBlobStatus: _setBlobStatus,

    // Read raw blob bytes from IDB for relay upload
    readBlobBuffer: async (hash) => {
      const backend = _resolveBackend('blobs/')
      if (!backend) return null
      const data = await _callAdapter(() => backend.get(hash), null)
      if (!data) return null
      if (data instanceof ArrayBuffer) return data
      if (data?.arrayBuffer) return await data.arrayBuffer()
      return null
    },
  }

  const api = {
    init, configure,
    get, put, del, query,
    on, off, signal, subscriptions,
    blobs,
    get delivery() { return _getDelivery() },
    get sync() { return syncApi },  // clean interface for sync engine
    useIn, useOut, use,
    syncState, syncAll,
    mountBackend,
    get queue() { return _queue },
    _internal,
  }

  return api
}


export { QuDB, BLOB_STATUS, DELIVERY_STATE }
