// ════════════════════════════════════════════════════════════════════════════
// QuRay demos — demo-session.js
// ════════════════════════════════════════════════════════════════════════════

const SESSION_KEY = 'QuDB_relay_session'

// Smart relay default: same host, matching WS protocol
export function defaultRelayUrl() {
  if (typeof location === 'undefined') return 'ws://localhost:8080'
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}

export function RelaySession() {
  const get = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) } catch { return null } }
  const save = d => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({...(get()??{}), ...d, savedAt:Date.now()})) } catch {} }
  const clear = () => { try { sessionStorage.removeItem(SESSION_KEY) } catch {} }
  const isConnected = () => !!get()?.relayUrl
  const relayUrl  = () => get()?.relayUrl ?? null
  const apiKey    = () => get()?.apiKey ?? null
  return { get, save, clear, isConnected, relayUrl, apiKey }
}

// ── Demos navigation ─────────────────────────────────────────────────────────
export const DEMOS = [
  { href:'/demo/index.html',         label:'🏠' },
  { href:'/demo/messenger.html',     label:'Messenger' },
  { href:'/demo/blob-test.html',     label:'Blob' },
  { href:'/demo/bindings-test.html', label:'Bindings' },
  { href:'/demo/todo.html',          label:'ToDo' },
  { href:'/demo/db-viewer.html',     label:'DB-Viewer' },
  { href:'/demo/people.html',        label:'People' },
  { href:'/demo/status.html',         label:'Status' },
  { href:'/demo/delivery-status.html', label:'Delivery' },
  { href:'/demo/cms.html', label:'CMS' },
  { href:'/demo/base.html',          label:'Base' },
]

export function injectDemoNav() {
  const nav = document.createElement('nav')
  nav.style.cssText='display:flex;gap:6px;flex-wrap:wrap;padding:6px 0 10px;border-bottom:1px solid var(--border);margin-bottom:14px'
  nav.innerHTML = DEMOS.map(({ href, label }) => {
    const active = location.pathname.endsWith(href.replace('/demo','')) || location.pathname === href
    return `<a href="${href}" class="button-link" style="font-size:12px;padding:5px 9px${active?';border-color:var(--primary);background:rgba(103,183,255,.12)':''}">${label}</a>`
  }).join('')
  document.body.insertBefore(nav, document.body.firstChild)
}

// ── Relay connector widget ────────────────────────────────────────────────────
export function renderRelayConnector(container, session, { onConnect, onDisconnect } = {}) {
  const render = () => {
    const connected = session.isConnected()
    const def = defaultRelayUrl()
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;
        padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="status-pill ${connected?'ok':'warn'}" id="_rc_pill">${connected?'⬤ '+session.relayUrl():'○ Kein Relay'}</span>
        </div>
        <div class="demo-actions" style="gap:6px">
          <button id="_rc_toggle" class="${connected?'warning':'primary'}" style="font-size:12px;padding:5px 9px">${connected?'Trennen':'Relay…'}</button>
          <button id="_rc_clear" style="font-size:12px;padding:5px 9px">Session löschen</button>
        </div>
      </div>
      <div id="_rc_form" ${connected?'hidden':''} style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <input id="_rc_url" class="demo-input" style="flex:2;min-width:200px" placeholder="Relay URL" value="${session.relayUrl()??def}">
        <input id="_rc_key" class="demo-input" style="flex:1;min-width:120px" placeholder="API-Key" value="${session.apiKey()??''}">
        <button id="_rc_save" class="success">Verbinden</button>
      </div>`

    document.getElementById('_rc_toggle').onclick = () => {
      if (connected) { session.save({ relayUrl:null, apiKey:null }); render(); onDisconnect?.() }
      else { document.getElementById('_rc_form').hidden = false }
    }
    document.getElementById('_rc_clear').onclick = () => { session.clear(); render(); onDisconnect?.() }
    document.getElementById('_rc_save')?.addEventListener('click', () => {
      const url = document.getElementById('_rc_url').value.trim()
      const key = document.getElementById('_rc_key').value.trim() || null
      if (!url) return
      session.save({ relayUrl:url, apiKey:key }); render(); onConnect?.({ relayUrl:url, apiKey:key })
    })
  }
  render()
  return { refresh: render }
}
