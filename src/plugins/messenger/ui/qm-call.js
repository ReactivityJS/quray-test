// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/ui/qm-call.js
// <qm-call-overlay> — audio/video call UI.
//
// Shows as a full-screen overlay when a call is active or ringing.
// States:
//   ringing/outbound — "Rufe … an" + cancel button
//   ringing/inbound  — "Eingehender Anruf" + accept + decline buttons
//   connecting       — "Verbinden…" + cancel
//   active           — duration timer + mute/hangup + optional video
//   ended            — briefly shows "Anruf beendet" then hides
//
// Properties:
//   .calls  — CallManager instance
//   .db     — QuDB instance
// ════════════════════════════════════════════════════════════════════════════

import { CALL_STATE } from '../types.js'
import { pub64 }      from '../../../core/identity.js'

class QmCallOverlay extends HTMLElement {
  set calls(c) { this._calls = c; this._init() }
  set db(d)    { this._db    = d; }

  connectedCallback() {
    this.setAttribute('hidden', '')
    this._offFns      = []
    this._timerHandle = null
    this._callState   = null
    this._durationSec = 0
    this._muted       = false
    this._render()
    if (this._calls) this._init()
  }

  disconnectedCallback() {
    this._offFns.forEach(f => f?.())
    this._offFns = []
    clearInterval(this._timerHandle)
  }

  _render() {
    this.innerHTML = `
      <div class="qm-call-backdrop"></div>
      <div class="qm-call-dialog">
        <div class="qm-call-state-label" id="co-state-label">Anruf</div>
        <div class="qm-call-avatar-wrap" id="co-avatar-wrap">
          <qu-avatar id="co-avatar" size="80"></qu-avatar>
        </div>
        <div class="qm-call-peer-name" id="co-name">…</div>
        <div class="qm-call-duration" id="co-duration" hidden></div>
        <div class="qm-call-video-row" id="co-video-row" hidden>
          <video id="co-remote-video" class="qm-call-video" autoplay playsinline></video>
          <video id="co-local-video"  class="qm-call-video local-preview" autoplay playsinline muted></video>
        </div>
        <div class="qm-call-actions" id="co-actions"></div>
      </div>
    `
    this._stateLabel  = this.querySelector('#co-state-label')
    this._avatarWrap  = this.querySelector('#co-avatar-wrap')
    this._avatar      = this.querySelector('#co-avatar')
    this._nameEl      = this.querySelector('#co-name')
    this._durationEl  = this.querySelector('#co-duration')
    this._videoRow    = this.querySelector('#co-video-row')
    this._remoteVideo = this.querySelector('#co-remote-video')
    this._localVideo  = this.querySelector('#co-local-video')
    this._actionsEl   = this.querySelector('#co-actions')
  }

  _init() {
    if (!this._calls) return
    this._offFns.forEach(f => f?.())
    this._offFns = []

    // Subscribe to call state changes
    const off = this._db.on('sys/call/**', (q, { event } = {}) => {
      const state = (event === 'del' || q?.deleted) ? null : q?.data ?? null
      this._onStateChange(state)
    })
    this._offFns.push(off)

    // Subscribe to remote media streams
    const offStream = this._calls.onRemoteStream(({ peerId, stream }) => {
      this._remoteVideo.srcObject = stream
      this._remoteVideo.classList.add('active')
      this._videoRow.hidden = false
    })
    this._offFns.push(offStream)
  }

  _onStateChange(state) {
    this._callState = state
    clearInterval(this._timerHandle)

    if (!state || state.state === CALL_STATE.IDLE) {
      this.setAttribute('hidden', '')
      return
    }

    this.removeAttribute('hidden')
    this._avatarWrap.classList.toggle('ringing', state.state === CALL_STATE.RINGING)

    // Avatar
    if (state.peerId) this._avatar.setAttribute('pub', pub64(state.peerId))

    // Peer name (try alias from peer map, fallback to truncated pub)
    this._nameEl.textContent = state.peerId
      ? state.peerId.slice(0, 14) + '…'
      : '…'

    const { state: cs, direction } = state

    // State label
    const labels = {
      [CALL_STATE.RINGING]:    direction === 'inbound' ? '📲 Eingehender Anruf' : '📞 Ruft an…',
      [CALL_STATE.CONNECTING]: '🔄 Verbinden…',
      [CALL_STATE.ACTIVE]:     '🔴 Gespräch aktiv',
      [CALL_STATE.ENDED]:      '📴 Anruf beendet',
    }
    this._stateLabel.textContent = labels[cs] ?? cs

    // Duration timer for active calls
    if (cs === CALL_STATE.ACTIVE) {
      this._durationEl.hidden = false
      this._durationSec = 0
      this._timerHandle = setInterval(() => {
        this._durationSec++
        const m = String(Math.floor(this._durationSec / 60)).padStart(2, '0')
        const s = String(this._durationSec % 60).padStart(2, '0')
        this._durationEl.textContent = `${m}:${s}`
      }, 1_000)

      // Attach local video stream if available
      const localStream = this._calls.getLocalStream()
      if (localStream) {
        this._localVideo.srcObject = localStream
        this._localVideo.classList.add('active')
        if (state.callType === 'video') this._videoRow.hidden = false
      }
    } else {
      this._durationEl.hidden = true
      this._videoRow.hidden   = true
      this._remoteVideo.srcObject = null
      this._localVideo.srcObject  = null
      this._remoteVideo.classList.remove('active')
      this._localVideo.classList.remove('active')
    }

    // Action buttons
    this._renderActions(cs, direction, state.peerId)

    // Auto-dismiss ended state
    if (cs === CALL_STATE.ENDED) {
      setTimeout(() => {
        if (this._callState?.state === CALL_STATE.ENDED) {
          this.setAttribute('hidden', '')
        }
      }, 2_500)
    }
  }

  _renderActions(callState, direction, peerId) {
    const btns = []

    if (callState === CALL_STATE.RINGING && direction === 'inbound') {
      btns.push({ cls: 'accept',  icon: '✅', label: 'Annehmen',  action: () => this._calls.accept(peerId) })
      btns.push({ cls: 'decline', icon: '❌', label: 'Ablehnen',  action: () => this._calls.hangup(peerId) })
    } else if (callState === CALL_STATE.ACTIVE) {
      btns.push({ cls: 'mute',   icon: this._muted ? '🔇' : '🎤', label: 'Stummschalten', action: () => this._toggleMute(peerId) })
      btns.push({ cls: 'hangup', icon: '📵', label: 'Auflegen', action: () => this._calls.hangup(peerId) })
    } else if (callState === CALL_STATE.RINGING || callState === CALL_STATE.CONNECTING) {
      btns.push({ cls: 'hangup', icon: '📵', label: 'Abbrechen', action: () => this._calls.hangup(peerId) })
    }

    this._actionsEl.innerHTML = btns.map(b =>
      `<button class="qm-call-action-btn ${b.cls}" title="${b.label}">${b.icon}</button>`
    ).join('')

    btns.forEach((b, i) => {
      this._actionsEl.children[i]?.addEventListener('click', () => b.action())
    })
  }

  _toggleMute() {
    this._muted = !this._muted
    const localStream = this._calls.getLocalStream()
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = !this._muted })
    }
    // Re-render actions to update icon
    if (this._callState) {
      this._renderActions(this._callState.state, this._callState.direction, this._callState.peerId)
    }
  }
}

export { QmCallOverlay }
