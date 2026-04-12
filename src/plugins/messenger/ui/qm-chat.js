// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/ui/qm-chat.js
// <qm-chat> — message list + header for a single conversation.
//
// Properties:
//   .store      — MessengerStore instance
//   .db         — QuDB instance
//   .me         — local identity (pub, alias)
//   .calls      — CallManager (optional, enables call button)
//   .presence   — QuPresence (optional, enables typing indicator)
//   .convId     — current conversation ID (triggers reload on change)
// Events:
//   'qm-back'   — user pressed back (mobile)
// ════════════════════════════════════════════════════════════════════════════

import { CONV_TYPE } from '../types.js'
import { pub64 }     from '../../../core/identity.js'

class QmChat extends HTMLElement {
  set store(s)    { this._store    = s; }
  set db(d)       { this._db       = d; }
  set me(m)       { this._me       = m; }
  set calls(c)    { this._calls    = c; }
  set presence(p) { this._presence = p; }

  set convId(id) {
    if (id === this._convId) return
    this._convId = id
    this._loadConv()
  }
  get convId() { return this._convId }

  connectedCallback() {
    this._offFns = []
    this._msgs   = new Map()   // key → qubit
    this._typingPubs = new Set()
    this._conv   = null
    this._render()
    if (this._convId) this._loadConv()
  }

  disconnectedCallback() {
    this._offFns.forEach(f => f?.())
    this._offFns = []
  }

  _render() {
    this.innerHTML = `
      <div class="qm-chat-header">
        <button class="qm-chat-back-btn" title="Zurück">‹</button>
        <qu-avatar id="ch-avatar" size="36"></qu-avatar>
        <div class="qm-chat-header-info">
          <div class="qm-chat-header-name" id="ch-name">—</div>
          <div class="qm-chat-header-status" id="ch-status"></div>
        </div>
        <div class="qm-chat-header-actions">
          <button class="qm-chat-header-btn" id="ch-call-audio" title="Anruf" hidden>📞</button>
          <button class="qm-chat-header-btn" id="ch-call-video" title="Video" hidden>📹</button>
        </div>
      </div>
      <div class="qm-msg-list" id="ch-msg-list">
        <div class="qm-empty-state">
          <div class="qm-empty-state-icon">💬</div>
          <div class="qm-empty-state-text">Noch keine Nachrichten</div>
        </div>
      </div>
      <div id="ch-typing" class="qm-typing-row" hidden></div>
    `
    this.querySelector('.qm-chat-back-btn').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('qm-back', { bubbles: true }))
    })
    this.querySelector('#ch-call-audio')?.addEventListener('click', () => this._startCall('audio'))
    this.querySelector('#ch-call-video')?.addEventListener('click', () => this._startCall('video'))

    this._msgList   = this.querySelector('#ch-msg-list')
    this._typingEl  = this.querySelector('#ch-typing')
    this._nameEl    = this.querySelector('#ch-name')
    this._statusEl  = this.querySelector('#ch-status')
    this._avatarEl  = this.querySelector('#ch-avatar')
  }

  async _loadConv() {
    // Cleanup previous subscriptions
    this._offFns.forEach(f => f?.())
    this._offFns = []
    this._msgs.clear()
    this._typingPubs.clear()

    if (!this._convId || !this._store) return

    // Load conversation metadata
    const rows = await this._store.getConversations()
    this._conv = rows.find(q => q?.data?.convId === this._convId)?.data ?? null
    this._updateHeader()

    // Load initial messages
    const msgs = await this._store.getMessages(this._convId)
    for (const q of msgs) {
      if (q?.key && !q.deleted) this._msgs.set(q.key, q)
    }
    this._renderMessages()

    // Reactive: new/updated messages
    const offMsg = await this._store.onMessages(this._convId, (q, { event } = {}) => {
      if (event === 'del' || q?.deleted) {
        this._msgs.delete(q.key)
      } else if (q?.key) {
        this._msgs.set(q.key, q)
        // Mark conversation as read when new message arrives
        if (q.from !== this._me?.pub) {
          this._store.markRead(this._convId, q.key).catch(() => {})
        }
      }
      this._renderMessages()
    })
    this._offFns.push(offMsg)

    // Typing indicators via QuPresence
    if (this._presence && this._conv?.spaceId) {
      const off = this._db.on(
        `conf/typing/${this._conv.spaceId}/**`,
        (q, { event } = {}) => {
          const from = q?.data?.from
          if (!from) return
          if (event === 'del' || q?.deleted) this._typingPubs.delete(from)
          else this._typingPubs.add(from)
          this._renderTyping()
        }
      )
      this._offFns.push(off)
    }

    // DM typing: use contactPub as spaceId-like key for typing scope
    if (this._presence && this._conv?.type === CONV_TYPE.DM && this._conv?.contactPub) {
      const dmScope = this._conv.contactPub.slice(0, 16)
      const off = this._db.on(
        `conf/typing/${dmScope}/**`,
        (q, { event } = {}) => {
          const from = q?.data?.from
          if (!from || from === this._me?.pub) return
          if (event === 'del' || q?.deleted) this._typingPubs.delete(from)
          else this._typingPubs.add(from)
          this._renderTyping()
        }
      )
      this._offFns.push(off)
    }

    // Online status for DM header
    if (this._conv?.contactPub) {
      const off = this._db.on(
        `sys/peers/${pub64(this._conv.contactPub)}`,
        (q, { event } = {}) => {
          this._statusEl.textContent = (event !== 'del' && q && !q.deleted) ? 'Online' : ''
        },
        { immediate: true }
      )
      this._offFns.push(off)
    }
  }

  _updateHeader() {
    if (!this._conv) return
    const isDM    = this._conv.type === CONV_TYPE.DM
    const name    = this._conv.name ?? (isDM ? '…' : 'Gruppe')
    if (this._nameEl) this._nameEl.textContent = name
    if (this._avatarEl && this._conv.contactPub) {
      this._avatarEl.setAttribute('pub', this._conv.contactPub)
    }
    // Show call buttons for DMs (requires calls module)
    const audioBtn = this.querySelector('#ch-call-audio')
    const videoBtn = this.querySelector('#ch-call-video')
    if (audioBtn) audioBtn.hidden = !(this._calls && isDM)
    if (videoBtn) videoBtn.hidden = !(this._calls && isDM)
  }

  _renderMessages() {
    if (!this._msgList) return
    const sorted = [...this._msgs.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    if (!sorted.length) {
      this._msgList.innerHTML = `
        <div class="qm-empty-state">
          <div class="qm-empty-state-icon">💬</div>
          <div class="qm-empty-state-text">Noch keine Nachrichten</div>
        </div>`
      return
    }
    const myPub  = this._me?.pub ?? null
    const isGroup = this._conv?.type === CONV_TYPE.GROUP
    this._msgList.innerHTML = sorted.map(q => {
      const mine = q.from && myPub && pub64(q.from) === pub64(myPub)
      return `<qu-chat-msg
        msg-key="${q.key}"
        ${mine ? 'mine' : ''}
        ${isGroup && !mine ? 'show-sender' : ''}
      ></qu-chat-msg>`
    }).join('')

    // Scroll to bottom
    requestAnimationFrame(() => {
      this._msgList.scrollTop = this._msgList.scrollHeight
    })
  }

  _renderTyping() {
    if (!this._typingEl) return
    if (this._typingPubs.size === 0) {
      this._typingEl.hidden = true
      return
    }
    this._typingEl.hidden = false
    this._typingEl.innerHTML = `
      <span>${[...this._typingPubs].map(p => p.slice(0, 8) + '…').join(', ')} schreibt</span>
      <span class="qm-typing-dots"><span></span><span></span><span></span></span>
    `
  }

  async _startCall(type) {
    if (!this._calls || !this._conv?.contactPub) return
    await this._calls.call(this._conv.contactPub, {
      audio: true,
      video: type === 'video',
    }).catch(e => console.warn('[QmChat] call failed:', e))
  }
}

export { QmChat }
