/**
 * @module quray-sync
 * @group QuRay
 * @description
 * Full QuRay sync bundle without UI components. Includes P2P sync, relay
 * connection, peer registry, and all core features. ~59KB gz.
 *
 * Use this when building a custom UI with your own component library.
 *
 * @example
 * import { init, KEY, PeerMap } from './dist/quray-sync.js'
 *
 * const qr = await init({ relay: 'wss://relay.example.com' })
 * // Same API as full QuRay.init() — just without registerComponents()
 */
// QuRay Sync — full P2P sync without UI components
export * from './core-entry.js'
export { SignPlugin }        from './plugins/sign.js'
export { VerifyPlugin }      from './plugins/verify.js'
export { QuNet }             from './core/net.js'
export { QuSync, PEER_TYPE, SYNC_TASK } from './core/sync.js'
export { QuPresence }        from './core/presence.js'
export { MOUNT, mountFor, isSyncable, isLocalOnly, LOCAL_ONLY_RE } from './core/mounts.js'
export { QuQueue }           from './core/queue.js'
export { PeerMap,
         LocalPeer }         from './core/peers.js'
export { WsTransport }       from './transports/ws.js'
export { HttpTransport }     from './transports/http.js'
export { NodeRelayTransport } from './transports/node-relay.js'
export { createRelayPeer }    from './relay/peer.js'
export { createReplicaDb }    from './relay/replica-db.js'
// Default export: same init() as full QuRay but no UI
// NOTE: importing quray.js pulls static UI imports (components.js etc.)
// which reference DOM APIs. For Node.js / relay use, import core modules directly:
//   import { QuDB } from './src/core/db.js'
//   import { FsBackend } from './src/backends/fs.js'
export { init, ready }       from './quray.js'
