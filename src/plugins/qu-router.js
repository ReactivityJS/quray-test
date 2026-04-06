// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/qu-router.js
// Minimal hash-based SPA router. Routes are stored as atomic QuBits in QuDB.
//
// Storage schema (one QuBit per field under the configured prefix):
//   {prefix}{id}/path        → '/about'
//   {prefix}{id}/title       → 'About'    (null/missing = hidden from nav)
//   {prefix}{id}/space       → '@uuid'    (optional ACL space for auth checks)
//   {prefix}{id}/contentKey  → '@space/pages/about'  (QuDB key for content)
//   {prefix}{id}/order       → 10         (nav sort order)
//
// Content model:
//   Any QuDB key can serve as contentKey. The router reads q.data (a string)
//   and sets it as the outlet innerHTML. After injection, mountFn(outletEl)
//   is called to activate qu-* directives and custom elements reactively.
//
// Usage:
//   import { QuRouter } from './src/plugins/qu-router.js'
//   const router = await QuRouter.create(qr.db, {
//     prefix:  'conf/router/',
//     outlet:  '#app',
//     mountFn: el => qr._.ui.directives.mount(el),
//   })
//   await router.addRoute({ path:'/about', title:'About', contentKey:'@space/pages/about' })
//   router.navigate('/about')
// ════════════════════════════════════════════════════════════════════════════

const _uid = () => crypto.randomUUID().replace(/-/g,'').slice(0,12)

/** Fields stored as separate QuBits per route. */
const ROUTE_FIELDS = ['path','title','space','contentKey','order']

/**
 * Reconstruct route objects from a flat list of QuBits.
 * Groups by route ID (first path segment after the prefix).
 */
function _groupRoutes(qubits, prefix) {
  const routeMap = {}
  for (const q of qubits) {
    if (q.deleted) continue
    const relativePath = q.key.slice(prefix.length)   // e.g. 'abc123/path'
    const slashIndex   = relativePath.indexOf('/')
    if (slashIndex < 0) continue
    const routeId = relativePath.slice(0, slashIndex)
    const field   = relativePath.slice(slashIndex + 1)
    if (!routeMap[routeId]) routeMap[routeId] = { _id: routeId }
    if (ROUTE_FIELDS.includes(field)) routeMap[routeId][field] = q.data
  }
  return Object.values(routeMap).filter(r => r.path)
}

export class QuRouter {

  /**
   * Create and boot a QuRouter instance.
   * @param {QuDBInstance} db
   * @param {object} opts
   * @param {string}   [opts.prefix='conf/router/']  - QuDB prefix for route storage
   * @param {string}   [opts.outlet='#qu-outlet']    - CSS selector for the content outlet
   * @param {function} [opts.mountFn]                - Called with outletEl after innerHTML is set.
   *                                                   Use to activate qu-* directives:
   *                                                   el => qr._.ui.directives.mount(el)
   * @returns {Promise<QuRouter>}
   */
  static async create(db, opts = {}) {
    const router = new QuRouter(db, opts)
    await router._boot()
    return router
  }

  constructor(db, opts = {}) {
    this.db             = db
    this.prefix         = opts.prefix    ?? 'conf/router/'
    this.outlet         = opts.outlet    ?? '#qu-outlet'
    this._mountFn       = opts.mountFn   ?? null
    this._routes        = []
    this._navCallbacks  = []
    this._dbOff         = null
    this._navigating    = false   // re-entrancy guard
    this._currentPath   = '/'
  }

  async _boot() {
    await this._reloadRoutes()

    // Watch only the router prefix — '**' would react to content writes and cause infinite loops.
    // We use '**' with a prefix guard instead of 'conf/router/**' because the prefix is configurable.
    this._dbOff = this.db.on('**', (q, { key }) => {
      if (key?.startsWith(this.prefix) && !this._navigating) {
        this._reloadRoutes().then(() =>
          this._navCallbacks.forEach(cb => cb(this._currentPath, this._match(this._currentPath)))
        )
      }
    })

    window.addEventListener('hashchange', () =>
      this.navigate(location.hash.slice(1) || '/')
    )
  }

  async _reloadRoutes() {
    const qubits = await this.db.query(this.prefix, { order: 'key' })
    this._routes = _groupRoutes(qubits, this.prefix)
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
  }

  /** Returns a copy of all registered routes. */
  getRoutes() { return [...this._routes] }

  /**
   * Find the best matching route for a path.
   * Exact match takes priority; falls back to prefix match.
   */
  _match(path) {
    return this._routes.find(r => r.path === path)
      ?? this._routes.find(r => path.startsWith(r.path + '/') && r.path !== '/')
      ?? null
  }

  /**
   * Navigate to a path — loads contentKey from QuDB and injects into the outlet.
   * Calls mountFn(outletEl) after injection to activate qu-* elements.
   * @param {string} path
   */
  async navigate(path = '/') {
    if (this._navigating) return
    this._navigating   = true
    this._currentPath  = path
    const outletEl     = document.querySelector(this.outlet)

    if (!outletEl) { this._navigating = false; return }

    const route = this._match(path)
    this._navCallbacks.forEach(cb => cb(path, route))

    if (!route) {
      outletEl.innerHTML = `<p style="color:var(--muted);padding:2rem">
        404 — No route for <code>${path}</code></p>`
      this._navigating = false
      return
    }

    if (route.contentKey) {
      const qubit = await this.db.get(route.contentKey).catch(() => null)
      outletEl.innerHTML = typeof qubit?.data === 'string' ? qubit.data : ''
      this._mountFn?.(outletEl)
    } else {
      // No contentKey — navigation callbacks handle rendering (e.g. dynamic blog post routes)
      if (!route._handled) {
        outletEl.innerHTML = `<p style="color:var(--muted);padding:2rem">
          Route <code>${path}</code> has no contentKey.</p>`
      }
    }

    this._updateActiveLinks(path)
    this._navigating = false
  }

  /** Register a callback fired on every navigation, including 404s. */
  onNavigate(callback) { this._navCallbacks.push(callback) }

  /** Highlight elements with data-router-link attributes matching the current path. */
  _updateActiveLinks(path) {
    document.querySelectorAll('[data-router-link]').forEach(el => {
      const linkPath = el.getAttribute('data-router-link')
      el.classList.toggle('active',
        linkPath === path || (path.startsWith(linkPath) && linkPath !== '/'))
    })
  }

  // ── Route management ─────────────────────────────────────────────────────

  /**
   * Add a new route. Each field is stored as a separate atomic QuBit.
   * @param {object} data - { path, title, contentKey, space, order }
   * @returns {Promise<string>} routeId
   */
  async addRoute(data) {
    const routeId = data._id ?? _uid()
    const baseKey = this.prefix + routeId + '/'
    await Promise.all(
      ROUTE_FIELDS
        .filter(field => data[field] != null)
        .map(field => this.db.put(baseKey + field, data[field], { sync: false }))
    )
    await this._reloadRoutes()
    return routeId
  }

  /**
   * Update fields of an existing route atomically.
   * @param {string} routeId
   * @param {object} changes - partial { path, title, contentKey, order, ... }
   */
  async updateRoute(routeId, changes) {
    const baseKey = this.prefix + routeId + '/'
    await Promise.all(
      Object.entries(changes)
        .filter(([field]) => ROUTE_FIELDS.includes(field))
        .map(([field, value]) => this.db.put(baseKey + field, value, { sync: false }))
    )
    await this._reloadRoutes()
  }

  /**
   * Delete a route (soft-deletes all its field QuBits).
   * @param {string} routeId
   */
  async deleteRoute(routeId) {
    const qubits = await this.db.query(this.prefix + routeId + '/')
    await Promise.all(qubits.map(q => this.db.del(q.key)))
    await this._reloadRoutes()
  }

  /** Remove all listeners and event handlers. */
  destroy() {
    this._dbOff?.()
    this._navCallbacks = []
  }
}
