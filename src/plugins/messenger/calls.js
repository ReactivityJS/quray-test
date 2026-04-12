// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/calls.js
// CallManager — audio/video call state machine for the Messenger plugin.
//
// Architecture:
//   • Call state stored in sys/call/{peerId}  (RAM-only, reactive via db.on)
//   • Signaling via three ephemeral QuBit types:
//       messenger.call.invite  — caller → callee (ring)
//       messenger.call.accept  — callee → caller (pick up)
//       messenger.call.hangup  — either peer (end/decline)
//   • Media via WebRtcTransport.startMedia() / addStream()
//   • WebRTC negotiation delegated to WebRtcPresencePlugin (already wired)
//
// Usage:
//   const calls = CallManager({ db, identity, webrtc, net })
//   calls.attach(sync)
//
//   await calls.call(peerId, { audio: true, video: false })
//   await calls.accept(peerId)
//   await calls.hangup(peerId)
//
//   calls.onCallState((state) => renderCallUI(state))
// ════════════════════════════════════════════════════════════════════════════

import { EventBus } from '../../core/events.js'
import { pub64 }    from '../../core/identity.js'
import { CALL_STATE, CALL_TYPE, MESSENGER_SIG_TYPE, MSG_KEY } from './types.js'


/** Auto-miss a ringing call after this many milliseconds with no answer. */
const RING_TIMEOUT_MS = 30_000


/**
 * CallManager — manages audio/video call lifecycle.
 *
 * @param {object} options
 * @param {QuDBInstance}         options.db       — QuDB instance
 * @param {IdentityInstance}     options.identity — local identity
 * @param {WebRtcTransportInstance} options.webrtc — WebRTC transport
 * @param {QuNetInstance}        options.net      — network transport manager
 * @returns {CallManagerInstance}
 */
const CallManager = ({ db, identity, webrtc, net }) => {
  let _offHandlers = []
  const _ringTimers = new Map()   // peerId → timeoutId (auto-miss)

  // Internal event bus: fires on every state change
  const _bus = EventBus({ separator: '/' })


  // ── Internal helpers ────────────────────────────────────────────────────────

  const _myPub = () => identity?.pub ?? null

  /** Read call state from sys/. */
  const _getState = async (peerId) => {
    const q = await db.get(MSG_KEY.callState(peerId))
    return q?.data ?? null
  }

  /** Write call state to sys/ (RAM only). */
  const _setState = async (peerId, stateData) => {
    const key = MSG_KEY.callState(peerId)
    await db.put(key, stateData)
    _bus.emit('callState', stateData)
  }

  /** Remove call state from sys/. */
  const _clearState = async (peerId) => {
    const key = MSG_KEY.callState(peerId)
    await db.del(key, { sync: false, hard: true }).catch(() => {})
    _bus.emit('callState', null)
  }

  /** Clear ring timer for a peer. */
  const _clearRingTimer = (peerId) => {
    const t = _ringTimers.get(peerId)
    if (t) { clearTimeout(t); _ringTimers.delete(peerId) }
  }

  /** Send a signalling packet via QuNet (not stored, relay-forwarded). */
  const _signal = async (type, toPub, data = {}) => {
    await net.send({
      payload: {
        type,
        from: _myPub(),
        to:   pub64(toPub),
        ts:   Date.now(),
        data,
      },
    }).catch(() => {})
  }


  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Initiate an outgoing call to a peer.
   *
   * @param {string} peerId   — recipient pub64
   * @param {object} [opts]
   * @param {boolean} [opts.audio=true]
   * @param {boolean} [opts.video=false]
   * @returns {Promise<void>}
   */
  const call = async (peerId, { audio = true, video = false } = {}) => {
    if (!_myPub()) return
    const p64 = pub64(peerId)

    await _setState(p64, {
      peerId:    p64,
      direction: 'outbound',
      state:     CALL_STATE.RINGING,
      callType:  video ? CALL_TYPE.VIDEO : CALL_TYPE.AUDIO,
      startTs:   Date.now(),
    })

    // Send ring signal to callee
    await _signal(MESSENGER_SIG_TYPE.CALL_INVITE, p64, {
      callType: video ? CALL_TYPE.VIDEO : CALL_TYPE.AUDIO,
    })

    // Start local media (triggers WebRTC offer via WebRtcPresencePlugin on peer.hello)
    if (webrtc) {
      try {
        const stream = await webrtc.startMedia({ audio, video })
        webrtc.addStream(p64, stream)
      } catch (e) {
        // Media access denied — continue with audio-only or abort
        console.warn('[CallManager] getUserMedia failed:', e)
      }
    }

    // Auto-cancel after ring timeout (if callee doesn't answer)
    const timer = setTimeout(() => _autoMiss(p64), RING_TIMEOUT_MS)
    _ringTimers.set(p64, timer)
  }

  /**
   * Accept an incoming call.
   *
   * @param {string} peerId — caller pub64
   * @returns {Promise<void>}
   */
  const accept = async (peerId) => {
    const p64  = pub64(peerId)
    const cur  = await _getState(p64)
    if (!cur || cur.state !== CALL_STATE.RINGING) return

    _clearRingTimer(p64)

    await _setState(p64, { ...cur, state: CALL_STATE.CONNECTING })

    await _signal(MESSENGER_SIG_TYPE.CALL_ACCEPT, p64)

    if (webrtc) {
      try {
        const video = cur.callType === CALL_TYPE.VIDEO
        const stream = await webrtc.startMedia({ audio: true, video })
        webrtc.addStream(p64, stream)
      } catch (e) {
        console.warn('[CallManager] getUserMedia on accept failed:', e)
      }
    }

    // Transition to ACTIVE when remote media stream arrives
    if (webrtc) {
      const off = webrtc.onMediaStream(({ peerId: remotePub }) => {
        if (pub64(remotePub) !== p64) return
        off()
        _setState(p64, { ...cur, state: CALL_STATE.ACTIVE, activeTs: Date.now() })
      })
      _offHandlers.push(off)
    } else {
      // No WebRTC — mark active immediately (data-only call)
      await _setState(p64, { ...cur, state: CALL_STATE.ACTIVE, activeTs: Date.now() })
    }
  }

  /**
   * Hang up or decline a call.
   *
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  const hangup = async (peerId) => {
    const p64 = pub64(peerId)
    _clearRingTimer(p64)

    await _signal(MESSENGER_SIG_TYPE.CALL_HANGUP, p64)

    if (webrtc) {
      webrtc.stopMedia()
    }

    await _setState(p64, { peerId: p64, state: CALL_STATE.ENDED })
    // Auto-clear after a short delay so UI can show ended state
    setTimeout(() => _clearState(p64), 2_000)
  }

  /** Auto-dismiss unanswered outgoing call as timed out. */
  const _autoMiss = async (peerId) => {
    _ringTimers.delete(peerId)
    await _setState(peerId, { peerId, state: CALL_STATE.ENDED, reason: 'timeout' })
    setTimeout(() => _clearState(peerId), 2_000)
    if (webrtc) webrtc.stopMedia()
  }


  // ── Reactive ───────────────────────────────────────────────────────────────

  /**
   * Get current call state for a peer.
   * @param {string} peerId
   * @returns {Promise<object|null>}
   */
  const getCallState = (peerId) => _getState(pub64(peerId))

  /**
   * Subscribe to call state changes across all peers.
   * @param {function} fn — (stateData | null) => void
   * @returns {function} off
   */
  const onCallState = (fn) => {
    // Subscribe to all sys/call/** QuBit changes
    const offDb = db.on('sys/call/**', (q, meta) => {
      fn(meta.event === 'del' ? null : q?.data ?? null)
    })
    return offDb
  }

  /**
   * Get the local media stream (if active).
   * @returns {MediaStream|null}
   */
  const getLocalStream = () => webrtc?._localStream ?? null

  /**
   * Get the remote media stream for a peer.
   * @param {string} peerId
   * @returns {MediaStream|null}
   */
  const getRemoteStream = (peerId) => webrtc?.getRemoteStream(pub64(peerId)) ?? null

  /**
   * Subscribe to incoming remote media streams.
   * @param {function} fn — ({ peerId, stream }) => void
   * @returns {function} off
   */
  const onRemoteStream = (fn) => webrtc?.onMediaStream(fn) ?? (() => {})


  // ── Sync handler registration ─────────────────────────────────────────────

  const _handleInvite = async (qubit) => {
    const from = qubit.from ?? qubit.data?.from
    if (!from || from === _myPub()) return
    const p64  = pub64(from)

    _clearRingTimer(p64)   // reset if re-invite

    await _setState(p64, {
      peerId:    p64,
      direction: 'inbound',
      state:     CALL_STATE.RINGING,
      callType:  qubit.data?.callType ?? CALL_TYPE.AUDIO,
      startTs:   qubit.ts ?? Date.now(),
    })

    // Auto-miss if not answered
    const timer = setTimeout(() => _autoMiss(p64), RING_TIMEOUT_MS)
    _ringTimers.set(p64, timer)
  }

  const _handleAccept = async (qubit) => {
    const from = qubit.from ?? qubit.data?.from
    if (!from) return
    const p64  = pub64(from)
    const cur  = await _getState(p64)
    if (!cur) return

    _clearRingTimer(p64)
    await _setState(p64, { ...cur, state: CALL_STATE.ACTIVE, activeTs: Date.now() })
  }

  const _handleHangup = async (qubit) => {
    const from = qubit.from ?? qubit.data?.from
    if (!from) return
    const p64  = pub64(from)
    _clearRingTimer(p64)
    if (webrtc) webrtc.stopMedia()
    await _setState(p64, { peerId: p64, state: CALL_STATE.ENDED })
    setTimeout(() => _clearState(p64), 2_000)
  }

  /**
   * Register call signalling handlers with a QuSync instance.
   * @param {QuSyncInstance} sync
   */
  const attach = (sync) => {
    _offHandlers.push(sync.registerHandler(MESSENGER_SIG_TYPE.CALL_INVITE,  _handleInvite))
    _offHandlers.push(sync.registerHandler(MESSENGER_SIG_TYPE.CALL_ACCEPT,  _handleAccept))
    _offHandlers.push(sync.registerHandler(MESSENGER_SIG_TYPE.CALL_HANGUP,  _handleHangup))
  }

  /** Unregister all handlers and clear timers. */
  const detach = () => {
    for (const off of _offHandlers) off?.()
    _offHandlers = []
    for (const t of _ringTimers.values()) clearTimeout(t)
    _ringTimers.clear()
    if (webrtc) webrtc.stopMedia()
  }


  return {
    call,
    accept,
    hangup,
    getCallState,
    onCallState,
    getLocalStream,
    getRemoteStream,
    onRemoteStream,
    attach,
    detach,
  }
}


export { CallManager }
