// ════════════════════════════════════════════════════════════════════════════
// QuRay — ui/directives.js
// Optional directive layer for attribute-based UI binding.
// It is intentionally separate from the core component API and can be used
// independently when a project prefers plain HTML plus qu-* directives.
// ════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Resolve a relative directive path against the nearest inherited scope.
const resolveDirectiveKey = (scopeKey, path) => {
  if (!path) return scopeKey
  // Absolute storage key: already namespaced or path-like.
  if (path.includes('/') || path.startsWith('~') || path.startsWith('@') || path.startsWith('>'))
    return path
  // Relative path: append to the current scope key.
  return scopeKey ? scopeKey.replace(/\/$/, '') + '/' + path : path
}

// Find the nearest inherited directive scope.
const findDirectiveScopeKey = (element) => {
  let node = element.parentElement
  while (node) {
    if (node.hasAttribute('qu-scope')) return node.getAttribute('qu-scope') || ''
    if (node.hasAttribute('qu-for'))  return node.__quItemKey || ''
    node = node.parentElement
  }
  return ''
}

// Read a nested field path from a value object.
const getNestedDirectiveValue = (valueObject, path) => {
  if (!path || valueObject == null) return valueObject
  return path.split('.').reduce((currentValue, segment) => currentValue?.[segment], valueObject)
}


// ─────────────────────────────────────────────────────────────────────────────
// DIRECTIVE HANDLERS
// Each directive handler receives (element, value, scopeKey, database) and may return a cleanup function.
// ─────────────────────────────────────────────────────────────────────────────

const _directives = new Map()

// Register or replace a directive handler.
export const registerDirective = (name, handler) => _directives.set(name, handler)

// ── qu-text ──────────────────────────────────────────────────────────────────
registerDirective('qu-text', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => {
    if (val === null || val === undefined) { el.textContent = ''; return }
    el.textContent = typeof val === 'object' ? JSON.stringify(val) : String(val)
  }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-html ──────────────────────────────────────────────────────────────────
registerDirective('qu-html', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => { el.innerHTML = val == null ? '' : String(val) }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-src ───────────────────────────────────────────────────────────────────
registerDirective('qu-src', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => { if (val) el.src = String(val) }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-href ──────────────────────────────────────────────────────────────────
registerDirective('qu-href', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => { if (val) el.href = String(val) }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-value ─────────────────────────────────────────────────────────────────
registerDirective('qu-value', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => { el.value = val == null ? '' : String(val) }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-checked ───────────────────────────────────────────────────────────────
registerDirective('qu-checked', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => { el.checked = Boolean(val) }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-show ──────────────────────────────────────────────────────────────────
registerDirective('qu-show', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => { el.style.display = val ? '' : 'none' }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-class ─────────────────────────────────────────────────────────────────
// Format: "field:className" oder "field:classIfTrue:classIfFalse"
// Beispiel: qu-class="done:qu-done:qu-pending"
registerDirective('qu-class', (el, spec, scope, db) => {
  const [path, classTrue = '', classFalse = ''] = spec.split(':')
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => {
    if (classTrue)  el.classList.toggle(classTrue,  Boolean(val))
    if (classFalse) el.classList.toggle(classFalse, !Boolean(val))
  }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-time ──────────────────────────────────────────────────────────────────
// Render a timestamp in the current locale and mirror it to <time datetime>.
registerDirective('qu-time', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => {
    if (!val) return
    try {
      const d = new Date(typeof val === 'object' ? (val.ts ?? val) : val)
      const now = new Date()
      const isToday = d.toDateString() === now.toDateString()
      const opts = isToday
        ? { hour: '2-digit', minute: '2-digit' }
        : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
      el.textContent = d.toLocaleString(navigator.language || 'en', opts)
      if (el.tagName === 'TIME') el.setAttribute('datetime', d.toISOString())
    } catch { el.textContent = String(val) }
  }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})

// ── qu-e2e ───────────────────────────────────────────────────────────────────
// Setzt qu-e2e-on/qu-e2e-off Klasse + text je nachdem ob epub vorhanden.
registerDirective('qu-e2e', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const update = (val) => {
    const hasE2E = Boolean(val && typeof val === 'string' && val.length > 20)
    el.classList.toggle('qu-e2e-on',  hasE2E)
    el.classList.toggle('qu-e2e-off', !hasE2E)
    el.textContent = hasE2E ? 'E2E' : '—'
    el.title = hasE2E ? 'End-to-end encrypted' : 'No encryption'
  }
  db.get(key).then(update).catch(() => {})
  return db.on(key, update)
})


// ── qu-model ─────────────────────────────────────────────────────────────────
// Two-way binding between a form control and a storage key.
// Reads the initial value from QuDB and writes changes back on input/change.
// Supports <input>, <textarea>, <select>, and checkbox inputs.
//
// Beispiele:
//   <input qu-model="alias">            ← schreibt direkt den Wert
//   <input type="checkbox" qu-model="done">   ← schreibt Boolean
registerDirective('qu-model', (el, path, scope, db) => {
  const key = resolveDirectiveKey(scope, path)
  const isCheckbox = el.type === 'checkbox'
  const isNumber   = el.type === 'number' || el.type === 'range'

  // DB → Element
  const update = (val) => {
    if (val === null || val === undefined) return
    if (isCheckbox) el.checked = Boolean(val)
    else el.value = String(val)
  }
  db.get(key).then(update).catch(() => {})
  const off = db.on(key, update)

  // Element -> QuDB write path with a short debounce for text-like controls.
  let _t = null
  const write = () => {
    clearTimeout(_t)
    _t = setTimeout(() => {
      const raw = isCheckbox ? el.checked : el.value
      const val = isNumber ? Number(raw) : raw
      db.put(key, val).catch(() => {})
    }, el.tagName === 'SELECT' || isCheckbox ? 0 : 150)
  }
  el.addEventListener('input',  write)
  el.addEventListener('change', write)

  return () => {
    off()
    clearTimeout(_t)
    el.removeEventListener('input',  write)
    el.removeEventListener('change', write)
  }
})


// ── qu-on ─────────────────────────────────────────────────────────────────────
// Event directive that triggers a QuDB write.
// Format: "eventName->keyOrAction"  oder  "click->~{pub}/action"
//
// Special actions:
//   click->del   → db.del(qu-scope key)
//   click->toggle:field → db.put(key, !currentVal)
//
// Beispiele:
//   <button qu-on="click->@{spaceId}/~reset">Reset</button>
//   <button qu-on="click->del">Delete current item</button>
//   <button qu-on="click->toggle:done">Toggle</button>
registerDirective('qu-on', (el, spec, scope, db) => {
  const sep = spec.indexOf('->')
  if (sep < 0) return () => {}

  const eventName = spec.slice(0, sep).trim()
  const action    = spec.slice(sep + 2).trim()

  const handler = async (e) => {
    e.stopPropagation()

    if (action === 'del') {
      const delKey = el.closest('[qu-item-key]')?.getAttribute('qu-item-key') ?? scope
      if (delKey) db.del(delKey).catch(() => {})
      return
    }

    if (action.startsWith('toggle:')) {
      const field   = action.slice(7)
      const togKey  = resolveDirectiveKey(scope, field)
      const current = await db.get(togKey)
      db.put(togKey, !current).catch(() => {})
      return
    }

    // Normaler Key-Write: schreibe Timestamp (= "ping/event" Pattern)
    const key = resolveDirectiveKey(scope, action)
    db.put(key, { ts: Date.now(), by: el.dataset.by || null }).catch(() => {})
  }

  el.addEventListener(eventName, handler)
  return () => el.removeEventListener(eventName, handler)
})


// ─────────────────────────────────────────────────────────────────────────────
// QU-SCOPE — Scope carrier element
// Each scope defines the base key for child directives.
// It can be used as a Custom Element or as an attribute on any element.
// ─────────────────────────────────────────────────────────────────────────────

class QuScope extends HTMLElement {
  connectedCallback() {
    this._offs = []
    this._db   = null
    // The element itself acts as the scope carrier.
    if (!this.hasAttribute('qu-scope')) this.setAttribute('qu-scope', this.getAttribute('path') || '')
  }
  disconnectedCallback() {
    this._offs.forEach(off => off?.())
    this._offs = []
  }
  setDb(db) {
    this._db = db
    // Direktiven innerhalb dieses Scopes mounten
    if (this.isConnected) _mountIn(this, db, this._offs)
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// QU-FOR — Reactive list renderer
//
// <ul qu-for="@{spaceId}/todos/" qu-order="ts" qu-limit="50">
//   <template>
//     <li>
//       <span qu-text="text"></span>
//       <input type="checkbox" qu-checked="done">
//     </li>
//   </template>
// </ul>
//
// Render one template instance for every QuBit under the configured prefix.
// Update automatically when matching items are created, changed, or deleted.
// ─────────────────────────────────────────────────────────────────────────────

class QuFor extends HTMLElement {
  connectedCallback() {
    this._offs = []
    this._db   = null
  }
  disconnectedCallback() {
    this._offs.forEach(off => off?.())
    this._offs = []
  }
  setDb(db) {
    this._db = db
    this._mount()
  }
  _mount() {
    if (!this._db) return
    const prefix  = this.getAttribute('qu-for') || this.getAttribute('prefix') || ''
    const order   = this.getAttribute('qu-order') || this.getAttribute('order') || 'ts'
    const limit   = parseInt(this.getAttribute('qu-limit') || this.getAttribute('limit') || '200')
    const tmpl    = this.querySelector('template')
    if (!tmpl || !prefix) return

    // Initial render
    this._render(prefix, order, limit, tmpl)

    // Re-render when matching items change.
    const off = this._db.on(prefix + '**', () => this._render(prefix, order, limit, tmpl))
    this._offs.push(off)
  }
  async _render(prefix, order, limit, tmpl) {
    const items    = await this._db.query(prefix, { order, limit })
    const existing = new Map()
    this.querySelectorAll('[qu-item-key]').forEach(el => existing.set(el.getAttribute('qu-item-key'), el))

    const rendered = new Set()

    for (let idx = 0; idx < items.length; idx++) {
      const qubit = items[idx]
      const key   = qubit.key
      rendered.add(key)

      let item = existing.get(key)
      if (!item) {
        // Clone the item template.
        item = tmpl.content.cloneNode(true).firstElementChild
        if (!item) continue
        item.setAttribute('qu-item-key', key)
        item.__quItemKey = key
        item.__quItemData = qubit.data
        // Expose the item key as the inherited directive scope.
        item.setAttribute('qu-scope', key)
        this.appendChild(item)
        // Mount nested directives inside the rendered item.
        const itemOffs = []
        _mountIn(item, this._db, itemOffs, qubit.data)
        item.__quOffs = itemOffs
      }
      // Preserve the requested DOM order.
      const current = this.children[idx]
      if (current && current !== item) this.insertBefore(item, current)
    }

    // Remove stale item nodes.
    for (const [key, el] of existing) {
      if (!rendered.has(key)) {
        el.__quOffs?.forEach(off => off?.())
        el.remove()
      }
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// DIRECTIVE MOUNTING
// Scan a DOM subtree and attach directive handlers.
// ─────────────────────────────────────────────────────────────────────────────

const DIRECTIVE_ATTRS = ['qu-text','qu-html','qu-src','qu-href','qu-value','qu-checked',
                         'qu-show','qu-class','qu-time','qu-e2e','qu-model','qu-on']

// Mount every supported directive inside a root element.
// offs collects cleanup functions for the mounted subtree.
const _mountIn = (root, db, offs, _itemData = null) => {
  // Resolve nested scope carriers first.
  root.querySelectorAll('[qu-scope]').forEach(scopeEl => {
    const childOffs = []
    offs.push(() => childOffs.forEach(off => off?.()))
    _mountIn(scopeEl, db, childOffs)
  })

  // Mount directives on all matching descendants.
  DIRECTIVE_ATTRS.forEach(attr => {
    root.querySelectorAll(`[${attr}]`).forEach(el => {
      // Scope-Pfad ermitteln
      const scope = findDirectiveScopeKey(el)
      const val   = el.getAttribute(attr)
      if (!val) return

      const handler = _directives.get(attr)
      if (!handler) return

      const off = handler(el, val, scope, db)
      if (off) offs.push(off)
    })
  })

  // Mount directives on the root element itself when needed.
  DIRECTIVE_ATTRS.forEach(attr => {
    if (!root.hasAttribute(attr)) return
    const scope   = findDirectiveScopeKey(root)
    const val     = root.getAttribute(attr)
    const handler = _directives.get(attr)
    if (handler && val) {
      const off = handler(root, val, scope, db)
      if (off) offs.push(off)
    }
  })
}


// ─────────────────────────────────────────────────────────────────────────────
// QU-DIRECTIVES FACTORY
// Connect the directive layer to a QuDB instance.
//
// const directives = QuDirectives(db)
// directives.init()       -> scan the DOM and start listeners
// directives.mount(el)    -> mount a dynamically created subtree
// directives.destroy()    -> remove all listeners
// ─────────────────────────────────────────────────────────────────────────────

const QuDirectives = (db) => {
  const _offs = []

  const _scan = () => {
    // qu-for elements
    document.querySelectorAll('qu-for, [qu-for]').forEach(el => {
      if (el._quMounted) return
      el._quMounted = true
      if (el.setDb) { el.setDb(db); return }
      // Attribut auf normalen Elementen → erstelle interne Instanz
      const forEl = el
      const itemOffs = []
      _offs.push(() => itemOffs.forEach(off => off?.()))
      const prefix = forEl.getAttribute('qu-for')
      const order  = forEl.getAttribute('qu-order') || 'ts'
      const limit  = parseInt(forEl.getAttribute('qu-limit') || '200')
      const tmpl   = forEl.querySelector('template')
      if (tmpl && prefix) {
        const _render = async () => {
          const items    = await db.query(prefix, { order, limit })
          const existing = new Map()
          forEl.querySelectorAll('[qu-item-key]').forEach(el => existing.set(el.getAttribute('qu-item-key'), el))
          const rendered = new Set()
          for (let idx = 0; idx < items.length; idx++) {
            const qubit = items[idx]
            rendered.add(qubit.key)
            let item = existing.get(qubit.key)
            if (!item) {
              item = tmpl.content.cloneNode(true).firstElementChild
              if (!item) continue
              item.setAttribute('qu-item-key', qubit.key)
              item.setAttribute('qu-scope', qubit.key)
              item.__quItemKey = qubit.key
              forEl.appendChild(item)
              const iOffs = []
              itemOffs.push(() => iOffs.forEach(o => o?.()))
              _mountIn(item, db, iOffs)
            }
            const cur = forEl.children[idx]
            if (cur && cur !== item) forEl.insertBefore(item, cur)
          }
          for (const [key, el] of existing)
            if (!rendered.has(key)) el.remove()
        }
        _render()
        const off = db.on(prefix + '**', _render)
        itemOffs.push(off)
      }
    })

    // qu-scope elements (custom elements and plain attributes)
    document.querySelectorAll('qu-scope, [qu-scope]').forEach(el => {
      if (el._quMounted) return
      el._quMounted = true
      if (el.setDb) { el.setDb(db); return }
      const elOffs = []
      _offs.push(() => elOffs.forEach(off => off?.()))
      _mountIn(el, db, elOffs)
    })

    // Directives on the root level without an explicit scope wrapper.
    _mountIn(document.body, db, _offs)
  }

  const init = () => {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', _scan)
    else
      _scan()
    return api
  }

  // Mount a single dynamically created subtree.
  // Activates ALL qu-* elements including qu-for and qu-scope.
  const mount = (el) => {
    const offs = []
    _offs.push(() => offs.forEach(off => off?.()))

    // Clear stale _quMounted flags from previous renders of the same outlet
    el.querySelectorAll('[_quMounted],[qu-scope],[qu-for]').forEach(e => {
      e._quMounted = false
    })

    // Activate qu-for elements in this subtree
    el.querySelectorAll('qu-for, [qu-for]').forEach(forEl => {
      if (forEl._quMounted) return
      forEl._quMounted = true
      if (forEl.setDb) { forEl.setDb(db); return }
      // Plain attribute on a non-custom-element
      const prefix = forEl.getAttribute('qu-for')
      const order  = forEl.getAttribute('qu-order') || 'ts'
      const limit  = parseInt(forEl.getAttribute('qu-limit') || '200')
      const tmpl   = forEl.querySelector('template')
      if (tmpl && prefix) {
        const _render = async () => {
          const items    = await db.query(prefix, { order, limit })
          const existing = new Map()
          forEl.querySelectorAll('[qu-item-key]').forEach(e => existing.set(e.getAttribute('qu-item-key'), e))
          const rendered = new Set()
          for (let idx = 0; idx < items.length; idx++) {
            const qubit = items[idx]
            rendered.add(qubit.key)
            let item = existing.get(qubit.key)
            if (!item) {
              item = tmpl.content.cloneNode(true).firstElementChild
              if (!item) continue
              item.setAttribute('qu-item-key', qubit.key)
              item.setAttribute('qu-scope', qubit.key)
              item.__quItemKey = qubit.key
              forEl.appendChild(item)
              const iOffs = []
              offs.push(() => iOffs.forEach(o => o?.()))
              _mountIn(item, db, iOffs)
            }
            const cur = forEl.children[idx]
            if (cur && cur !== item) forEl.insertBefore(item, cur)
          }
          for (const [key, stale] of existing) {
            if (!rendered.has(key)) { stale.__quOffs?.forEach(o => o?.()); stale.remove() }
          }
        }
        _render()
        const off = db.on(prefix + '**', _render)
        offs.push(off)
      }
    })

    // Activate qu-scope elements in this subtree
    el.querySelectorAll('qu-scope, [qu-scope]').forEach(scopeEl => {
      if (scopeEl._quMounted) return
      scopeEl._quMounted = true
      if (scopeEl.setDb) { scopeEl.setDb(db); return }
      const elOffs = []
      offs.push(() => elOffs.forEach(off => off?.()))
      _mountIn(scopeEl, db, elOffs)
    })

    // Activate inline directives (qu-text, qu-key etc.) on the subtree root
    _mountIn(el, db, offs)

    return () => offs.forEach(off => off?.())
  }

  const destroy = () => {
    _offs.forEach(off => off?.())
    _offs.length = 0
  }

  const api = { init, mount, destroy, register: registerDirective }
  return api
}


// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM ELEMENT REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

const registerDirectiveComponents = () => {
  if (!customElements.get('qu-scope')) customElements.define('qu-scope', QuScope)
  if (!customElements.get('qu-for'))   customElements.define('qu-for',   QuFor)
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export {
  QuDirectives,
  QuScope,
  QuFor,
  registerDirectiveComponents,
  DIRECTIVE_ATTRS,
}
