// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/ui/qm-sidebar.js
// <qm-sidebar> — reactive conversation list with presence dots.
//
// Attributes: none
// Properties:
//   .store        — MessengerStore instance (required)
//   .db           — QuDB instance (for pub key alias lookups)
//   .me           — local identity (pub, alias) — shows own avatar in header
// Events:
//   'qm-conv-select' { detail: { convId } } — user clicked a conversation
//   'qm-navigate'    { detail: { path } }   — user navigated (profile/settings)
// ════════════════════════════════════════════════════════════════════════════

import { CONV_TYPE } from '../types.js'

const _ts = (ms) => {
  if (!ms) return ''
  const d   = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

class QmSidebar extends HTMLElement {
  set store(s)  { this._store = s;  this._init() }
  set db(d)     { this._db = d; }
  set me(m) {
    this._me = m
    this._updateMyHeader()
    // Set up reactive watcher for own profile now that _me is available.
    // (_init() runs before _me is set, so the guard there always fails.)
    if (this._db && this._me && this.isConnected) {
      if (this._meWatchOff) { this._meWatchOff(); this._meWatchOff = null }
      this._meWatchOff = this._db.on(`~${this._me.pub}/**`, () => this._updateMyHeader())
      this._offFns = this._offFns ?? []
      this._offFns.push(this._meWatchOff)
    }
  }
  set activeConvId(id) {
    this._activeConvId = id
    this.querySelectorAll('.qm-conv-row').forEach(el => {
      el.classList.toggle('active', el.dataset.convId === id)
    })
  }

  connectedCallback() {
    this.classList.add('qm-sidebar-root')
    this._offFns = []
    this._convs  = new Map()   // convId → data
    if (this._store) this._init()
  }

  disconnectedCallback() {
    this._offFns.forEach(f => f?.())
    this._offFns = []
  }

  _init() {
    if (!this._store || !this.isConnected) return
    this._offFns.forEach(f => f?.())
    this._offFns = []

    this.innerHTML = `
      <div class="qm-sidebar-header">
        <div class="qm-sidebar-me" id="sidebar-me-area" role="button" tabindex="0" title="Profil öffnen">
          <qu-avatar id="sidebar-my-avatar" pub="" size="36" shape="circle"></qu-avatar>
          <span class="qm-sidebar-me-name" id="sidebar-my-name">…</span>
        </div>
        <button class="qm-sidebar-settings-btn" id="sidebar-settings-btn" title="Einstellungen">⚙</button>
      </div>
      <div class="qm-sidebar-list" id="conv-list-inner"></div>
    `
    this._listEl = this.querySelector('#conv-list-inner')

    // Wire navigation events
    const meArea = this.querySelector('#sidebar-me-area')
    meArea.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('qm-navigate', {
        detail: { path: '/profile' }, bubbles: true,
      }))
    })
    meArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.dispatchEvent(new CustomEvent('qm-navigate', {
          detail: { path: '/profile' }, bubbles: true,
        }))
      }
    })
    this.querySelector('#sidebar-settings-btn').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('qm-navigate', {
        detail: { path: '/settings' }, bubbles: true,
      }))
    })

    // Update header with own identity
    this._updateMyHeader()

    // Watch own profile changes reactively
    if (this._me && this._db) {
      const off = this._db.on(`~${this._me.pub}/**`, () => this._updateMyHeader())
      this._offFns.push(off)
    }

    // Load initial conversations
    this._store.getConversations().then(rows => {
      for (const q of rows) {
        if (q?.data?.convId) this._convs.set(q.data.convId, q.data)
      }
      this._renderList()
    })

    // Reactive updates
    const off = this._store.onConversations((q, { event } = {}) => {
      if (event === 'del' || q?.deleted) {
        this._convs.delete(q.data?.convId ?? q.key.split('/').pop())
      } else if (q?.data?.convId) {
        this._convs.set(q.data.convId, q.data)
      }
      this._renderList()
    })
    this._offFns.push(off)
  }

  _updateMyHeader() {
    const avatarEl = this.querySelector('#sidebar-my-avatar')
    const nameEl   = this.querySelector('#sidebar-my-name')
    if (!avatarEl || !nameEl || !this._me) return
    avatarEl.setAttribute('pub', this._me.pub)
    nameEl.textContent = this._me.alias || this._me.pub.slice(0, 12) + '…'
  }

  _renderList() {
    if (!this._listEl) return
    const sorted = [...this._convs.values()].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
    this._listEl.innerHTML = sorted.length
      ? sorted.map(c => this._convRow(c)).join('')
      : '<div style="padding:20px;text-align:center;color:var(--qm-muted);font-size:13px">Keine Chats</div>'

    this._listEl.querySelectorAll('.qm-conv-row').forEach(el => {
      el.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('qm-conv-select', {
          detail: { convId: el.dataset.convId },
          bubbles: true,
        }))
      })
      if (el.dataset.convId === this._activeConvId) el.classList.add('active')
    })
  }

  _convRow(c) {
    const isDM     = c.type === CONV_TYPE.DM
    const name     = c.name ?? (isDM ? c.contactPub?.slice(0, 12) + '…' : 'Gruppe')
    const preview  = c.lastMsg ? `${c.lastMsg}`.slice(0, 48) : '…'
    const ts       = _ts(c.lastTs)
    const unread   = c.unread > 0 ? `<span class="qm-unread-badge">${c.unread}</span>` : ''
    const statusPub = isDM ? c.contactPub : ''
    return `
      <div class="qm-conv-row" data-conv-id="${c.convId}">
        <qu-avatar pub="${statusPub || ''}" size="42"></qu-avatar>
        <div class="qm-conv-info">
          <div class="qm-conv-name">${name}</div>
          <div class="qm-conv-preview">${preview}</div>
        </div>
        <div class="qm-conv-meta">
          <span class="qm-conv-ts">${ts}</span>
          ${unread}
          ${statusPub ? `<qu-status pub="${statusPub}" size="8"></qu-status>` : ''}
        </div>
      </div>`
  }
}

export { QmSidebar }
