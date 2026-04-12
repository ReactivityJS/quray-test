// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/ui/qm-app.js
// <qm-app> — root Messenger shell.
//
// Two-pane layout: <qm-sidebar> (left) + <qm-chat> + <qm-composer> (right)
// On mobile (< 640px): one panel at a time, back button to return to sidebar.
//
// Properties:
//   .messenger — MessengerPlugin instance ({ store, calls })
//   .db        — QuDB instance
//   .me        — local identity
//   .presence  — QuPresence (optional)
//   .net       — QuNet (optional, for typing signals)
// ════════════════════════════════════════════════════════════════════════════

class QmApp extends HTMLElement {
  set messenger(m) { this._messenger = m; this._boot() }
  set db(d)        { this._db = d; }
  set me(m)        { this._me = m; }
  set presence(p)  { this._presence = p; }
  set net(n)       { this._net = n; }

  connectedCallback() {
    this._activeConvId = null
    this._render()
    if (this._messenger) this._boot()
  }

  _render() {
    this.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden'
    this.innerHTML = `
      <qm-sidebar id="app-sidebar"></qm-sidebar>
      <div id="app-right" style="flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden">
        <qm-chat    id="app-chat"></qm-chat>
        <qm-composer id="app-composer"></qm-composer>
      </div>
      <qm-call-overlay id="app-call"></qm-call-overlay>
    `
    this._sidebar  = this.querySelector('#app-sidebar')
    this._chat     = this.querySelector('#app-chat')
    this._composer = this.querySelector('#app-composer')
    this._callOvl  = this.querySelector('#app-call')

    // Handle conversation selection from sidebar
    this.addEventListener('qm-conv-select', (e) => {
      this._selectConv(e.detail.convId)
    })

    // Mobile back button
    this.addEventListener('qm-back', () => {
      this._sidebar.classList.remove('hidden-mobile')
    })
  }

  _boot() {
    if (!this._messenger || !this._db) return

    const { store, calls } = this._messenger

    // Wire sidebar
    this._sidebar.store = store
    this._sidebar.db    = this._db

    // Wire chat
    this._chat.store    = store
    this._chat.db       = this._db
    this._chat.me       = this._me
    this._chat.calls    = calls
    this._chat.presence = this._presence

    // Wire composer
    this._composer.store    = store
    this._composer.db       = this._db
    this._composer.presence = this._presence
    this._composer.net      = this._net

    // Wire call overlay
    this._callOvl.db    = this._db
    this._callOvl.calls = calls
  }

  _selectConv(convId) {
    if (this._activeConvId === convId) return
    this._activeConvId = convId

    // Update sidebar active state
    this._sidebar.activeConvId = convId

    // Update chat
    this._chat.convId     = convId
    this._composer.convId = convId

    // Mobile: hide sidebar to show chat
    this._sidebar.classList.add('hidden-mobile')
  }
}

export { QmApp }
