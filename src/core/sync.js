// ════════════════════════════════════════════════════════════════════════════
// QuRay — core/sync.js  (v0.2)
// Bidirectional sync engine. Bridges QuDB (local) with remote peers.
//
// ┌─ Responsibilities ─────────────────────────────────────────────┐
// │  - Register remote peers to sync with (addPeer)                │
// │  - Push local writes to relay via OUT-pipeline hook            │
// │  - Pull missing data from relay (diffSync / subscribe)         │
// │  - Dispatch incoming packets to type handlers or IN pipeline   │
// │  - Blob upload/download queue tasks                            │
// │  - Service Worker coordination                                 │
// │  - Reconnect-triggered full re-sync                            │
// └────────────────────────────────────────────────────────────────┘
//
// ┌─ What QuSync does NOT do ───────────────────────────────────────┐
// │  - No presence/typing logic (→ QuPresence plugin)              │
// │  - No db.on('**') listener (→ db.useOut hook at prio SYNC_OUT) │
// │  - No knowledge of QuDB internals or EventBus                  │
// │  - No transport implementation (→ QuNet + transport plugins)   │
// └────────────────────────────────────────────────────────────────┘
//
// Peer model — addPeer({ url, type, transportName, capabilities }):
//   type: 'relay'   — persistent relay with HTTP API + WS push
//   type: 'replica' — storage-only replica (no HTTP API required)
//   type: 'client'  — another browser tab / device
//   type: 'local'   — in-process bridge (tests, electron)
//
// Outgoing write flow:
//   db.put() → OUT pipeline → STORE (60) → DISPATCH (49)
//           → SyncOut hook (5, registered via db.useOut)
//           → queue.enqueue(SYNC_OUT) → _pushToPeer()
//           → db.sync.setDelivery(key, 'relay_in')
//
// Incoming packet flow:
//   transport → net.on('message') → _processIncoming()
//   → registered type handler (QuPresence, app plugin) OR
//   → db.sync.processIn() (IN pipeline: StoreIn → DispatchIn → db.on fires)
// ════════════════════════════════════════════════════════════════════════════

import { QUBIT_TYPE, NO_STORE_TYPES, KEY, cleanQuBitForTransport } from './qubit.js'
import { PIPELINE_PRIORITY }                                        from './events.js'
import { pub64 }                                                    from './identity.js'
import { BLOB_STATUS }                                              from './db.js'
import { LOCAL_ONLY_RE }                                            from './mounts.js'
import { MemoryBackend }                                            from '../backends/memory.js'


// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PEER_TYPE = {
  RELAY:   'relay',
  REPLICA: 'replica',
  CLIENT:  'client',
  LOCAL:   'local',
}

const SYNC_TASK = {
  SYNC_OUT:      'sync.out',
  BLOB_UPLOAD:   'blob.upload',
  BLOB_DOWNLOAD: 'blob.download',
}

const HTTP_TIMEOUT_MS      = 15_000
const BLOB_HTTP_TIMEOUT_MS = 45_000
const DIFF_BATCH_SIZE      = 40


// ─────────────────────────────────────────────────────────────────────────────
// QUSYNC FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bidirectional sync engine.
 *
 * @param {object} options
 * @param {QuDBInstance}      options.db
 * @param {QuNetInstance}     options.net
 * @param {QuQueueInstance}   options.queue
 * @param {IdentityInstance}  [options.identity]
 * @param {object}            [options.config]
 * @returns {QuSyncInstance}
 * @group Sync
 * @since 0.2.0
 *
 * @example
 * // Subscribe BEFORE query for correct diffSync:
 * const off = await sync.observe('@space/chat/**', handler)
 * const rows = await db.query('@space/chat/')
 *
 * @example
 * sync.addPeer({ url: 'wss://relay.example.com', type: 'relay', transportName: 'ws:0' })
 */
const QuSync = ({ db, net, queue, identity, config = {} }) => {

  // ── Internal state ────────────────────────────────────────────────────────

  const _peers               = new Map()   // peerId → PeerEntry
  const _subscriptions       = new Map()   // prefix → SubscriptionEntry
  const _pendingRequests      = new Map()   // requestId → { resolve, reject, timer }
  const _pendingQueryRequests = new Map()   // requestId → { resolve, reject, timer } — for remoteQuery (no local DB write)
  const _activeBlobDownloads = new Set()
  const _syncInFlight        = new Set()
  const _typeHandlers        = new Map()   // qubitType → async fn(qubit, src)
  const _hasServiceWorker    = typeof navigator !== 'undefined' && 'serviceWorker' in navigator


  // ── Peer management ───────────────────────────────────────────────────────

  /**
   * Register a remote peer as a sync target.
   *
   * @param {object} options
   * @param {string}   [options.url]           - WS or HTTP URL
   * @param {string}   [options.pub]           - peer's public key
   * @param {string}   [options.type='relay']  - PEER_TYPE value
   * @param {string[]} [options.capabilities]  - feature strings
   * @param {string}   [options.label]         - human-readable name
   * @param {number}   [options.priority=10]   - higher = preferred
   * @param {string}   [options.transportName] - QuNet transport name
   * @param {string}   [options.httpUrl]       - override HTTP base URL
   * @param {function} [options.uploadBlob]    - custom upload fn
   * @param {function} [options.downloadBlob]  - custom download fn
   * @returns {string} peerId
   * @group Sync
   */
  const addPeer = ({
    url           = null,
    pub           = null,
    type          = PEER_TYPE.RELAY,
    capabilities  = [],
    label         = null,
    priority      = 10,
    transportName = null,
    httpUrl       = null,
    uploadBlob    = null,
    downloadBlob  = null,
  } = {}) => {
    const peerId = url ?? label ?? transportName ?? `peer-${_peers.size + 1}`
    _peers.set(peerId, {
      id: peerId, url, pub, type, capabilities, label, priority,
      transportName, httpUrl, uploadBlob, downloadBlob,
    })
    /*DEBUG*/ console.info('[QuRay:Sync] +Peer', peerId, `(${type})`)
    return peerId
  }

  const removePeer = (peerId) => {
    _peers.delete(peerId)
    /*DEBUG*/ console.info('[QuRay:Sync] -Peer', peerId)
  }

  const getPeers = () => [..._peers.values()].map(p => ({ ...p }))

  const _primaryPeer = (type = PEER_TYPE.RELAY) => {
    let best = null
    for (const p of _peers.values()) {
      if (p.type !== type) continue
      if (!best || p.priority > best.priority) best = p
    }
    return best
  }

  const _peerFor = (peerId = null) =>
    peerId ? _peers.get(peerId) ?? null : _primaryPeer(PEER_TYPE.RELAY)


  // ── Handler registry (plugin hook) ────────────────────────────────────────

  /**
   * Register a handler for a specific QuBit type.
   * Called BEFORE the default IN-pipeline so plugins can intercept ephemeral
   * types (peer.hello, typing, webrtc.offer, ...) without those going to IDB.
   *
   * @param {string}   type  - QUBIT_TYPE value, e.g. 'peer.hello'
   * @param {function} fn    - async (qubit, src: string) → void
   * @returns {function}     - off: call to unregister
   * @group Sync
   *
   * @example
   * // QuPresence plugin:
   * sync.registerHandler('peer.hello', async (qubit) => { ... })
   *
   * // WebRTC signaling plugin:
   * sync.registerHandler('webrtc.offer', async (qubit) => { ... })
   */
  const registerHandler = (type, fn) => {
    _typeHandlers.set(type, fn)
    return () => _typeHandlers.delete(type)
  }


  // ── Helpers ───────────────────────────────────────────────────────────────

  const _wsToHttp = (url) =>
    url.replace(/^wss?:\/\//, m => m === 'wss://' ? 'https://' : 'http://')

  const _httpUrl = (peer) => {
    if (!peer) return null
    if (peer.httpUrl) return peer.httpUrl
    if (!peer.url || typeof peer.url !== 'string') return null
    return peer.url.startsWith('ws') ? _wsToHttp(peer.url) : peer.url
  }

  const _transportOf = (peer) => peer?.transportName ?? peer?.transport ?? null

  const _requestId = () =>
    'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

  const _fetch = async (url, opts = {}, ms = HTTP_TIMEOUT_MS) => {
    const ctrl = new AbortController()
    const t    = setTimeout(() => ctrl.abort(), ms)
    try   { const r = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(t); return r }
    catch (e) { clearTimeout(t); throw e }
  }


  // ── Prefix utilities ──────────────────────────────────────────────────────

  const _prefixFromPattern = (pattern) => {
    if (pattern === '**' || pattern === '*') return null
    if (LOCAL_ONLY_RE.test(pattern)) return null
    const prefix = pattern
      .replace(/\/\*\*$/, '/').replace(/\/\*$/, '/')
      .replace(/\*\*$/, '').replace(/\*$/, '')
    return (prefix.length >= 3 && prefix.includes('/')) ? prefix : null
  }

  const _normalizePrefix = (p) => {
    if (!p || LOCAL_ONLY_RE.test(p)) return null
    if (p.endsWith('/') && p.includes('/')) return p
    return _prefixFromPattern(p)
  }

  const _prefixesFromSubscriptions = () => [..._subscriptions.keys()]

  const _SUBS_KEY = 'conf/sync_prefixes'

  // ── RemoteQuery intent storage ────────────────────────────────────────────
  // persist:'session' → sys/rq/   (MemoryBackend — survives WS reconnect, lost on page reload)
  // persist:'reload'  → conf/rq/  (LocalStorageBackend — survives page reload, re-fired on boot)
  // persist:'none'    → no DB storage, in-flight Map only (default — zero overhead)
  const _RQ_MOUNT = { session: 'sys/rq/', reload: 'conf/rq/' }

  const _storeQueryIntent = async (requestId, data) => {
    const mount = _RQ_MOUNT[data.persist]
    if (!mount) return
    await db.put(mount + requestId, data, { sync: false }).catch(() => {})
  }

  const _clearQueryIntent = async (requestId, persist) => {
    const mount = _RQ_MOUNT[persist]
    if (!mount) return
    await db.del(mount + requestId).catch(() => {})
  }

  const _loadPendingQueryIntents = async (persist) => {
    const mount = _RQ_MOUNT[persist]
    if (!mount) return []
    try {
      const rows = await db.query(mount, { includeDeleted: false })
      return rows
        .filter(r => r.data?.status === 'pending')
        .map(r => ({ requestId: r.key.slice(mount.length), ...r.data }))
    } catch { return [] }
  }
  const _persistSubs = (prefixes) => {
    if (prefixes?.length) db.put(_SUBS_KEY, prefixes, { sync: false }).catch(() => {})
  }
  const _loadPersistedSubs = async () => {
    try {
      const q = await db.get(_SUBS_KEY)
      const list = q?.data
      return Array.isArray(list) ? list.filter(p => typeof p === 'string') : []
    } catch { return [] }
  }

  const _dedup = (prefixes) =>
    prefixes.filter(p => !prefixes.some(o => o !== p && p.startsWith(o)))

  const _corePrefixes = (pub) => {
    if (!pub) return []
    const p = pub64(pub)
    return [`~${p}/`, `>${p}/`]
  }

  const _activePrefixes = (pub) => {
    const combined = [..._corePrefixes(pub), ..._prefixesFromSubscriptions()]
    return _dedup([...new Set(combined)])
  }


  // ── SyncOut hook — db.useOut at priority SYNC_OUT (5) ────────────────────
  //
  // Replaces the previous db.on('**') approach.
  // Runs AFTER StoreOutPlugin (60) + DispatchPlugin (49), so db.on() has
  // already fired when we enqueue. Clean, no event-bus coupling.

  const _registerSyncOutHook = () => {
    db.useOut(async ({ args: [ctx], next }) => {
      await next()  // complete remaining chain (safety — we are last at prio 5)

      const { qubit, syncMode } = ctx
      if (syncMode === false) return
      if (!qubit?.key || LOCAL_ONLY_RE.test(qubit.key)) return
      if (qubit?._status !== 'pending') return
      if (NO_STORE_TYPES.has(qubit.type)) return

      await queue.enqueue(
        SYNC_TASK.SYNC_OUT,
        { key: qubit.key, qubit: cleanQuBitForTransport(qubit) },
        { dedupKey: 'syncout-' + qubit.key }
      )
      db.sync.setDelivery(qubit.key, 'queued')
    }, PIPELINE_PRIORITY.SYNC_OUT)
  }


  // ── Diff-sync ─────────────────────────────────────────────────────────────

  const diffSyncPrefix = async (prefix, httpBase) => {
    if (_syncInFlight.has(prefix)) return 0
    _syncInFlight.add(prefix)
    try {
      let res
      try { res = await _fetch(`${httpBase}/api/sync?prefix=${encodeURIComponent(prefix)}&keysonly=1`) }
      catch { return 0 }
      if (!res.ok) return 0

      const { rows: relayIndex = [] } = await res.json()
      if (!relayIndex.length) return 0

      const localRows = await db.query(prefix).catch(() => [])
      const localKeys = new Set(localRows.map(r => r.key))
      const relayKeys = relayIndex.map(r => typeof r === 'string' ? r : (r.key ?? r.k ?? r))
      const missing   = relayKeys.filter(k => k && !localKeys.has(k))
      if (!missing.length) return 0

      /*DEBUG*/ console.info('[QuRay:Sync] diffSync', prefix, '→', missing.length, 'missing')

      let loaded = 0
      for (let i = 0; i < missing.length; i += DIFF_BATCH_SIZE) {
        try {
          const bRes = await _fetch(`${httpBase}/api/sync`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: missing.slice(i, i + DIFF_BATCH_SIZE) }),
          })
          if (!bRes.ok) continue
          const { rows = [] } = await bRes.json()
          for (const { val } of rows) {
            if (val?.type) { await _processIncoming(val, 'diff-sync'); loaded++ }
          }
        } catch (e) { /*DEBUG*/ console.warn('[QuRay:Sync] diffSync batch error:', e.message) }
      }
      return loaded
    } finally { _syncInFlight.delete(prefix) }
  }

  const _syncViaTransport = async (prefix, peer) => {
    const transportName = _transportOf(peer)
    if (!transportName) return 0
    const requestId = _requestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _pendingRequests.delete(requestId)
        reject(new Error('transport sync timeout'))
      }, HTTP_TIMEOUT_MS)
      _pendingRequests.set(requestId, { resolve, reject, timer })
      net.send({
        payload: {
          type: QUBIT_TYPE.DB_SUB, id: requestId, from: identity?.pub ?? null,
          data: { prefix, live: false, snapshot: true },
        }
      }, { via: transportName }).then((sent) => {
        if (!sent) {
          clearTimeout(timer)
          _pendingRequests.delete(requestId)
          reject(new Error('transport unavailable'))
        }
      }).catch((error) => {
        clearTimeout(timer)
        _pendingRequests.delete(requestId)
        reject(error)
      })
    })
  }


  // ── syncIn / syncOut / fullSync ───────────────────────────────────────────

  /**
   * Pull missing QuBits from a peer (or all active prefixes).
   * @param {string} [prefix]
   * @param {string} [peerId]
   * @returns {Promise<number>} loaded
   * @group Sync
   */
  const syncIn = async (prefix = null, peerId = null) => {
    const peer = _peerFor(peerId)
    if (!peer) return 0
    const prefixes = prefix ? [_normalizePrefix(prefix) ?? prefix] : _activePrefixes(identity?.pub)
    let total = 0
    const http = _httpUrl(peer)
    if (http) {
      const results = await Promise.allSettled(
        prefixes.filter(Boolean).map(p => diffSyncPrefix(p, http))
      )
      total = results.reduce((acc, r) => acc + (r.status === 'fulfilled' ? r.value : 0), 0)
    } else {
      for (const p of prefixes.filter(Boolean)) {
        try { total += await _syncViaTransport(p, peer) } catch { /* keep going */ }
      }
    }
    /*DEBUG*/ if (total) console.info('[QuRay:Sync] syncIn:', total, 'QuBits loaded')
    return total
  }

  /** Push locally-pending QuBits to the relay queue. */
  const syncOut = async () => {
    const rows = await db.query('~').catch(() => [])
    let count = 0
    for (const q of rows) {
      if (q._status === 'pending' && !NO_STORE_TYPES.has(q.type)) {
        await queue.enqueue(
          SYNC_TASK.SYNC_OUT, { key: q.key, qubit: cleanQuBitForTransport(q) },
          { dedupKey: 'syncout-' + q.key }
        ).catch(() => {})
        count++
      }
    }
    return count
  }

  const fullSync = async (peerId = null) => {
    await syncIn(null, peerId)
    await syncOut()
  }


  // ── Subscribe / Unsubscribe / Observe / Pull ──────────────────────────────

  /**
   * Subscribe to a remote prefix: snapshot diff + live relay subscription.
   * @param {string} patternOrPrefix
   * @param {object} [opts]
   * @param {boolean} [opts.live=true]
   * @param {boolean} [opts.snapshot=true]
   * @param {string}  [opts.peerId]
   * @param {string}  [opts.transportName]
   * @returns {Promise<function>} off
   * @group Sync
   */
  const subscribe = async (patternOrPrefix, opts = {}) => {
    const prefix = _normalizePrefix(patternOrPrefix)
    if (!prefix) return () => {}

    const entry = {
      prefix,
      live:          opts.live !== false,
      peerId:        opts.peerId ?? null,
      transportName: opts.transportName ?? null,
    }
    _subscriptions.set(prefix, entry)
    _persistLiveSubscriptions()

    const peer          = _peerFor(entry.peerId)
    const transportName = entry.transportName ?? _transportOf(peer)
    const http          = _httpUrl(peer)

    if (opts.snapshot !== false) {
      if (http) await diffSyncPrefix(prefix, http).catch(() => {})
      else if (peer && transportName) await _syncViaTransport(prefix, { ...peer, transportName }).catch(() => {})
    }

    if (entry.live && transportName) {
      await net.send({
        payload: {
          type: QUBIT_TYPE.DB_SUB, from: identity?.pub ?? null,
          data: { prefix, live: true, snapshot: false },
        }
      }, { via: transportName }).catch(() => false)
    }

    return () => unsubscribe(prefix, entry)
  }

  const unsubscribe = async (patternOrPrefix, _entry = null) => {
    const prefix = _normalizePrefix(patternOrPrefix)
    if (!prefix) return false
    const entry = _entry ?? _subscriptions.get(prefix)
    _subscriptions.delete(prefix)
    _persistLiveSubscriptions()
    const peer          = _peerFor(entry?.peerId)
    const transportName = entry?.transportName ?? _transportOf(peer)
    if (entry?.live && transportName) {
      await net.send({
        payload: { type: QUBIT_TYPE.DB_UNSUB, from: identity?.pub ?? null, data: { prefix } }
      }, { via: transportName }).catch(() => false)
    }
    return true
  }

  const _persistLiveSubscriptions = () => {
    const prefixes = [..._subscriptions.values()]
      .filter(e => e.live !== false).map(e => e.prefix)
    if (prefixes.length) _persistSubs(_dedup([...new Set(prefixes)]))
  }

  /**
   * Combined local listener + remote subscription.
   * db.on(pattern) + sync.subscribe(pattern) in one call.
   *
   * @param {string}   pattern
   * @param {function} callback  - fn(qubit, { event, key, source })
   * @param {object}   [opts]
   * @returns {Promise<function>} off
   * @group Sync
   *
   * @example
   * const off = await sync.observe('@space/chat/**', (q, { event }) => {
   *   if (event === 'put') addMessage(q)
   * })
   */
  const observe = async (pattern, callback, opts = {}) => {
    const offLocal  = db.on(pattern, callback, opts.db ?? {})
    const offRemote = await subscribe(pattern, opts)
    return () => { offLocal?.(); offRemote?.() }
  }

  /**
   * observe + immediate local query. Returns current rows while syncing remotely.
   *
   * @param {string}   prefix
   * @param {function} callback
   * @param {object}   [opts]
   * @returns {Promise<{ off: function, rows: QuBit[] }>}
   * @group Sync
   *
   * @example
   * const { off, rows } = await sync.pull('@space/todos/', handler)
   * renderTodos(rows)
   */
  const pull = async (prefix, callback, opts = {}) => {
    const pattern = prefix.endsWith('**') ? prefix : prefix + '**'
    const off  = await observe(pattern, callback, opts)
    const rows = await db.query(prefix, opts.query ?? {}).catch(() => [])
    return { off, rows }
  }


  // ── remoteQuery ───────────────────────────────────────────────────────────
  //
  // Fetches QuBits from a relay peer without writing to the local DB by default.
  // Mirrors the db.query() option surface (order, limit, filter, since) and adds:
  //
  //   sync        {boolean} default false — when true, results run through the
  //               normal IN pipeline (VerifyPlugin → StoreIn → db.on fires).
  //               When false (default), local DB is bypassed entirely.
  //
  //   targetMount {object}  optional landing zone for results:
  //               { prefix: 'sys/remote/people/', backend?: BackendAdapter }
  //               Keys are re-keyed under the target prefix (prefix tail is preserved).
  //               backend defaults to a fresh MemoryBackend().
  //               After the call, db.query('sys/remote/people/') works normally.
  //
  //   persist     {'none'|'session'|'reload'}  default 'none'
  //               Controls query-intent persistence (not result persistence):
  //               'none'    — intent in-flight Map only, zero overhead
  //               'session' — intent in sys/rq/ (MemoryBackend), survives WS reconnect
  //               'reload'  — intent in conf/rq/ (LocalStorageBackend), re-fired on page reload
  //
  //   peerId      optional — which relay peer to query (default: primary relay)
  //   timeout     ms, default 15 000
  //
  // @example — minimal (results returned only)
  //   const people = await sync.remoteQuery('@users/', { order: 'ts-desc', limit: 50 })
  //
  // @example — targetMount (results accessible via db.query())
  //   await sync.remoteQuery('@users/', {
  //     targetMount: { prefix: 'sys/remote/people/' },
  //     persist: 'session',
  //   })
  //   const people = await db.query('sys/remote/people/')
  //
  // @example — normal DB sync (like a manual diffSync for a specific prefix)
  //   await sync.remoteQuery('@space/todos/', { sync: true })
  //
  const remoteQuery = async (prefix, options = {}) => {
    const {
      order          = 'ts',
      limit,
      filter,
      since,
      includeDeleted = false,
      peerId         = null,
      targetMount    = null,
      sync:  doSync  = false,
      persist        = 'none',
      timeout        = HTTP_TIMEOUT_MS,
    } = options

    const peer = _peerFor(peerId)
    if (!peer) throw new Error('remoteQuery: no relay peer available')

    // Re-use a supplied requestId when re-firing a persisted pending query
    const requestId = options._rqId ?? _requestId()

    // Serialisable subset of options for intent storage (functions not serialisable)
    const serializableOpts = {
      order, limit, since, includeDeleted, doSync, persist, peerId,
      targetMount: targetMount ? { prefix: targetMount.prefix } : null,
    }

    const intent = { prefix, options: serializableOpts, status: 'pending', ts: Date.now(), persist }
    await _storeQueryIntent(requestId, intent)

    let rawRows = []

    try {
      const http = _httpUrl(peer)

      if (http) {
        // ── HTTP path: full rows in one request ───────────────────────────
        const res = await _fetch(
          `${http}/api/sync?prefix=${encodeURIComponent(prefix)}`,
          {},
          timeout,
        )
        if (res.ok) {
          const { rows = [] } = await res.json()
          rawRows = rows.map(r => r.val ?? r).filter(q => q?.key)
        }
      } else {
        // ── WS path: send DB_SUB snapshot request, await DB_RES ───────────
        const transportName = _transportOf(peer)
        if (!transportName) throw new Error('remoteQuery: peer has no transport')

        rawRows = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            _pendingQueryRequests.delete(requestId)
            reject(new Error(`remoteQuery timeout after ${timeout}ms`))
          }, timeout)
          _pendingQueryRequests.set(requestId, { resolve, reject, timer })
          net.send({
            payload: {
              type: QUBIT_TYPE.DB_SUB,
              id:   requestId,
              from: identity?.pub ?? null,
              data: { prefix, live: false, snapshot: true },
            },
          }, { via: transportName }).catch(e => {
            clearTimeout(timer)
            _pendingQueryRequests.delete(requestId)
            reject(e)
          })
        })
      }

      // ── Filter / sort / limit (mirrors db.query() logic) ─────────────────
      let qubits = rawRows
        .filter(q => q?.key && q?.type)
        .filter(q => includeDeleted || !q.deleted)
        .filter(q => {
          if (!prefix)                return true
          if (q.key === prefix)       return true
          if (prefix.endsWith('/'))   return q.key.startsWith(prefix)
          if (prefix.length === 1)    return q.key.startsWith(prefix)
          return q.key.startsWith(prefix + '/')
        })

      if (since)  qubits = qubits.filter(q => q.ts > since)
      if (filter) qubits = qubits.filter(filter)

      if      (order === 'ts-desc')    qubits.sort((a, b) => b.ts  - a.ts)
      else if (order === 'key')        qubits.sort((a, b) => a.key.localeCompare(b.key))
      else if (order === 'data.order') qubits.sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
      else                             qubits.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))

      if (limit) qubits = qubits.slice(0, limit)

      // ── Write results ─────────────────────────────────────────────────────
      if (targetMount?.prefix) {
        // Mount a dedicated backend and re-key items under the target prefix
        const mountPrefix = targetMount.prefix.endsWith('/') ? targetMount.prefix : targetMount.prefix + '/'
        const backend     = targetMount.backend ?? MemoryBackend()
        db.mountBackend(mountPrefix, backend)
        for (const q of qubits) {
          const tail      = q.key.startsWith(prefix) ? q.key.slice(prefix.length) : q.key
          const cleanTail = tail.startsWith('/') ? tail.slice(1) : tail
          const targetKey = mountPrefix + cleanTail
          const rewritten = { ...q, key: targetKey }
          // rawWrite stores the value; fire the event bus manually so db.on() listeners trigger.
          // (rawWrite intentionally omits bus emission — we do it here as trusted relay data.)
          await db.sync.writeRemote(targetKey, rewritten)
          await db._internal.bus.emit(targetKey, rewritten, {
            event: rewritten.deleted ? 'del' : 'put',
            key:      targetKey,
            source:   'remote-query',
            scope:    'data',
            current:  rewritten,
            previous: null,
          })
        }
        /*DEBUG*/ console.info('[QuRay:Sync] remoteQuery mounted', qubits.length, 'rows at', mountPrefix)
      } else if (doSync) {
        // Trusted relay data — bypass VerifyPlugin (relay is already authoritative).
        // Use rawWrite + manual bus emit, same as replica-db.js store() does.
        for (const q of qubits) {
          const stored = { ...q, _status: 'synced' }
          await db.sync.writeRemote(q.key, stored)
          await db._internal.bus.emit(q.key, stored, {
            event: stored.deleted ? 'del' : 'put',
            key:      q.key,
            source:   'remote-query',
            scope:    'data',
            current:  stored,
            previous: null,
          })
        }
        /*DEBUG*/ console.info('[QuRay:Sync] remoteQuery synced', qubits.length, 'rows into local DB')
      }

      // Mark done (fires db.on() for session/reload listeners)
      await _storeQueryIntent(requestId, { ...intent, status: 'done', count: qubits.length })
      // Clean up reload-survived queries once successfully completed
      if (persist === 'reload') await _clearQueryIntent(requestId, 'reload')

      return qubits

    } catch (e) {
      await _storeQueryIntent(requestId, { ...intent, status: 'error', error: e.message })
      throw e
    } finally {
      // Session-scope intents are informational after completion — keep for one session
      // None-scope intents were never stored — nothing to clean up
    }
  }




  const _pushToPeer = async (qubit) => {
    const peer = _primaryPeer(PEER_TYPE.RELAY)
    if (!peer) return

    let routeTo = null
    if (qubit.key?.startsWith('>')) {
      const seg = qubit.key.slice(1).split('/')[0]
      if (seg) routeTo = seg
    }

    const http = _httpUrl(peer)
    if (http) {
      const res = await _fetch(`${http}/api/msg`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: routeTo, ttl: 8, payload: cleanQuBitForTransport(qubit) }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } else {
      const transportName = _transportOf(peer)
      if (!transportName) throw new Error('no relay transport configured')
      const sent = await net.send(
        { payload: cleanQuBitForTransport(qubit), to: routeTo, ttl: 8 },
        { via: transportName }
      )
      if (!sent) throw new Error('relay transport unavailable')
    }

    await db.sync.writeRemote(qubit.key, { ...qubit, _status: 'synced' })
    db.sync.setDelivery(qubit.key, 'relay_in')
    if (qubit.type === 'msg' || qubit.type === 'data') {
      setTimeout(() => db.sync.setDelivery(qubit.key, 'peer_sent'), 500)
    }
  }


  // ── Incoming packet processing ────────────────────────────────────────────

  const _processIncoming = async (qubit, src = 'ws') => {
    if (!qubit?.type) return

    // 1. Plugin type handler (QuPresence, WebRTC signaling, app-level types)
    const handler = _typeHandlers.get(qubit.type)
    if (handler) { await handler(qubit, src); return }

    // 2. Delivery receipts
    if (qubit.type === 'msg.receipt') {
      const { msgKey, state } = qubit.data ?? qubit
      if (msgKey) db.sync.setDelivery(msgKey, state === 'read' ? 'peer_read' : 'peer_recv')
      return
    }

    // 3. Blob ready — relay signal that a blob is downloadable
    if (qubit.type === QUBIT_TYPE.BLOB_READY) { await _handleBlobReady(qubit); return }

    // 4. Standard data — run through IN pipeline (StoreIn → DispatchIn → db.on)
    if (!qubit.key) return
    try { await db.sync.processIn(qubit, src) }
    catch (e) { /*DEBUG*/ console.warn('[QuRay:Sync] IN pipeline error:', e.message, qubit.type) }

    // Blob meta: trigger auto-download if below limit
    if (qubit.type === QUBIT_TYPE.BLOB_META) await _handleBlobMeta(qubit)
  }


  // ── Blob handling ─────────────────────────────────────────────────────────

  const _handleBlobReady = async (qubit) => {
    const { hash, mime, name, size } = qubit.data ?? qubit
    if (!hash) return
    const existing = db.blobs.status(hash)
    if (existing?.status === BLOB_STATUS.READY || existing?.status === BLOB_STATUS.AWAITING_USER) return
    const meta = { mime: mime ?? existing?.meta?.mime ?? '', name: name ?? existing?.meta?.name ?? '', size: size ?? existing?.meta?.size ?? 0 }
    if (!existing) await db.sync.setBlobStatus(hash, BLOB_STATUS.PENDING, null, meta)
    const useMeta  = existing?.meta ?? meta
    const ownerPub = existing?.meta?.ownerPub ?? qubit.from ?? null
    await queue.enqueue(SYNC_TASK.BLOB_DOWNLOAD,
      { hash, mime: useMeta.mime, name: useMeta.name, size: useMeta.size, ownerPub },
      { dedupKey: 'blob-' + hash, priority: 3 })
    /*DEBUG*/ console.info('[QuRay:Sync] blob.ready → download queued:', hash.slice(0, 16))
  }

  const _handleBlobMeta = async (qubit) => {
    const { hash, mime, name, size } = qubit.data ?? {}
    if (!hash) return
    const meta = { mime, name, size, ownerPub: qubit.from ?? null }
    await db.sync.setBlobStatus(hash, BLOB_STATUS.PENDING, null, meta)
    if ((size ?? 0) > (config.blobAutoLoadLimit ?? 512 * 1024)) {
      await db.sync.setBlobStatus(hash, BLOB_STATUS.AWAITING_USER, null, meta); return
    }
    await queue.enqueue(SYNC_TASK.BLOB_DOWNLOAD,
      { hash, mime, name, size, ownerPub: qubit.from ?? null },
      { dedupKey: 'blob-' + hash, priority: 3 })
  }

  const _storeBlob = async (hash, b64, mime, name) => {
    const _b2buf = (s) => {
      const std = s.replace(/-/g, '+').replace(/_/g, '/')
      const p   = (4 - std.length % 4) % 4
      return Uint8Array.from(atob(std + '='.repeat(p)), c => c.charCodeAt(0)).buffer
    }
    await db.blobs.put(hash, _b2buf(b64), { mime, name }, { sync: false })
  }


  // ── Queue handlers ────────────────────────────────────────────────────────

  const _registerQueueHandlers = () => {
    queue.process(SYNC_TASK.SYNC_OUT,      t => _pushToPeer(t.data.qubit))
    queue.process(SYNC_TASK.BLOB_DOWNLOAD, _downloadBlob)
    queue.process(SYNC_TASK.BLOB_UPLOAD,   _uploadBlob)
  }

  const _downloadBlob = async (task) => {
    const { hash, mime, name, ownerPub } = task.data
    if (_activeBlobDownloads.has(hash)) return
    _activeBlobDownloads.add(hash)
    try {
      const peer = _primaryPeer(PEER_TYPE.RELAY)
      if (!peer) throw new Error('no relay peer')
      if (typeof peer.downloadBlob === 'function') {
        const payload = await peer.downloadBlob({ hash, mime, name, ownerPub })
        if (!payload?.buffer) { await db.sync.setBlobStatus(hash, BLOB_STATUS.ERROR, null, {}); return }
        queue.reportProgress?.(task.id, 80)
        await db.blobs.put(hash, payload.buffer, { mime: payload.mime ?? mime, name: payload.name ?? name }, { sync: false })
        queue.reportProgress?.(task.id, 100); return
      }
      const ownerQ = ownerPub ? `?owner=${encodeURIComponent(pub64(ownerPub))}` : ''
      const res    = await _fetch(`${_httpUrl(peer)}/api/blob/${encodeURIComponent(hash)}${ownerQ}`, {}, BLOB_HTTP_TIMEOUT_MS)
      if (res.status === 404) { await db.sync.setBlobStatus(hash, BLOB_STATUS.ERROR, null, {}); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { b64, mime: m, name: n } = await res.json()
      if (!b64) throw new Error('no b64 in response')
      queue.reportProgress?.(task.id, 80)
      await _storeBlob(hash, b64, m ?? mime, n ?? name)
      queue.reportProgress?.(task.id, 100)
    } finally { _activeBlobDownloads.delete(hash) }
  }

  const _uploadBlob = async (task) => {
    const { hash, mime, name } = task.data
    const peer = _primaryPeer(PEER_TYPE.RELAY)
    if (!peer) throw new Error('no relay peer')
    const buffer = await db.sync.readBlobBuffer(hash)
    if (!buffer) throw new Error(`blob ${hash.slice(0, 12)} not in IDB`)
    queue.reportProgress?.(task.id, 20)
    const _buf2b64 = (buf) => {
      const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : (buf.buffer ?? buf))
      let bin = ''
      const CHUNK = 8192
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    }
    const b64 = _buf2b64(buffer)
    queue.reportProgress?.(task.id, 60)
    if (typeof peer.uploadBlob === 'function') {
      await peer.uploadBlob({ hash, buffer, mime: mime ?? '', name: name ?? '', from: identity?.pub ?? null })
      queue.reportProgress?.(task.id, 100)
      // Custom uploadBlob (browser relay, custom peer) doesn't auto-broadcast blob.ready.
      // We broadcast it ourselves through the transport so other peers can download.
      const transportName = _transportOf(peer)
      if (transportName) {
        await net.send({
          payload: {
            type:  QUBIT_TYPE.BLOB_READY,
            hash,
            mime:  mime ?? '',
            name:  name ?? '',
            size:  buffer.byteLength ?? buffer.length ?? 0,
            from:  identity?.pub ?? null,
          }
        }, { via: transportName }).catch(() => {})
      }
    } else {
      const res = await _fetch(`${_httpUrl(peer)}/api/blob`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, b64, mime: mime ?? '', name: name ?? '', from: identity?.pub ?? null }),
      }, BLOB_HTTP_TIMEOUT_MS)
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(`HTTP ${res.status}: ${body.error ?? ''}`) }
      queue.reportProgress?.(task.id, 100)
      // HTTP relay broadcasts blob.ready server-side — no extra send needed here.
    }
    const metaKey = identity?.pub ? KEY.user(identity.pub).blob(hash) : null
    if (metaKey) db.sync.setDelivery(metaKey, 'blob_relay')
    /*DEBUG*/ console.info('[QuRay:Sync] blob.upload OK:', hash.slice(0, 16))
  }


  // ── Net listener ──────────────────────────────────────────────────────────

  const _registerNetListeners = () => {
    net.on('message', async (pkt, { transport: tName }) => {
      const qubit = pkt?.payload ?? pkt
      if (!qubit?.type) return

      if (qubit.type === QUBIT_TYPE.DB_PUSH || qubit.type === QUBIT_TYPE.DB_RES) {
        const rows      = qubit.data?.rows ?? (qubit.data?.key ? [{ key: qubit.data.key, val: qubit.data.val }] : [])
        const requestId = qubit.data?.requestId ?? qubit.id ?? null

        // remoteQuery intercept — collect rows without writing to local DB
        if (requestId && _pendingQueryRequests.has(requestId)) {
          const pending = _pendingQueryRequests.get(requestId)
          clearTimeout(pending.timer)
          _pendingQueryRequests.delete(requestId)
          pending.resolve(rows.map(r => r.val).filter(Boolean))
          return
        }

        let loaded = 0
        for (const { val } of rows) { if (!val) continue; await _processIncoming(val, 'relay-push'); loaded++ }
        if (requestId && _pendingRequests.has(requestId)) {
          const pending = _pendingRequests.get(requestId)
          clearTimeout(pending.timer); _pendingRequests.delete(requestId); pending.resolve(loaded)
        }
        return
      }

      if (qubit.type === QUBIT_TYPE.PEERS_LIST) {
        const list = Array.isArray(qubit.data) ? qubit.data : []
        for (const p of list) {
          if (!p.pub) continue
          const helloHandler = _typeHandlers.get(QUBIT_TYPE.PEER_HELLO)
          if (helloHandler) await helloHandler({ type: QUBIT_TYPE.PEER_HELLO, from: p.pub, data: p }, tName)
          else await db.sync.writeRemote(KEY.peer(p.pub), { ...p, ts: Date.now() }, 'sync')
        }
        return
      }

      await _processIncoming(qubit, tName)
    })
  }


  // ── Service Worker ────────────────────────────────────────────────────────

  const _registerSwListener = () => {
    if (!_hasServiceWorker) return
    navigator.serviceWorker.addEventListener('message', async (ev) => {
      const { type, ...d } = ev.data ?? {}
      if (type === 'sw.blobReady' && d.hash && d.b64) await _storeBlob(d.hash, d.b64, d.mime, d.name)
      if (type === 'sw.syncData' && Array.isArray(d.rows)) for (const { val } of d.rows) if (val) await _processIncoming(val, 'sw-sync')
      if (type === 'sw.pushReceived') await syncIn().catch(() => {})
    })
  }

  const configureServiceWorker = () => {
    if (!_hasServiceWorker || !identity?.pub) return
    const peer = _primaryPeer(PEER_TYPE.RELAY)
    if (!peer) return
    navigator.serviceWorker.ready.then(reg =>
      reg.active?.postMessage({
        type: 'sw.setConfig', relayUrl: _httpUrl(peer), pub: identity.pub,
        prefixes: _activePrefixes(identity.pub),
        periodicSync: config.periodicSync ?? false,
        periodicInterval: config.periodicInterval ?? 15 * 60 * 1000,
      })
    ).catch(() => {})
  }


  // ── Connect hook ──────────────────────────────────────────────────────────

  const _registerConnectHook = () => {
    let _wasConnected = false
    net.state$.on(async (states) => {
      const now = Object.values(states).some(s => s === 'connected')
      if (now && !_wasConnected) {
        _wasConnected = true
        queue.start?.()
        queue.retryAll?.().catch(() => {})
        if (identity?.pub && config.syncOnConnect !== false) {
          setTimeout(async () => {
            await syncIn().catch(() => {})
            const liveSubs  = _prefixesFromSubscriptions()
            const savedSubs = await _loadPersistedSubs()
            const allSubs   = [...new Set([...liveSubs, ...savedSubs])]
            for (const prefix of allSubs) await subscribe(prefix, { live: true, snapshot: true }).catch(() => {})
            _persistLiveSubscriptions()
            configureServiceWorker()

            // Re-fire any remoteQueries that were pending when the connection dropped/reloaded
            for (const q of await _loadPendingQueryIntents('session')) {
              /*DEBUG*/ console.info('[QuRay:Sync] reconnect: re-firing session remoteQuery', q.prefix)
              remoteQuery(q.prefix, { ...q.options, persist: 'session', _rqId: q.requestId }).catch(() => {})
            }
            for (const q of await _loadPendingQueryIntents('reload')) {
              /*DEBUG*/ console.info('[QuRay:Sync] reconnect: re-firing reload remoteQuery', q.prefix)
              remoteQuery(q.prefix, { ...q.options, persist: 'reload', _rqId: q.requestId }).catch(() => {})
            }
          }, 800)
        }
      }
      if (!now) _wasConnected = false
    })
  }


  // ── Init ──────────────────────────────────────────────────────────────────

  const init = () => {
    _registerQueueHandlers()
    _registerNetListeners()
    _registerSyncOutHook()    // <-- replaces db.on('**')
    _registerSwListener()
    _registerConnectHook()
    /*DEBUG*/ console.info('[QuRay:Sync] init (v0.2 — db.useOut hook)')
  }


  // ── Public API ────────────────────────────────────────────────────────────

  return {
    init,

    // Peer management
    addPeer,
    removePeer,
    getPeers,

    // Plugin hook — intercept incoming types
    registerHandler,

    // Sync operations
    subscribe,
    unsubscribe,
    observe,
    pull,
    remoteQuery,
    syncIn,
    syncOut,
    fullSync,
    diffSyncPrefix,

    // Service Worker
    configureServiceWorker,

    // Introspection
    subscriptions: () => [..._subscriptions.values()].map(e => ({ ...e })),
    peers:         () => [..._peers.values()].map(p => ({ ...p })),

    PEER_TYPE,
    SYNC_TASK,
  }
}


export { QuSync, PEER_TYPE, SYNC_TASK }
