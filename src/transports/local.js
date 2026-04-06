// ─────────────────────────────────────────────────────────────────────────────
// QuRay — transports/local.js
//
// LocalBridgeTransport: an in-memory transport that connects two local peers.
// No network, no ports, no serialization overhead.
// Perfect for unit tests and local multi-peer scenarios.
//
// Usage:
//   const [a, b] = LocalBridge()       // paired transports
//   netA.use(a, 'local')
//   netB.use(b, 'local')
//   await a.connect()                  // both sides connect instantly
//
// ─────────────────────────────────────────────────────────────────────────────

import { Signal } from '../core/events.js'
import { TRANSPORT_STATE } from '../core/net.js'

/**
 * Create a pair of linked local transports.
 * Messages sent on A arrive at B and vice versa.
 * Supports configurable delay and packet loss for resilience testing.
 *
 * @param {object} opts
 * @param {number} [opts.delay=0]        - Delivery delay in ms
 * @param {number} [opts.loss=0]         - Packet loss probability 0-1
 * @param {boolean} [opts.debug=false]   - Log messages to console
 * @returns {[Transport, Transport]}     - [sideA, sideB]
 */
const LocalBridge = (opts = {}) => {
  const delay  = opts.delay  ?? 0
  const loss   = opts.loss   ?? 0
  const debug  = opts.debug  ?? false

  const _log = (...args) => { if (debug) console.log('[LocalBridge]', ...args) }

  const _makeTransport = (label) => {
    let   _peer     = null   // the other transport
    const _handlers = new Map()
    const state$    = Signal(TRANSPORT_STATE.DISCONNECTED)

    const _emit = async (event, ...args) => {
      const fn = _handlers.get(event)
      if (fn) await fn(...args)
    }

    // Called by the other side to deliver a message
    const _deliver = async (packet) => {
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      if (loss > 0 && Math.random() < loss) { _log(label, 'packet lost'); return }
      _log(label, '← recv', packet?.payload?.type ?? '?')
      await _emit('message', packet)
    }

    const connect = async () => {
      if (state$.get() === TRANSPORT_STATE.CONNECTED) return
      await state$.set(TRANSPORT_STATE.CONNECTING)
      await state$.set(TRANSPORT_STATE.CONNECTED)
      await _emit('connect')
      _log(label, 'connected')
      // If peer is waiting, connect it too
      if (_peer && _peer.state$.get() !== TRANSPORT_STATE.CONNECTED) {
        await _peer._selfConnect()
      }
    }

    const _selfConnect = async () => {
      if (state$.get() === TRANSPORT_STATE.CONNECTED) return
      await state$.set(TRANSPORT_STATE.CONNECTING)
      await state$.set(TRANSPORT_STATE.CONNECTED)
      await _emit('connect')
      _log(label, 'peer-connected')
    }

    const disconnect = async () => {
      await state$.set(TRANSPORT_STATE.DISCONNECTED)
      await _emit('disconnect', { code: 1000, reason: 'local disconnect' })
      _log(label, 'disconnected')
    }

    const send = async (packet) => {
      if (state$.get() !== TRANSPORT_STATE.CONNECTED) {
        _log(label, 'send skipped — not connected')
        return false
      }
      if (!_peer || _peer.state$.get() !== TRANSPORT_STATE.CONNECTED) {
        _log(label, 'send skipped — peer not connected')
        return false
      }
      _log(label, '→ send', packet?.payload?.type ?? '?')
      await _peer._deliver(packet)
      return true
    }

    const on  = (event, fn) => { _handlers.set(event, fn); return () => _handlers.delete(event) }
    const off = (event)     => _handlers.delete(event)

    return { name: 'local-' + label, connect, disconnect, send, on, off, state$,
             get state() { return state$ }, _deliver, _selfConnect,
             _link: (other) => { _peer = other } }
  }

  const sideA = _makeTransport('A')
  const sideB = _makeTransport('B')
  sideA._link(sideB)
  sideB._link(sideA)

  return [sideA, sideB]
}


/**
 * LocalRelay: in-memory relay server for testing.
 *
 * Stores QuBits, routes between connected peers, supports diffSync.
 * Mirrors the behavior of relay.js but runs entirely in-memory.
 *
 * Usage:
 *   const relay = LocalRelay()
 *   const { transport: ta, connect: ca } = relay.addPeer('alice-pub')
 *   netAlice.use(ta, 'relay')
 *   await ca()
 */
const LocalRelay = (opts = {}) => {
  const debug = opts.debug ?? false
  const _log  = (...a) => { if (debug) console.log('[LocalRelay]', ...a) }

  // Storage: key → qubit
  const _store = new Map()

  // Connected peers: pub → { transport, label }
  const _peers = new Map()

  // Types that should not be stored
  const NO_STORE = new Set(['peer.hello','peer.bye','blob.ready','typing',
                            'webrtc.offer','webrtc.answer','webrtc.ice','webrtc.hangup',
                            'msg.receipt','ping','pong'])

  const _broadcast = async (packet, skipPub = null) => {
    for (const [pub, peer] of _peers) {
      if (pub === skipPub) continue
      await peer.transport.send(packet).catch(() => {})
    }
  }

  const _sendTo = async (pub, packet) => {
    const peer = _peers.get(pub)
    if (!peer) return false
    await peer.transport.send(packet).catch(() => {})
    return true
  }

  const _storeQubit = (qubit) => {
    if (!qubit?.key) return
    if (NO_STORE.has(qubit.type)) return
    _store.set(qubit.key, qubit)
    _log('store', qubit.key.slice(0, 40))
  }

  const _handleMessage = async (fromPub, packet) => {
    const { payload: q, to, ttl = 0 } = packet ?? {}
    if (!q?.type) return

    // Store if persistent type
    if (q.key) _storeQubit(q)

    // Route: targeted or broadcast
    if (to) {
      const ok = await _sendTo(to, { ...packet, ttl: ttl - 1 })
      _log('route.dm', q.type, '→', to.slice(0, 12), ok ? '✓' : 'offline')
      // Store inbox copy for offline delivery
      if (!ok && q.key && to.startsWith('>') || true) {
        // Already stored above
      }
    } else {
      await _broadcast({ ...packet, ttl: ttl - 1 }, fromPub)
      _log('route.bc', q.type, 'peers=', _peers.size)
    }
  }

  // Create a transport side for a peer to connect to this relay
  const addPeer = (pubOrLabel) => {
    const label = pubOrLabel ?? ('peer-' + _peers.size)
    const [peerSide, relaySide] = LocalBridge({ debug: false })

    // Relay listens on its side
    relaySide.on('connect', async () => {
      _log('peer connected:', label.slice(0, 16))
    })

    relaySide.on('message', async (packet) => {
      const q = packet?.payload ?? packet
      if (q?.type === 'peer.hello') {
        const pub = q.from ?? label
        _peers.set(pub, { transport: relaySide, label })
        _log('peer.hello from', pub.slice(0, 16))
        // Send peers list back
        const peerList = [..._peers.entries()]
          .filter(([p]) => p !== pub)
          .map(([p]) => ({ pub: p }))
        await relaySide.send({ payload: { type: 'peers.list', data: peerList } })
        // Broadcast peer.hello to others
        await _broadcast({ ttl: 3, payload: q }, pub)
        return
      }
      if (q?.type === 'peer.bye') {
        const pub = q.from ?? label
        _peers.delete(pub)
        await _broadcast({ payload: { type: 'peer.bye', from: pub } }, pub)
        return
      }
      await _handleMessage(q?.from ?? label, packet)
    })

    relaySide.on('disconnect', async () => {
      // Remove disconnected peer
      for (const [pub, p] of _peers) {
        if (p.transport === relaySide) {
          _peers.delete(pub)
          await _broadcast({ payload: { type: 'peer.bye', from: pub } })
          break
        }
      }
    })

    const connect = async () => {
      await relaySide.connect()
      await peerSide.connect()
    }

    return { transport: peerSide, connect }
  }

  // diffSync: return keys peer is missing for a given prefix
  const diffSync = async (peerKnownKeys, prefix = '') => {
    const relayKeys = [..._store.keys()].filter(k => !prefix || k.startsWith(prefix))
    const missing   = relayKeys.filter(k => !peerKnownKeys.has(k))
    return missing.map(k => _store.get(k)).filter(Boolean)
  }

  // HTTP-like sync API for tests
  const api = {
    // GET /api/sync?prefix=... (keys only)
    getKeys: (prefix = '') =>
      [..._store.keys()].filter(k => !prefix || k.startsWith(prefix)),

    // GET /api/sync with full qubit data
    getMany: (keys) => keys.map(k => _store.get(k)).filter(Boolean),

    // GET single qubit
    get: (key) => _store.get(key) ?? null,

    // Store a qubit directly (for test setup)
    put: (qubit) => _storeQubit(qubit),

    // DiffSync: deliver missing qubit to a peer by pub
    diffSyncTo: async (pub, prefix = '') => {
      const peer = _peers.get(pub)
      if (!peer) return 0
      const stored = [..._store.values()].filter(q => !prefix || q.key?.startsWith(prefix))
      let sent = 0
      for (const q of stored) {
        await peer.transport.send({ payload: q })
        sent++
      }
      return sent
    },
  }

  return {
    addPeer,
    api,
    get size()  { return _store.size },
    get peers() { return _peers.size },
    clear:       () => _store.clear(),
    has:         (key) => _store.has(key),
    inspect:     (key) => _store.get(key),
  }
}


export { LocalBridge, LocalRelay, TRANSPORT_STATE }
