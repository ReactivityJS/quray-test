// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/index.js
// MessengerPlugin — main entry point.
//
// Composes MessengerStore + CallManager into a single plugin that follows
// the QuRay plugin convention:
//   const messenger = MessengerPlugin({ db, identity, net, sync, ... })
//   messenger.attach(sync)   // register handlers
//   messenger.detach()       // cleanup
//
// The plugin intentionally works with the raw demo-peer shape
// { db, identity, net, sync, presence? } so it can be used from both
// the QuRay.init() path and the createDemoPair() test path.
//
// Usage:
//   // Full QuRay.init path:
//   const messenger = MessengerPlugin({ db: qr.db, identity: qr.me,
//     net: qr._.net, presence: qr._.presence })
//   messenger.attach(qr._.sync)
//
//   // Demo / test path:
//   const messenger = MessengerPlugin({ db: alice.db, identity: alice.identity,
//     net: alice.net })
//   messenger.attach(alice.sync)
//
//   // Enable audio/video calls (optional):
//   import { WebRtcTransport, WebRtcPresencePlugin } from '../../transports/webrtc.js'
//   const webrtc = WebRtcTransport({ iceServers: [...] })
//   alice.net.use(webrtc, 'webrtc')
//   const webrtcPlugin = WebRtcPresencePlugin({ net: alice.net, webrtc, identity: alice.identity })
//   webrtcPlugin.attach(alice.sync)
//   const messenger = MessengerPlugin({ ..., webrtc })
//   messenger.attach(alice.sync)
// ════════════════════════════════════════════════════════════════════════════

import { MessengerStore }  from './store.js'
import { CallManager }     from './calls.js'


/**
 * MessengerPlugin — factory that creates a store + optional call manager.
 *
 * @param {object} options
 * @param {QuDBInstance}              options.db          — QuDB instance
 * @param {IdentityInstance}          options.identity    — local identity
 * @param {QuNetInstance}             options.net         — QuNet instance
 * @param {QuPresenceInstance}        [options.presence]  — QuPresence (optional)
 * @param {WebRtcTransportInstance}   [options.webrtc]    — WebRtcTransport (optional, enables calls)
 * @returns {MessengerPluginInstance}
 *
 * @example
 * const messenger = MessengerPlugin({ db, identity, net })
 * messenger.attach(sync)
 *
 * // Store API
 * const convId = await messenger.store.getOrCreateDM(bobPub)
 * await messenger.store.sendMessage(convId, { text: 'Hello!' })
 *
 * // Call API (requires webrtc option)
 * await messenger.calls.call(bobPub, { audio: true })
 */
const MessengerPlugin = ({ db, identity, net, presence = null, webrtc = null }) => {
  const store = MessengerStore({ db, identity })
  const calls = webrtc ? CallManager({ db, identity, webrtc, net }) : null

  /**
   * Register all sync handlers.
   * Call this once after QuSync is initialized.
   *
   * @param {QuSyncInstance} sync
   */
  const attach = (sync) => {
    store.attach(sync)
    calls?.attach(sync)
  }

  /**
   * Unregister all handlers and clean up timers.
   */
  const detach = () => {
    store.detach()
    calls?.detach()
  }

  return {
    store,
    calls,   // null if webrtc not provided
    attach,
    detach,
  }
}


export { MessengerPlugin }
export { MessengerStore }  from './store.js'
export { CallManager }     from './calls.js'
export { MSG_TYPE, CALL_TYPE, CALL_STATE, CONV_TYPE, MSG_KEY, createMessage } from './types.js'
