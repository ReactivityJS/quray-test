// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/ui/qm-composer.js
// <qm-composer> — message input area.
//
// Features:
//   • Auto-growing textarea
//   • File/image attachment via drag-drop overlay on textarea (or click attach btn)
//   • Emoji button: native keyboard on mobile, qu-emoji-picker on desktop
//   • Typing indicator (via presence.sendTyping)
//   • Enter to send (Shift+Enter = newline)
//
// Properties:
//   .store    — MessengerStore instance
//   .db       — QuDB instance
//   .convId   — current conversation ID
//   .presence — QuPresence instance (optional)
//   .net      — QuNet instance (optional, needed for typing signal)
//   .spaceId  — group space ID (for typing scope)
//
// Events:
//   'qm-sent' { detail: { key } } — message was sent
// ════════════════════════════════════════════════════════════════════════════

// Mobile detection
const _isMobile = () =>
  /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) ||
  ('ontouchstart' in window && window.innerWidth < 768)

// Debounce utility
const _debounce = (fn, ms) => {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}


class QmComposer extends HTMLElement {
  set store(s)    { this._store    = s }
  set db(d)       { this._db       = d }
  set presence(p) { this._presence = p }
  set net(n)      { this._net      = n }

  set convId(id) {
    this._convId = id
    this._loadConv()
  }

  connectedCallback() {
    this._stagedFiles = []    // [{ hash, name, mime, size }]
    this._convId      = null
    this._conv        = null
    this._render()
  }

  _render() {
    this.innerHTML = `
      <div class="qm-staged-files" id="staged-files" style="display:none"></div>
      <div class="qm-composer-wrap">
        <button class="qm-composer-btn" id="btn-attach" title="Anhang">📎</button>
        <div class="qm-composer-textarea-wrap">
          <textarea
            class="qm-composer-input"
            id="msg-input"
            rows="1"
            placeholder="Nachricht schreiben…"
          ></textarea>
          <div class="qm-drop-overlay" id="drop-overlay" aria-hidden="true">
            📎 Datei ablegen
          </div>
          <qu-blob-drop
            id="blob-drop-zone"
            accept="image/*,video/*,audio/*,application/pdf,.txt,.zip"
            multiple
            style="position:absolute;inset:0;opacity:0;pointer-events:none;border:none;background:transparent"
          ></qu-blob-drop>
        </div>
        <button class="qm-composer-btn" id="btn-emoji" title="Emoji">😊</button>
        <button class="qm-composer-btn send" id="btn-send" title="Senden">➤</button>
      </div>
      <qu-emoji-picker
        target="msg-input"
        trigger="btn-emoji"
        style="position:relative"
      ></qu-emoji-picker>
    `

    this._input       = this.querySelector('#msg-input')
    this._sendBtn     = this.querySelector('#btn-send')
    this._attachBtn   = this.querySelector('#btn-attach')
    this._stagedEl    = this.querySelector('#staged-files')
    this._dropZone    = this.querySelector('#blob-drop-zone')
    this._dropOverlay = this.querySelector('#drop-overlay')
    this._emojiBtn    = this.querySelector('#btn-emoji')
    this._textareaWrap = this.querySelector('.qm-composer-textarea-wrap')

    // Auto-grow textarea
    this._input.addEventListener('input', () => {
      this._input.style.height = 'auto'
      this._input.style.height = Math.min(this._input.scrollHeight, 140) + 'px'
    })

    // Send on Enter (Shift+Enter = newline)
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this._send()
      }
    })

    // Typing indicator (debounced, every 3s max)
    const sendTyping = _debounce(() => {
      if (this._presence && this._net && this._convId) {
        const spaceId = this._conv?.spaceId ?? this._conv?.contactPub?.slice(0, 16) ?? this._convId
        this._presence.sendTyping(this._net, spaceId).catch(() => {})
      }
    }, 3_000)
    this._input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') sendTyping()
    })

    // Send button
    this._sendBtn.addEventListener('click', () => this._send())

    // Attach button → trigger file picker inside qu-blob-drop
    this._attachBtn.addEventListener('click', () => {
      const fi = this._dropZone?.querySelector('input[type=file]')
      if (fi) fi.click()
    })

    // ── Drag-and-drop overlay on textarea wrapper ──────────────────────────
    this._textareaWrap.addEventListener('dragenter', (e) => {
      e.preventDefault()
      this._dropOverlay.classList.add('visible')
      this._dropZone.style.pointerEvents = 'auto'
    })

    this._textareaWrap.addEventListener('dragleave', (e) => {
      if (!this._textareaWrap.contains(e.relatedTarget)) {
        this._dropOverlay.classList.remove('visible')
        this._dropZone.style.pointerEvents = 'none'
      }
    })

    this._textareaWrap.addEventListener('dragover', (e) => {
      e.preventDefault()  // required to allow drop
    })

    // ── Listen for staged blobs — hide overlay and show chip ──────────────
    this.addEventListener('qu-blob-staged', (e) => {
      const { hash, meta } = e.detail
      this._stagedFiles.push({ hash, name: meta.name, mime: meta.mime, size: meta.size })
      this._renderStagedFiles()
      // Hide drop overlay after staging
      this._dropOverlay.classList.remove('visible')
      this._dropZone.style.pointerEvents = 'none'
    })

    // On mobile: emoji button focuses textarea (native keyboard provides emojis)
    if (_isMobile()) {
      this._emojiBtn.addEventListener('click', () => this._input.focus())
    }
  }

  async _loadConv() {
    if (!this._store || !this._convId) return
    const rows = await this._store.getConversations()
    this._conv = rows.find(q => q?.data?.convId === this._convId)?.data ?? null
  }

  _renderStagedFiles() {
    if (!this._stagedEl) return
    this._stagedEl.style.display = this._stagedFiles.length ? 'flex' : 'none'
    this._stagedEl.innerHTML = this._stagedFiles.map((f, i) => `
      <div class="qm-staged-chip" data-idx="${i}">
        <span>${f.mime?.startsWith('image/') ? '🖼' : '📎'} ${f.name ?? 'Datei'}</span>
        <button data-idx="${i}" title="Entfernen">✕</button>
      </div>
    `).join('')
    this._stagedEl.querySelectorAll('button[data-idx]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const idx = parseInt(btn.dataset.idx)
        this._stagedFiles.splice(idx, 1)
        this._renderStagedFiles()
      })
    })
  }

  async _send() {
    const text  = this._input.value.trim()
    const files = [...this._stagedFiles]

    if (!text && !files.length) return
    if (!this._store || !this._convId) return

    const msgData = {
      type:        files.length ? 'file' : 'text',
      text:        text || null,
      attachments: files.length ? files.map(f => ({
        hash: f.hash, name: f.name, mime: f.mime, size: f.size,
      })) : undefined,
    }

    // Clear input immediately for UX
    this._input.value   = ''
    this._input.style.height = 'auto'
    this._stagedFiles   = []
    this._renderStagedFiles()

    try {
      const key = await this._store.sendMessage(this._convId, msgData)
      this.dispatchEvent(new CustomEvent('qm-sent', { detail: { key }, bubbles: true }))
    } catch (e) {
      console.error('[QmComposer] sendMessage failed:', e)
    }
  }
}

export { QmComposer }
