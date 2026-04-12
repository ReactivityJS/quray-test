// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/ui/qm-sidebar.js
// <qm-sidebar> — reactive conversation list with presence dots.
//
// Attributes: none
// Properties:
//   .store   — MessengerStore instance (required)
//   .db      — QuDB instance (for pub key alias lookups)
// Events:
//   'qm-conv-select' { detail: { convId } } — user clicked a conversation
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
    this._render()

    // Header
    this.innerHTML = `
      <div class="qm-sidebar-header">
        <span>💬 Chats</span>
      </div>
      <div class="qm-sidebar-list" id="conv-list-inner"></div>
    `
    this._listEl = this.querySelector('#conv-list-inner')

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

  _render() { /* no-op placeholder, actual render in _init */ }

  _renderList() {
    if (!this._listEl) return
    const sorted = [...this._convs.values()].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
    this._listEl.innerHTML = sorted.length
      ? sorted.map(c => this._convRow(c)).join('')
      : '<div style="padding:20px;text-align:center;color:var(--qm-muted);font-size:12px">Keine Chats</div>'

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
        <qu-avatar pub="${statusPub || ''}" size="38"></qu-avatar>
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
