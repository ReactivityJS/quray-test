// ════════════════════════════════════════════════════════════════════════════
// QuRay — core/presence.js
// Optional presence and typing plugin.
//
// Handles ephemeral peer-state messages that should NOT be persisted as
// regular QuBits or go through the sync queue:
//   peer.hello  — peer came online (write to sys/peers/...)
//   peer.bye    — peer went offline (remove from sys/peers/...)
//   typing      — typing indicator with 4s auto-expire (write to conf/typing/...)
//
// Usage:
//   import { QuPresence } from './core/presence.js'
//   const presence = QuPresence({ db, identity })
//   presence.attach(sync)   // registers type handlers with QuSync
//   presence.detach()       // unregisters handlers
//
// This module hooks into QuSync.registerHandler() so that QuSync itself has
// no presence logic. All QuSync knows is: "here is a qubit, handle it."
//
// peer.hello/bye flow:
//   relay WS → QuSync._processIncoming → QuPresence._handlePeerHello
//            → db.sync.processIn (IN pipeline) → db.on('sys/peers/**') fires
//
// typing flow:
//   relay WS → QuSync._processIncoming → QuPresence._handleTyping
//            → db.sync.processIn → db.on('conf/typing/**') fires
//            → setTimeout(4000) → db.del (hard) → del event fires
//
// Why processIn instead of rawWrite + emitPresence?
//   processIn runs the full IN pipeline (StoreIn + DispatchIn), which means
//   the reactive db.on() system fires automatically — no manual event emission
//   required. The presence module stays decoupled from the internal EventBus.
// ════════════════════════════════════════════════════════════════════════════

import { QUBIT_TYPE, KEY }  from './qubit.js'
import { pub64 }            from './identity.js'
import { EventBus }         from './events.js'


/**
 * Ephemeral presence plugin.
 *
 * @param {object} options
 * @param {QuDBInstance}   options.db       - QuDB instance
 * @param {IdentityInstance} [options.identity] - local identity (to skip own presence)
 * @returns {QuPresenceInstance} - { attach, detach, sendHello, sendBye, sendTyping }
 * @group Plugin
 * @since 0.2.0
 *
 * @example
 * // Wire up after init:
 * const presence = QuPresence({ db: qr.db, identity: qr.me })
 * presence.attach(qr.sync)
 *
 * // React to peer presence changes:
 * const off = qr.db.on('sys/peers/**', (q, { event }) => {
 *   if (event === 'del') console.log('peer left:', q?.data?.pub)
 *   else console.log('peer online:', q?.data?.alias)
 * })
 *
 * // React to typing:
 * const off = qr.db.on(`conf/typing/${spaceId}/**`, (q, { event }) => {
 *   if (event === 'put') showTyping(q.data.from)
 *   else hideTyping(q.data?.from)
 * })
 */
const QuPresence = ({ db, identity }) => {
  let _offHandlers = []

  // Internal event bus for presence events.
  // Plugins (e.g. WebRtcPresencePlugin) subscribe here instead of stealing
  // the sync.registerHandler('peer.hello') slot.
  //
  //   off = presence.on('peerOnline',  ({ pub, alias, epub }) => {})
  //   off = presence.on('peerOffline', ({ pub }) => {})
  const _bus = EventBus({ separator: '/' })

  /**
   * Subscribe to presence events without intercepting raw QuBit messages.
   *
   * @param {'peerOnline'|'peerOffline'} event
   * @param {function} fn
   * @returns {function} off
   * @group Plugin
   *
   * @example
   * const off = presence.on('peerOnline', ({ pub, alias }) => {
   *   console.log('online:', alias)
   * })
   */
  const on = (event, fn) => _bus.on(event, fn)



  // ── Incoming: peer.hello ───────────────────────────────────────────────

  const _handlePeerHello = async (qubit) => {
    const pub = qubit.from ?? qubit.data?.from
    if (!pub) return
    if (pub === identity?.pub) return  // skip own hello

    const peerKey = KEY.peer(pub64(pub))
    const entry = {
      key:      peerKey,
      id:       peerKey,
      type:     'data',
      from:     pub,
      ts:       Date.now(),
      _status:  'synced',
      _mine:    false,
      _localTs: Date.now(),
      data:     {
        pub,
        alias:  qubit.data?.alias ?? null,
        epub:   qubit.data?.epub  ?? null,
        online: true,
      },
      enc: null, refs: [], order: null, sig: null, hash: null,
    }

    // processIn runs StoreIn (writes to sys/ memory backend) + DispatchIn (fires db.on)
    await db.sync.processIn(entry, 'presence').catch(() => {})

    // Emit on presence bus so other plugins can react (e.g. WebRtcPresencePlugin)
    await _bus.emit('peerOnline', { pub, alias: qubit.data?.alias ?? null, epub: qubit.data?.epub ?? null })
  }


  // ── Incoming: peer.bye ────────────────────────────────────────────────

  const _handlePeerBye = async (qubit) => {
    const pub = qubit.from ?? qubit.data?.from
    if (!pub) return

    const peerKey = KEY.peer(pub64(pub))
    // Hard-delete from sys/ (memory — no tombstone needed, ephemeral)
    await db.del(peerKey, { sync: false, hard: true }).catch(() => {})

    // Emit on presence bus
    await _bus.emit('peerOffline', { pub })
  }


  // ── Incoming: typing ──────────────────────────────────────────────────

  const _typingTimers = new Map()  // `${space}/${from}` → timerId

  const _handleTyping = async (qubit) => {
    const from  = qubit.from ?? qubit.data?.from
    const space = qubit.data?.space ?? qubit.space
    if (!from || !space) return
    if (from === identity?.pub) return  // skip own typing

    const tk = `conf/typing/${space}/${from}`
    const typingQubit = {
      key:      tk,
      id:       tk,
      type:     'data',
      from,
      ts:       Date.now(),
      _status:  'local',
      _mine:    false,
      _localTs: Date.now(),
      data:     { from, space, ts: Date.now() },
      enc: null, refs: [], order: null, sig: null, hash: null,
    }

    await db.sync.processIn(typingQubit, 'presence').catch(() => {})

    // Reset 4-second auto-expire timer
    const timerKey = `${space}/${from}`
    clearTimeout(_typingTimers.get(timerKey))
    const timer = setTimeout(() => {
      _typingTimers.delete(timerKey)
      db.del(tk, { sync: false, hard: true }).catch(() => {})
    }, 4_000)
    _typingTimers.set(timerKey, timer)
  }


  // ── Outgoing helpers ──────────────────────────────────────────────────

  /**
   * Broadcast a peer.hello to connected peers (e.g. on connect or identity change).
   * @param {QuNetInstance} net
   * @param {string} [via] - transport name to use (default: all connected transports)
   */
  const sendHello = async (net, via = null) => {
    if (!identity?.pub) return
    const pkt = {
      payload: {
        type: QUBIT_TYPE.PEER_HELLO,
        from: identity.pub,
        ts:   Date.now(),
        data: { alias: identity.alias ?? null, epub: identity.epub ?? null },
      }
    }
    await net.send(pkt, via ? { via } : {}).catch(() => {})
  }

  /**
   * Broadcast a peer.bye (e.g. on explicit disconnect or beforeunload).
   * @param {QuNetInstance} net
   * @param {string} [via]
   */
  const sendBye = async (net, via = null) => {
    if (!identity?.pub) return
    const pkt = {
      payload: { type: QUBIT_TYPE.PEER_BYE, from: identity.pub, ts: Date.now() }
    }
    await net.send(pkt, via ? { via } : {}).catch(() => {})
  }

  /**
   * Send a typing indicator for the given space.
   * @param {QuNetInstance} net
   * @param {string} spaceId
   * @param {string} [via]
   */
  const sendTyping = async (net, spaceId, via = null) => {
    if (!identity?.pub || !spaceId) return
    const pkt = {
      payload: {
        type: QUBIT_TYPE.TYPING,
        from: identity.pub,
        ts:   Date.now(),
        data: { space: spaceId },
      }
    }
    await net.send(pkt, via ? { via } : {}).catch(() => {})
  }


  // ── Attach / Detach ───────────────────────────────────────────────────

  /**
   * Register this plugin's type handlers with a QuSync instance.
   * Must be called before any incoming messages are processed.
   *
   * @param {QuSyncInstance} sync
   */
  const attach = (sync) => {
    _offHandlers.push(sync.registerHandler(QUBIT_TYPE.PEER_HELLO, _handlePeerHello))
    _offHandlers.push(sync.registerHandler(QUBIT_TYPE.PEER_BYE,   _handlePeerBye))
    _offHandlers.push(sync.registerHandler(QUBIT_TYPE.TYPING,      _handleTyping))
  }

  /**
   * Unregister all type handlers.
   */
  const detach = () => {
    for (const off of _offHandlers) off?.()
    _offHandlers = []
    for (const timer of _typingTimers.values()) clearTimeout(timer)
    _typingTimers.clear()
  }


  return {
    attach,
    detach,
    sendHello,
    sendBye,
    sendTyping,
    on,   // presence.on('peerOnline'|'peerOffline', fn) → off
  }
}


export { QuPresence }
