// ════════════════════════════════════════════════════════════════════════════
// QuRay — quray.js  (v0.9)
//
// Entry point. Composes the framework from the core, plugin, transport, relay, and UI layers.
//
// ┌─ Usage modes ────────────────────────────────────────────────┐
// │                                                               │
// │  1. PROGRAMMATIC (ES module)                                 │
// │     import QuRay from './dist/quray.dev.js'                   │
// │     const qr = await QuRay.init({ relay: 'wss://…' })        │
// │     await qr.db.put('~me/note', { text: 'Hello' })           │
// │     qr.db.on('~me/**', (val, {key}) => render(key, val))      │
// │                                                               │
// │  2. DECLARATIVE (<script> tag, no app code required)          │
// │     <script src="dist/quray.js"                               │
// │       data-relay="wss://relay.example.com"                    │
// │       data-alias="Alice"                                      │
// │       data-ui                                                 │
// │     ></script>                                                │
// │     <span qu-scope="~${me.pub64}" qu-text="alias"></span>     │
// │     <ul qu-for="@uuid/todos/" qu-order="ts-desc"></ul>        │
// │                                                               │
// │  3. HYBRID (declarative boot, programmatic extension)         │
// │     QuRay.ready(qr => { qr.db.on('@space/**', handler) })     │
// │                                                               │
// └───────────────────────────────────────────────────────────────┘
//
// Key layout:
//   ~{pub64}/   User space     — user-owned and signed
//   @{uuid}/    Shared space   — ACL-governed shared data
//   >{pub64}/   Inbox          — relay writes, client reads
//   sys/        Ephemeral      — memory-only, never persisted
//   conf/       Config         — local-only, never replicated
// ════════════════════════════════════════════════════════════════════════════

import { Identity }                                               from './core/identity.js'
import { QuDB }                                                   from './core/db.js'
import { QuQueue }                                                from './core/queue.js'
import { QuNet }                                                  from './core/net.js'
import { QuSync, PEER_TYPE }                                      from './core/sync.js'
import { QuPresence }                                             from './core/presence.js'
import { KEY }                                                    from './core/qubit.js'
import { MOUNT }                                                  from './core/mounts.js'
import { LocalPeer, PeerMap }                                     from './core/peers.js'
import { QuNode }                                                 from './core/node.js'

import { SignPlugin }                                             from './plugins/sign.js'
import { VerifyPlugin }                                           from './plugins/verify.js'
import { StoreInPlugin, StoreOutPlugin }                          from './plugins/store.js'
import { DispatchPlugin }                                         from './plugins/dispatch.js'
import { AccessControlPlugin }                                    from './plugins/access.js'

import { IdbBackend }                                             from './backends/idb.js'
import { MemoryBackend, LocalStorageBackend }                     from './backends/memory.js'
import { HttpTransport }                                          from './transports/http.js'
import { WsTransport }                                            from './transports/ws.js'

import { QuBinding, registerBindingComponents }                   from './ui/binding.js'
import { registerComponents }                                     from './ui/components.js'
import { QuDirectives, registerDirectiveComponents, registerDirective } from './ui/directives.js'
import { PushHelper } from './push.js'


// ─────────────────────────────────────────────────────────────────────────────
// STATE (single instance per page)
// ─────────────────────────────────────────────────────────────────────────────

let _instance = null
const _readyCallbacks = []


// ─────────────────────────────────────────────────────────────────────────────
// QuRay.init(options)
//
// options.relay / options.relays   Relay URL(s) or relay config objects
// options.alias                    Initial display alias
// options.backup / .identity       Identity backup to restore
// options.passphrase               Passphrase for encrypted identity backups
//
// Plugin config (each plugin reads its own namespace — no shared flags):
//   options.ui          true → register all Custom Elements (qu-text, qu-list, …)
//   options.binding     true → enable reactive DOM binding (default = ui)
//   options.directives  true → enable directive components (default = ui)
//   options.presence    false → disable QuPresence plugin (peer.hello/bye/typing)
//   options.ws          { ...WsTransport options } — merged per-relay
//   options.http        { ...HttpTransport options } — merged per-relay
//
// Advanced:
//   options.plugins           [pluginFactory, ...] — custom middleware factories
//   options.backends          { 'prefix': adapter } — custom backend mounts
//   options.middleware        { verify, sign, store, dispatch } — disable built-in middleware
//   options.blobAutoLoadLimit Auto-download threshold in bytes (default: 512 KB)
//   options.syncOnConnect     Trigger diffSync on relay connect (default: true)
//   options.conflictStrategy  (local, incoming) → winner QuBit (default: Last-Write-Wins)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise a QuRay instance.
 *
 * @param {object}  options
 * @param {string}  [options.relay]             WebSocket relay URL (optional — works offline)
 * @param {string}  [options.alias]             Initial display alias
 * @param {string}  [options.passphrase]        Passphrase to encrypt the identity backup
 * @param {object}  [options.identity]          Existing identity backup to restore
 * @param {number}  [options.blobAutoLoadLimit] Auto-download blobs smaller than this (bytes, default 512KB)
 * @param {boolean} [options.syncOnConnect]     Trigger diffSync on relay connect (default true)
 * @param {boolean} [options.ui]                Register all Custom Elements (default false)
 * @returns {Promise<QuRayInstance>}
 */
const init = async (options = {}) => {
  const {
    alias             = '',
    passphrase        = null,
    blobAutoLoadLimit = 512 * 1024,
    syncOnConnect     = true,
    conflictStrategy  = null,
    ui         = false,
    binding    = ui,
    directives = ui,
  } = options

  const relayConfigurations = _normalizeRelays(options)


  // ── 1. Identity ────────────────────────────────────────────────────────

  // conf/ uses LocalStorage so runtime configuration survives reloads and IDB stalls.
  const confStore  = LocalStorageBackend({ prefix: 'qr_' })
  const savedBackup = options.backup ?? options.identity
    ?? await confStore.get('identity')  // rawWrite strips 'conf/' prefix → stored as 'identity'

  const identity = await Identity({
    backup:     savedBackup,
    passphrase: passphrase,
    alias:      alias,
  })


  // ── 2. Backends ────────────────────────────────────────────────────────
  //
  // Storage routing is mount-based. Sigil prefixes (~, @, >) intentionally share
  // the same durable backend so user space, shared space, and inbox data stay
  // queryable under separate namespaces while still using one physical database.

  const dbName = 'quray-' + identity.pub.slice(0, 12).replace(/[+/=]/g, '_')
  const mainIdb = IdbBackend({ name: dbName, openTimeout: 8_000, txTimeout: 10_000 })

  // Default backends follow the MOUNT contract from core/mounts.js.
  // The three syncable sigil mounts (~, @, >) intentionally share one IDB
  // instance so user/space/inbox data stays queryable across namespaces.
  // Custom mounts can override individual prefixes via options.backends.
  const backends = {
    [MOUNT.USER.prefix]:  mainIdb,    // ~ → IDB (user space, synced)
    [MOUNT.SPACE.prefix]: mainIdb,    // @ → IDB (shared spaces, synced)
    [MOUNT.INBOX.prefix]: mainIdb,    // > → IDB (inbox, synced)
    [MOUNT.SYS.prefix]:   MemoryBackend(),                                                    // sys/ → RAM only
    [MOUNT.CONF.prefix]:  confStore,                                                          // conf/ → LocalStorage
    [MOUNT.BLOBS.prefix]: IdbBackend({ name: 'quray-blobs', openTimeout: 8_000, txTimeout: 10_000 }), // blobs/ → IDB
    ...options.backends,   // caller can override any mount
  }


  // ── 3. Queue ───────────────────────────────────────────────────────────

  const queue = QuQueue(confStore, {
    storageKey:    'conf/_tasks',
    maxRetries:    5,
    concurrentMax: 3,
    retryDelays:   [1, 2, 5, 10, 30, 60],
  })


  // ── 4. QuDB ────────────────────────────────────────────────────────────

  const db = QuDB({ backends, queue, identity, blobAutoLoadLimit, conflictStrategy })
  await db.init()

  // Persist the local identity backup in conf/ (local-only, never replicated).
  const backup = await identity.exportBackup(passphrase)
  await db._internal.write('conf/identity', backup, 'local')


  // ── 5. Middleware-Plugins ──────────────────────────────────────────────

  const middlewareFlags = { verify: true, sign: true, store: true, dispatch: true, ...options.middleware }
  const pluginCleanupFunctions = []

  if (middlewareFlags.verify)   pluginCleanupFunctions.push(db.use(VerifyPlugin(identity)))
  if (middlewareFlags.access !== false) pluginCleanupFunctions.push(db.use(AccessControlPlugin()))
  if (middlewareFlags.sign)     pluginCleanupFunctions.push(db.use(SignPlugin(identity)))
  if (middlewareFlags.store)    pluginCleanupFunctions.push(db.use(StoreInPlugin({ conflictStrategy })))
  if (middlewareFlags.store)    pluginCleanupFunctions.push(db.use(StoreOutPlugin()))
  if (middlewareFlags.dispatch) pluginCleanupFunctions.push(db.use(DispatchPlugin()))

  for (const pluginFactory of options.plugins ?? []) {
    pluginCleanupFunctions.push(db.use(pluginFactory))
  }


  // ── 6. LocalPeer (me) + PeerMap ───────────────────────────────────────
  //
  // me wraps the active identity as a local peer helper.
  // peers is the reactive registry of known peers derived from QuDB state.

  const me    = await LocalPeer(identity, db)
  const peers = PeerMap(db, identity.pub)



  // ── 7. Net + Transports ────────────────────────────────────────────────

  const net = QuNet({ rateLimits: options.rateLimits ?? {} })

  for (const [transport, name] of options.transports ?? []) {
    net.use(transport, name)
  }


  // ── 8. Sync ────────────────────────────────────────────────────────────

  const sync = QuSync({ db, net, queue, identity, config: { blobAutoLoadLimit, syncOnConnect, queryStore: options.queryStore ?? null } })
  sync.init()

  // Queue init: AFTER sync registers handlers, BEFORE relay connects.
  await queue.init()


  // ── 8b. Presence plugin ────────────────────────────────────────────────
  //
  // Optional. Handles peer.hello / peer.bye / typing without polluting QuSync.
  // Disable with: options.presence: false
  // Access via: qr._.presence

  let presence = null
  if (options.presence !== false) {
    presence = QuPresence({ db, identity })
    presence.attach(sync)
  }


  // ── 9. Connect configured relays ─────────────────────────────────────────
  //
  // Each relay = WsTransport (realtime push) + HttpTransport (diff-sync + blobs).
  // Transport options can be overridden per-plugin: options.ws / options.http
  //
  // Plugin config example:
  //   QuRay.init({ relay: 'wss://...', ws: { pingInterval: 10_000 }, http: { timeout: 30_000 } })

  const relayConnections = []

  for (let i = 0; i < relayConfigurations.length; i++) {
    const rc      = relayConfigurations[i]
    const wsName   = `ws:${i}`
    const httpName = `http:${i}`

    const wsTransport   = WsTransport({ reconnectDelays: [1_000, 2_000, 5_000, 10_000, 30_000], pingInterval: 25_000, ...options.ws })
    const httpTransport = HttpTransport({ timeout: 15_000, retryOn: [429, 502, 503], ...options.http })

    net.use(wsTransport,   wsName)
    net.use(httpTransport, httpName)

    const httpUrl = rc.url.replace(/^wss?:\/\//, p => p === 'wss://' ? 'https://' : 'http://')

    sync.addPeer({
      url:          rc.url,
      type:         PEER_TYPE.RELAY,
      capabilities: ['sync', 'router', 'blobs'],
      label:        rc.label,
      priority:     rc.priority ?? 10,
      transportName: wsName,
      httpUrl,
    })

    await httpTransport.connect(httpUrl).catch(e => { /*DEBUG*/ console.warn('[QuRay] HTTP connect failed (relay offline?):', e.message) })
    await wsTransport.connect(rc.url).catch(e => { /*DEBUG*/ console.warn('[QuRay] WS connect failed:', e.message) })

    // Send initial peer.hello via presence plugin (if active) or bare send
    if (presence) {
      await presence.sendHello(net, wsName)
    } else {
      await wsTransport.send({
        payload: { type: 'peer.hello', from: identity.pub, ts: Date.now(),
          data: { alias: identity.alias, epub: identity.epub } }
      }).catch(e => { /*DEBUG*/ console.warn('[QuRay] peer.hello send failed:', e.message) })
    }

    // Configure Service Worker for background push (primary relay only)
    if (i === 0) sync.configureServiceWorker()

    relayConnections.push({ relay: rc, ws: wsTransport, http: httpTransport, label: rc.label })
  }


  // ── 10. UI modules ─────────────────────────────────────────────────────

  let bindingApi    = null
  let directivesApi = null

  if (binding) {
    registerBindingComponents()
    bindingApi = QuBinding(db)
    bindingApi.init()
  }
  if (ui) {
    registerComponents(db)
  }
  if (directives) {
    registerDirectiveComponents()
    directivesApi = QuDirectives(db)
    directivesApi.init()
  }


  // ── Runtime relay management ───────────────────────────────────────────

  /**
   * Add a relay connection and start it immediately.
   * @param {string|object} urlOrConfig - WebSocket URL or relay config object
   * @returns {Promise<void>}
   * @group QuRay
   * @since 0.1.0
   * @example
   * await qr.addRelay('wss://relay.example.com')
   */
  const addRelay = async (urlOrConfig) => {
    const relay = _toRelayConfig(urlOrConfig)
    if (relayConnections.find(c => c.relay.url === relay.url)) return

    const i          = relayConnections.length
    const wsName     = `ws:${i}`
    const wsT        = WsTransport({ reconnectDelays: [1_000, 2_000, 5_000, 10_000, 30_000], pingInterval: 25_000, ...options.ws })
    const httpT      = HttpTransport({ timeout: 15_000, retryOn: [429, 502, 503], ...options.http })
    const httpUrl    = relay.url.replace(/^wss?:\/\//, p => p === 'wss://' ? 'https://' : 'http://')

    net.use(wsT,  wsName)
    net.use(httpT, `http:${i}`)

    sync.addPeer({
      url: relay.url, type: PEER_TYPE.RELAY,
      capabilities: ['sync', 'router', 'blobs'],
      label: relay.label, priority: relay.priority ?? 10,
      transportName: wsName, httpUrl,
    })

    await httpT.connect(httpUrl).catch(e => { /*DEBUG*/ console.warn('[QuRay] addRelay HTTP connect failed:', e.message) })
    await wsT.connect(relay.url).catch(e => { /*DEBUG*/ console.warn('[QuRay] addRelay WS connect failed:', e.message) })

    if (presence) await presence.sendHello(net, wsName)
    else await wsT.send({ payload: { type: 'peer.hello', from: identity.pub, ts: Date.now(), data: { alias: identity.alias, epub: identity.epub } } }).catch(e => { /*DEBUG*/ console.warn('[QuRay] addRelay peer.hello send failed:', e.message) })

    relayConnections.push({ relay, ws: wsT, http: httpT, label: relay.label })
  }

  const removeRelay = async (url) => {
    const idx = relayConnections.findIndex(connection => connection.relay.url === url)
    if (idx < 0) return
    relayConnections[idx].ws.disconnect()
    sync.removePeer?.(url)
    relayConnections.splice(idx, 1)
  }

  const destroy = async () => {
    queue.stop?.()
    await net.disconnectAll()
    for (const cleanup of pluginCleanupFunctions) cleanup?.()
  }


  // ── Public QuRay instance ──────────────────────────────────────────────

  // ── QuNode — typed helpers over QuDB ─────────────────────────────────────
  // qr.node provides ergonomic node.read/write/watch/list + user profile ops
  // + inbox/send. The shortcuts qr.inbox/send/toPub64 delegate here.
  const node = QuNode({ db, me, net, peers })

  const qr = {
    // Primary API
    db,
    me,
    peers,
    node,
    delivery: db.delivery,   // 6-state delivery tracker for all QuBits
    space: (spaceId) => _createSpaceHandle(db, spaceId),

    // Shortcut convenience methods (delegate to node)
    inbox:   node.inbox,
    send:    node.send,
    toPub64: node.toPub64,

    // Sync shortcuts — most apps need these without digging into qr._
    subscribe:   (...a) => sync.subscribe(...a),
    unsubscribe: (...a) => sync.unsubscribe(...a),
    observe:     (...a) => sync.observe(...a),
    pull:        (...a) => sync.pull(...a),
    remoteQuery: (...a) => sync.remoteQuery(...a),

    // Relay management
    addRelay,
    removeRelay,
    get relays() { return relayConnections.map(connection => ({ url: connection.relay.url, label: connection.label })) },

    // Lifecycle
    destroy,

    // Internal state for plugins, tooling, and debugging
    _: {
      net,
      sync,
      queue,
      presence,
      ui: { binding: bindingApi, directives: directivesApi },
    },

  }

  // Resolve deferred ready() callbacks.
  for (const cb of _readyCallbacks) { try { cb(qr) } catch (e) { /*DEBUG*/ console.warn('[QuRay] ready() callback error:', e) } }
  _readyCallbacks.length = 0
  _instance = qr

  /*DEBUG*/ console.info('[QuRay] init complete. pub64:', me.pub64.slice(0, 12) + '…')
  return qr
}


// ─────────────────────────────────────────────────────────────────────────────
// SPACE HANDLE
//
// qr.space('@uuid') → SpaceHandle
//
// Thin wrapper around db.* that prefixes keys for a single shared space.
// It is a convenience helper, not a separate persistence model.
// ─────────────────────────────────────────────────────────────────────────────

const _createSpaceHandle = (db, spaceId) => {
  const id     = spaceId.startsWith('@') ? spaceId : '@' + spaceId
  const prefix = id + '/'

  // Build a fully qualified storage key inside this shared space.
  const _key = (path) => path ? prefix + path.replace(/^\//, '') : id

  return {
    id,

    // Meta / ACL
    meta: ()                   => db.get(prefix + '~meta'),
    acl:  ()                   => db.get(prefix + '~acl'),

    // Local permission check based on the stored ACL document.
    can: async (pub, right = 'write') => {
      const acl = await db.get(prefix + '~acl')
      if (!acl) return false
      // QuDB wraps value in .data - support both formats
      const d = acl.data ?? acl
      if (right === 'admin') return d.owner === pub
      if (right === 'write') {
        if (d.writers === '*') return true
        if (Array.isArray(d.writers)) return d.writers.includes(pub)
        return d.owner === pub
      }
      return true  // read access is enforced by the relay
    },

    // Storage helpers that delegate to db.* with the shared-space prefix applied.
    get:   (path, opts)       => db.get(_key(path), opts),
    put:   (path, data, opts) => db.put(_key(path), data, opts),
    del:   (path)             => db.del(_key(path)),
    query: (path, opts)       => db.query(_key(path) + (path ? '' : '/'), opts),
    on:    (pattern, fn)      => db.on(prefix + pattern.replace(/^\//, ''), fn),

    // Members
    members: {
      add:    (peer) => db.put(prefix + 'members/' + (peer.pub64 ?? peer.pub), true),
      remove: (pub)  => db.del(prefix + 'members/' + pub),
      list:   async () => {
        const qubits = await db.query(prefix + 'members/')
        return qubits.map(q => q.key.slice((prefix + 'members/').length))
      },
    },
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// RELAY-NORMALISIERUNG
//
// Alle Eingabeformate → [{ url, label, priority }]
//   relay:  'wss://a.com'
//   relays: 'wss://a.com'
//   relays: ['wss://a.com', 'wss://b.com']
//   relays: [{ url, label?, priority? }, ...]
//   relays: 'wss://a.com, wss://b.com'    (komma-getrennt, für HTML data-Attribut)
// ─────────────────────────────────────────────────────────────────────────────

const _labelFromUrl = (url) => { try { return new URL(url).hostname } catch { return url } }

const _toRelayConfig = (entry) => {
  if (typeof entry === 'string')
    return { url: entry, label: _labelFromUrl(entry), priority: 10 }
  return { label: _labelFromUrl(entry.url), priority: 10, ...entry }
}

const _normalizeRelays = (options) => {
  const raw = options.relays ?? options.relay ?? options.relayUrl ?? null
  if (!raw) return []
  if (typeof raw === 'string')
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(_toRelayConfig)
  if (!Array.isArray(raw)) return [_toRelayConfig(raw)]
  return raw.map(_toRelayConfig)
}


// ─────────────────────────────────────────────────────────────────────────────
// SERVICE WORKER CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const _configureServiceWorker = (relayUrl, ownerPub, options = {}) => {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.ready.then(reg => {
    reg.active?.postMessage({
      type:             'sw.setConfig',
      relayUrl:         relayUrl.replace(/^ws/, 'http'),
      pub:              ownerPub,
      // Mirror the app database name so the service worker can open the same IDB.
      dbName:           'quray-' + ownerPub.slice(0, 12).replace(/[+/=]/g, '_'),
      periodicSync:     options.periodicSync     ?? false,
      periodicInterval: options.periodicInterval ?? 15 * 60 * 1000,
    })
  }).catch(e => { /*DEBUG*/ console.warn('[QuRay] SW config failed:', e.message) })
}


// ─────────────────────────────────────────────────────────────────────────────
// DECLARATIVE MODE
//
// Automatically runs when quray.js is loaded via a <script> tag.
//   <script src="dist/quray.js" data-relay="wss://…" data-ui></script>
// ─────────────────────────────────────────────────────────────────────────────

const ready    = (cb) => { if (_instance) { try { cb(_instance) } catch (e) { /*DEBUG*/ console.warn('[QuRay] ready() callback error:', e) } } else _readyCallbacks.push(cb) }
const instance = () => _instance

const _autoInit = () => {
  const scripts = document.querySelectorAll('script[src*="quray"]')
  const tag     = scripts[scripts.length - 1]
  if (!tag) return

  const relays  = tag.dataset.relays || tag.dataset.relay || null
  const alias   = tag.dataset.alias  || ''
  const hasUI   = tag.hasAttribute('data-ui')

  if (!relays && !hasUI && !tag.hasAttribute('data-binding') && !tag.hasAttribute('data-directives')) return

  const run = () => init({
    relays,
    alias,
    ui:         hasUI,
    binding:    !hasUI && tag.hasAttribute('data-binding'),
    directives: !hasUI && tag.hasAttribute('data-directives'),
  }).catch(error => console.error('[QuRay] auto-init failed:', error))

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run)
  else run()
}


// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

const QuRay = {
  // Entry points
  init,
  ready,
  instance,

  // Core building blocks for custom setups without QuRay.init()
  Identity,
  QuDB,
  QuQueue,
  QuNet,
  QuSync,
  QuBinding,
  QuDirectives,
  LocalPeer,
  PeerMap,

  // Backends
  IdbBackend,
  MemoryBackend,
  LocalStorageBackend,

  // Browser-safe transports
  HttpTransport,
  WsTransport,

  // Plugins
  SignPlugin,
  VerifyPlugin,
  StoreInPlugin,
  StoreOutPlugin,
  DispatchPlugin,
  AccessControlPlugin,

  // UI
  registerComponents,
  registerBindingComponents,
  registerDirectiveComponents,
  registerDirective,

  // Utilities
  KEY,
  PushHelper,
}

export default QuRay
export {
  init, ready, instance,
  PushHelper,
  Identity, QuDB, QuQueue, QuNet, QuSync, QuBinding, QuDirectives, LocalPeer, PeerMap,
  IdbBackend, MemoryBackend, LocalStorageBackend,
  HttpTransport, WsTransport,
  SignPlugin, VerifyPlugin, StoreInPlugin, StoreOutPlugin, DispatchPlugin, AccessControlPlugin,
  registerComponents, registerBindingComponents, registerDirectiveComponents, registerDirective,
  KEY,
}

// Auto-init when loaded via <script>
if (typeof document !== 'undefined') _autoInit()
