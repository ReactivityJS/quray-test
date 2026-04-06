// ════════════════════════════════════════════════════════════════════════════
// QuRay — transports/webrtc.js
// WebRTC Transport Plugin.
//
// ┌─ What this plugin adds ────────────────────────────────────────┐
// │  Data channel:  send/receive QuBits directly peer-to-peer       │
// │  Audio/Video:   optional media streams via addTrack/removeTrack  │
// │  Signaling:     peer.hello triggers offer → answer → ICE via relay│
// └────────────────────────────────────────────────────────────────┘
//
// ┌─ Hook points ───────────────────────────────────────────────────┐
// │  sync.registerHandler('webrtc.offer')   — incoming SDP offer   │
// │  sync.registerHandler('webrtc.answer')  — incoming SDP answer  │
// │  sync.registerHandler('webrtc.ice')     — incoming ICE candidate│
// │                                                                 │
// │  net.use(WebRtcTransport(...), 'webrtc') — register as transport│
// │                                                                 │
// │  The transport is identified by net by capability:             │
// │    { p2p: true, realtime: true, streaming: true }              │
// └────────────────────────────────────────────────────────────────┘
//
// Usage:
//   import { WebRtcTransport, WebRtcPresencePlugin } from './transports/webrtc.js'
//
//   // Add transport to QuNet
//   const webrtc = WebRtcTransport({ iceServers: [...] })
//   qr._.net.use(webrtc, 'webrtc')
//
//   // Register signaling handlers with QuSync
//   const webrtcPlugin = WebRtcPresencePlugin({ net: qr._.net, webrtc, identity: qr.me })
//   webrtcPlugin.attach(qr._.sync)
//
//   // Access audio/video features — not in Core, only on this transport
//   const stream = await webrtc.startMedia({ audio: true, video: true })
//   webrtc.addStream(peerId, stream)
//
// This module depends on:
//   - browser RTCPeerConnection / RTCDataChannel
//   - WebRTC signaling via existing relay transport (webrtc.offer/answer/ice QuBits)
//   - No changes to QuDB, QuSync, or QuNet internals
// ════════════════════════════════════════════════════════════════════════════

import { Signal } from '../core/events.js'

// TRANSPORT_STATE is re-exported from QuNet to keep transports self-contained.
// Transports should never import QuNet directly to avoid circular dependencies.
const TRANSPORT_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
  ERROR:        'error',
}

const QUBIT_TYPE_WEBRTC = {
  OFFER:  'webrtc.offer',
  ANSWER: 'webrtc.answer',
  ICE:    'webrtc.ice',
}


// ─────────────────────────────────────────────────────────────────────────────
// WebRtcTransport
//
// Implements the standard QuNet transport interface:
//   { connect, disconnect, send, on, state, capabilities }
//
// Additional methods (WebRTC-specific, not in core interface):
//   startMedia(constraints)          → MediaStream
//   stopMedia()
//   addStream(peerId, stream)        → void (attaches to peer connection)
//   removeStream(peerId, stream)     → void
//   getRemoteStream(peerId)          → MediaStream | null
//   onMediaStream(fn)                → off() — fires when remote track arrives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebRTC transport plugin for QuNet.
 * Provides P2P data channels (sync) and optional audio/video streams.
 *
 * @param {object} options
 * @param {RTCIceServer[]} [options.iceServers] - STUN/TURN servers
 * @param {boolean}        [options.debug=false]
 * @returns {WebRtcTransportInstance}
 */
const WebRtcTransport = (options = {}) => {
  const _iceServers  = options.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }]
  const _debug       = options.debug ?? false
  const _log         = (...a) => { if (_debug) console.log('[WebRTC]', ...a) }

  const state$    = Signal(TRANSPORT_STATE.DISCONNECTED)
  const _handlers = new Map()   // event → [fn, ...]
  const _peers    = new Map()   // peerId → RTCPeerConnection
  const _channels = new Map()   // peerId → RTCDataChannel
  const _streams  = new Map()   // peerId → MediaStream (remote)
  let   _localStream  = null


  // ── Event emitter ────────────────────────────────────────────────────────

  const _emit = async (event, ...args) => {
    for (const fn of (_handlers.get(event) ?? [])) {
      try { await fn(...args) } catch (e) { _log('handler error', event, e) }
    }
  }

  const on = (event, fn) => {
    if (!_handlers.has(event)) _handlers.set(event, [])
    _handlers.get(event).push(fn)
    return () => {
      const list = _handlers.get(event)
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) }
    }
  }


  // ── RTCPeerConnection factory ─────────────────────────────────────────────

  const _createPeerConnection = (peerId) => {
    if (_peers.has(peerId)) return _peers.get(peerId)

    const pc = new RTCPeerConnection({ iceServers: _iceServers })
    _peers.set(peerId, pc)

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return
      // ICE candidates are sent via the relay signaling channel (not this transport)
      _emit('signal', {
        type: QUBIT_TYPE_WEBRTC.ICE,
        to:   peerId,
        data: { candidate: candidate.toJSON() },
      })
    }

    pc.ondatachannel = ({ channel }) => {
      _setupDataChannel(peerId, channel)
    }

    pc.ontrack = ({ streams }) => {
      const stream = streams[0]
      if (!stream) return
      _streams.set(peerId, stream)
      _log('remote track from', peerId.slice(0, 12))
      _emit('mediaStream', { peerId, stream })
    }

    pc.onconnectionstatechange = () => {
      _log('connection state', peerId.slice(0, 12), pc.connectionState)
      if (pc.connectionState === 'connected') {
        state$.set(TRANSPORT_STATE.CONNECTED)
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        _peers.delete(peerId)
        _channels.delete(peerId)
        if (_peers.size === 0) state$.set(TRANSPORT_STATE.DISCONNECTED)
      }
    }

    // Attach local media tracks if already streaming
    if (_localStream) {
      for (const track of _localStream.getTracks()) pc.addTrack(track, _localStream)
    }

    return pc
  }

  const _setupDataChannel = (peerId, channel) => {
    _channels.set(peerId, channel)
    channel.onmessage = async ({ data }) => {
      try {
        const packet = JSON.parse(data)
        _log('← data', peerId.slice(0, 12), packet?.payload?.type ?? '?')
        await _emit('message', packet, { transport: 'webrtc', peerId })
      } catch {}
    }
    channel.onopen  = () => { _log('data channel open', peerId.slice(0, 12)); state$.set(TRANSPORT_STATE.CONNECTED) }
    channel.onclose = () => { _log('data channel closed', peerId.slice(0, 12)); _channels.delete(peerId) }
  }


  // ── Offer / Answer / ICE (called by signaling plugin) ────────────────────

  const handleOffer = async (peerId, sdp) => {
    const pc      = _createPeerConnection(peerId)
    await pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    _log('→ answer to', peerId.slice(0, 12))
    return answer.sdp
  }

  const handleAnswer = async (peerId, sdp) => {
    const pc = _peers.get(peerId)
    if (!pc) return
    await pc.setRemoteDescription({ type: 'answer', sdp })
    _log('← answer from', peerId.slice(0, 12))
  }

  const handleIce = async (peerId, candidate) => {
    const pc = _peers.get(peerId)
    if (!pc) return
    await pc.addIceCandidate(new RTCIceCandidate(candidate))
  }

  const initiateOffer = async (peerId) => {
    const pc      = _createPeerConnection(peerId)
    const channel = pc.createDataChannel('quray', { ordered: true })
    _setupDataChannel(peerId, channel)
    state$.set(TRANSPORT_STATE.CONNECTING)
    const offer  = await pc.createOffer()
    await pc.setLocalDescription(offer)
    _log('→ offer to', peerId.slice(0, 12))
    return offer.sdp
  }


  // ── QuNet transport interface ─────────────────────────────────────────────

  const connect = async () => {
    // WebRTC connection is peer-initiated, not URL-based.
    // connect() is a no-op; connections are established via signaling.
    state$.set(TRANSPORT_STATE.CONNECTING)
  }

  const disconnect = async () => {
    for (const [peerId, pc] of _peers) {
      _emit('signal', { type: QUBIT_TYPE_WEBRTC.ICE, to: peerId, data: null })
      pc.close()
    }
    _peers.clear()
    _channels.clear()
    state$.set(TRANSPORT_STATE.DISCONNECTED)
  }

  const send = async (packet, opts = {}) => {
    const targetId = opts.to ?? packet?.to ?? null
    const data     = JSON.stringify(packet)

    if (targetId) {
      const channel = _channels.get(targetId)
      if (channel?.readyState === 'open') { channel.send(data); return true }
      return false
    }

    // Broadcast to all open data channels
    let sent = false
    for (const channel of _channels.values()) {
      if (channel.readyState === 'open') { channel.send(data); sent = true }
    }
    return sent
  }

  const capabilities = {
    p2p:       true,
    realtime:  true,
    streaming: true,    // audio/video streams available
    background: false,
    maxPacket:  256 * 1024,
  }


  // ── Audio / Video (WebRTC-specific, not in Core interface) ────────────────

  /**
   * Start local media capture. Adds tracks to all existing peer connections.
   * @param {MediaStreamConstraints} constraints
   * @returns {Promise<MediaStream>}
   */
  const startMedia = async (constraints = { audio: true, video: false }) => {
    _localStream = await navigator.mediaDevices.getUserMedia(constraints)
    // Add tracks to existing connections
    for (const pc of _peers.values()) {
      for (const track of _localStream.getTracks()) pc.addTrack(track, _localStream)
    }
    _log('local media started', _localStream.getTracks().map(t => t.kind))
    return _localStream
  }

  /** Stop all local media tracks. */
  const stopMedia = () => {
    if (!_localStream) return
    _localStream.getTracks().forEach(t => t.stop())
    _localStream = null
  }

  /**
   * Get the remote media stream from a specific peer.
   * @param {string} peerId
   * @returns {MediaStream|null}
   */
  const getRemoteStream = (peerId) => _streams.get(peerId) ?? null

  /**
   * Subscribe to incoming remote media streams.
   * @param {function} fn - ({ peerId, stream }) => void
   * @returns {function} off
   */
  const onMediaStream = (fn) => on('mediaStream', fn)


  return {
    // Standard QuNet transport interface
    state,
    connect,
    disconnect,
    send,
    on,
    capabilities,

    // WebRTC signaling helpers (used by WebRtcPresencePlugin)
    handleOffer,
    handleAnswer,
    handleIce,
    initiateOffer,

    // Audio/Video (WebRTC-specific extensions — not in Core)
    startMedia,
    stopMedia,
    getRemoteStream,
    onMediaStream,
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// WebRtcPresencePlugin
//
// Registers signaling type handlers with QuSync so incoming
// webrtc.offer / webrtc.answer / webrtc.ice packets reach the transport.
//
// This is a plugin — it uses sync.registerHandler() and net.use().
// It does NOT touch QuDB, QuNet internals, or Core code.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebRTC signaling plugin.
 * Bridges relay-forwarded signaling messages to the WebRtcTransport.
 *
 * @param {object} options
 * @param {QuNetInstance}          options.net
 * @param {WebRtcTransportInstance} options.webrtc
 * @param {LocalPeerInstance}      options.identity
 * @returns {{ attach, detach }}
 *
 * @example
 * const webrtc = WebRtcTransport({ iceServers: [...] })
 * qr._.net.use(webrtc, 'webrtc')
 *
 * const plugin = WebRtcPresencePlugin({ net: qr._.net, webrtc, identity: qr.me, presence: qr._.presence })
 * plugin.attach(qr._.sync)
 *
 * // Now WebRTC connections are established automatically when peers are online.
 * // Access audio:
 * const stream = await webrtc.startMedia({ audio: true, video: true })
 */
const WebRtcPresencePlugin = ({ net, webrtc, identity, presence = null }) => {
  let _offHandlers = []

  // Forward webrtc.offer → handleOffer → send back answer via relay
  const _onOffer = async (qubit) => {
    const { sdp } = qubit.data ?? {}
    const peerId  = qubit.from
    if (!sdp || !peerId || peerId === identity?.pub) return

    const answerSdp = await webrtc.handleOffer(peerId, sdp)
    await net.send({
      payload: {
        type: QUBIT_TYPE_WEBRTC.ANSWER,
        from: identity?.pub ?? null,
        to:   peerId,
        data: { sdp: answerSdp },
      }
    })
  }

  const _onAnswer = async (qubit) => {
    const { sdp } = qubit.data ?? {}
    const peerId  = qubit.from
    if (!sdp || !peerId) return
    await webrtc.handleAnswer(peerId, sdp)
  }

  const _onIce = async (qubit) => {
    const { candidate } = qubit.data ?? {}
    const peerId        = qubit.from
    if (!candidate || !peerId) return
    await webrtc.handleIce(peerId, candidate)
  }

  // When a new peer comes online, initiate WebRTC offer (lower pub wins = initiator)
  // This prevents double-offer: only the peer with the lexicographically lower pub sends.
  const _onPeerHello = async (qubit) => {
    const remotePub = qubit.from ?? qubit.data?.pub
    if (!remotePub || !identity?.pub) return
    if (remotePub === identity.pub) return
    if (identity.pub < remotePub) {
      // We are the initiator
      const offerSdp = await webrtc.initiateOffer(remotePub)
      await net.send({
        payload: {
          type: QUBIT_TYPE_WEBRTC.OFFER,
          from: identity.pub,
          to:   remotePub,
          data: { sdp: offerSdp },
        }
      })
    }
  }

  const attach = (sync) => {
    _offHandlers.push(sync.registerHandler(QUBIT_TYPE_WEBRTC.OFFER,  _onOffer))
    _offHandlers.push(sync.registerHandler(QUBIT_TYPE_WEBRTC.ANSWER, _onAnswer))
    _offHandlers.push(sync.registerHandler(QUBIT_TYPE_WEBRTC.ICE,    _onIce))

    // Peer-online events: prefer presence.on('peerOnline') if QuPresence is loaded.
    // This avoids stealing the sync.registerHandler('peer.hello') slot which QuPresence owns.
    if (presence) {
      _offHandlers.push(
        presence.on('peerOnline', ({ pub }) => _onPeerHello({ from: pub, data: { pub } }))
      )
    } else {
      // QuPresence not loaded — fall back to raw net listener for peer.hello
      _offHandlers.push(
        net.on('message', async (pkt) => {
          if (pkt?.payload?.type === 'peer.hello') await _onPeerHello(pkt.payload)
        })
      )
    }
  }

  const detach = () => {
    for (const off of _offHandlers) off?.()
    _offHandlers = []
  }

  return { attach, detach }
}


export { WebRtcTransport, WebRtcPresencePlugin, QUBIT_TYPE_WEBRTC }
