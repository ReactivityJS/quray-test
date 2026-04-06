// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/qu-cms.js
// Minimal CMS plugin. Content, templates, and routes all live in QuDB.
// No server-side files needed.
//
// ┌─ Data Schema ───────────────────────────────────────────────────────────┐
// │  @{spaceId}/~acl                  → { owner, writers: [pub,...] | '*' }│
// │  @{spaceId}/~meta                 → { name, description }              │
// │  @{spaceId}/posts/{slug}/title    → 'Post Title'      (AtomicQuBit)    │
// │  @{spaceId}/posts/{slug}/excerpt  → 'Short preview'   (AtomicQuBit)    │
// │  @{spaceId}/posts/{slug}/status   → 'draft'|'published'                │
// │  @{spaceId}/posts/{slug}/author   → 'Alice'                            │
// │  @{spaceId}/posts/{slug}/tags     → ['tag1', 'tag2']                   │
// │  @{spaceId}/posts/{slug}/created  → timestamp                          │
// │  @{spaceId}/posts/{slug}/content  → '<article>...</article>'           │
// │  @{spaceId}/pages/{slug}          → '<div>Page HTML</div>'             │
// │  @{spaceId}/templates/{name}      → '<article>{{content}}</article>'   │
// │  conf/cms/settings                → { spaceId, spaceName }             │
// └─────────────────────────────────────────────────────────────────────────┘
//
// ┌─ Template Syntax ───────────────────────────────────────────────────────┐
// │  {{title}}     → post.title                                            │
// │  {{content}}   → post.content                                          │
// │  {{author}}    → post.author                                           │
// │  {{excerpt}}   → post.excerpt                                          │
// │  {{created}}   → formatted creation date                               │
// │  {{tags}}      → comma-separated tags                                  │
// │  qu-* attrs    → activated reactively by mountFn after rendering       │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Usage:
//   import { QuCMS } from './src/plugins/qu-cms.js'
//   const cms = await QuCMS.create(qr.db, router, qr.me, { spaceName: 'My Blog' })
//   await cms.createPost('my-first-post', { title: 'Hello', content: '<p>Hi</p>' })
//   const posts = await cms.loadPosts({ status: 'published' })
// ════════════════════════════════════════════════════════════════════════════

/** Generate a short URL-safe ID. */
const _uid = () => crypto.randomUUID().replace(/-/g,'').slice(0,16)

/** Convert a title to a URL slug. */
const _slug = (title = '') =>
  title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)

/** Replace {{variable}} placeholders in a template string. */
const _render = (template, vars) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')

/** Built-in fallback templates (used when no template QuBit is found). */
const DEFAULT_TEMPLATES = {
  'post': `<article class="post-view">
  <a class="back-link" onclick="history.back()">← Back</a>
  <h1>{{title}}</h1>
  <div class="post-meta">{{author}} · {{created}}</div>
  <div class="post-body">{{content}}</div>
</article>`,

  'page': `<div class="page-view">
  <h1>{{title}}</h1>
  <div>{{content}}</div>
</div>`,

  'list': `<div>
  <h2>Blog</h2>
  <div class="post-grid" id="cms-post-grid">Loading…</div>
</div>`,

  'home': `<div>
  <div class="cms-hero">
    <h1>{{name}}</h1>
    <p>{{description}}</p>
    <a onclick="location.hash='#/blog'" class="button-link" style="cursor:pointer">Read the blog →</a>
  </div>
  <div class="post-grid" id="cms-recent-posts">Loading…</div>
</div>`,
}

/** Post fields stored as individual atomic QuBits. */
const POST_FIELDS = ['title','excerpt','content','author','status','tags','created']


export class QuCMS {

  /**
   * Create a QuCMS instance. Loads or initialises the CMS space.
   *
   * @param {QuDBInstance}  db
   * @param {QuRouter}      router
   * @param {LocalPeer}     identity   - qr.me — needed for ownership checks and ACL
   * @param {object}        [opts]
   * @param {string}        [opts.spaceName='My Blog']
   * @param {string}        [opts.spaceDescription='']
   * @param {string}        [opts.spaceId]  - Force a specific space ID (use for existing spaces)
   * @returns {Promise<QuCMS>}
   */
  static async create(db, router, identity, opts = {}) {
    const cms = new QuCMS(db, router, identity, opts)
    await cms._boot()
    return cms
  }

  constructor(db, router, identity, opts = {}) {
    this.db          = db
    this.router      = router
    this.identity    = identity   // qr.me
    this.spaceName   = opts.spaceName        ?? 'My Blog'
    this.description = opts.spaceDescription ?? ''
    this._spaceId    = opts.spaceId          ?? null  // set during _boot
    this._mountFn    = opts.mountFn          ?? null  // activates qu-* after render
  }

  // ── Initialisation ────────────────────────────────────────────────────────

  async _boot() {
    // Load persisted space ID (survives page reloads)
    const settingsQubit = await this.db.get('conf/cms/settings').catch(() => null)
    if (settingsQubit?.data?.spaceId) {
      this._spaceId = settingsQubit.data.spaceId
    }

    if (!this._spaceId) {
      // First run — create a new UUID space for this CMS
      this._spaceId = '@' + _uid()
      await this._initSpace()
    }
  }

  async _initSpace() {
    const ownerPub = this.identity?.pub ?? this.identity?.pub64
    if (!ownerPub) throw new Error('QuCMS: identity required to create a space')

    // Create space ACL — owner writes, others can read
    await this.db.put(`${this._spaceId}/~acl`, { owner: ownerPub, writers: [ownerPub] })
    await this.db.put(`${this._spaceId}/~meta`, {
      name:        this.spaceName,
      description: this.description,
      created:     Date.now(),
    })

    // Persist space ID in local settings
    await this.db.put('conf/cms/settings', {
      spaceId:   this._spaceId,
      spaceName: this.spaceName,
    }, { sync: false })
  }

  // ── Space info ────────────────────────────────────────────────────────────

  /** The @uuid space prefix for all CMS content. */
  get space() { return this._spaceId }

  /** QuDB prefix for posts: @spaceId/posts/ */
  get postsPrefix() { return `${this._spaceId}/posts/` }

  /** QuDB prefix for pages: @spaceId/pages/ */
  get pagesPrefix() { return `${this._spaceId}/pages/` }

  /**
   * Check whether the current identity is the space owner.
   * Use this to guard the admin route.
   */
  async isOwner() {
    const acl = await this.db.get(`${this._spaceId}/~acl`).catch(() => null)
    if (!acl?.data?.owner) return false
    const ownerPub = this.identity?.pub ?? this.identity?.pub64
    return acl.data.owner === ownerPub
  }

  // ── Posts ─────────────────────────────────────────────────────────────────

  /**
   * Create a new post. Each field is stored as a separate atomic QuBit.
   * This is intentional: different peers can edit different fields without conflicts.
   *
   * @param {string} slug        - URL slug (auto-derived from title if omitted)
   * @param {object} fields
   * @param {string} fields.title
   * @param {string} [fields.content]
   * @param {string} [fields.excerpt]
   * @param {string} [fields.status='draft']
   * @param {string[]} [fields.tags=[]]
   * @returns {Promise<string>} slug
   */
  async createPost(slug, fields = {}) {
    const postSlug = slug || _slug(fields.title ?? 'untitled')
    const now      = Date.now()
    const author   = this.identity?.alias ?? 'Author'

    const data = {
      title:   fields.title   ?? 'Untitled',
      excerpt: fields.excerpt ?? '',
      content: fields.content ?? '<p>Write your content here…</p>',
      author:  fields.author  ?? author,
      status:  fields.status  ?? 'draft',
      tags:    fields.tags    ?? [],
      created: fields.created ?? now,
    }

    // Store each field as its own signed QuBit
    await Promise.all(
      POST_FIELDS.map(field =>
        this.db.put(`${this.postsPrefix}${postSlug}/${field}`, data[field])
      )
    )
    return postSlug
  }

  /**
   * Update a single field of a post atomically.
   * Only the changed field is written — no overwrites of other fields.
   *
   * @param {string} slug
   * @param {string} field  - must be in POST_FIELDS
   * @param {*}      value
   */
  async updatePost(slug, field, value) {
    if (!POST_FIELDS.includes(field)) throw new Error(`Unknown post field: ${field}`)
    await this.db.put(`${this.postsPrefix}${slug}/${field}`, value)
  }

  /**
   * Load all posts and group by slug.
   * Because posts are stored as atomic QuBits per field, we query the entire
   * posts/ prefix and group by the slug segment.
   *
   * @param {object} [filter]
   * @param {'draft'|'published'} [filter.status]  - filter by publication status
   * @param {number}              [filter.limit]
   * @param {string}              [filter.tag]      - filter by tag
   * @returns {Promise<PostObject[]>}
   */
  async loadPosts(filter = {}) {
    const qubits = await this.db.query(this.postsPrefix, { includeDeleted: false })

    // Group QuBits by slug (the path segment between posts/ and /fieldName)
    const postMap = {}
    for (const q of qubits) {
      const relative  = q.key.slice(this.postsPrefix.length)  // 'slug/title'
      const slashIdx  = relative.indexOf('/')
      if (slashIdx < 0) continue
      const postSlug  = relative.slice(0, slashIdx)
      const fieldName = relative.slice(slashIdx + 1)
      if (!postMap[postSlug]) postMap[postSlug] = { _slug: postSlug }
      if (POST_FIELDS.includes(fieldName)) postMap[postSlug][fieldName] = q.data
    }

    let posts = Object.values(postMap).filter(p => p.title)

    // Apply filters
    if (filter.status) posts = posts.filter(p => p.status === filter.status)
    if (filter.tag)    posts = posts.filter(p => Array.isArray(p.tags) && p.tags.includes(filter.tag))

    // Sort newest first
    posts.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    if (filter.limit) posts = posts.slice(0, filter.limit)

    return posts
  }

  /**
   * Delete a post (soft-deletes all its field QuBits).
   * @param {string} slug
   */
  async deletePost(slug) {
    const qubits = await this.db.query(`${this.postsPrefix}${slug}/`)
    await Promise.all(qubits.map(q => this.db.del(q.key)))
  }

  // ── Pages ─────────────────────────────────────────────────────────────────

  /**
   * Write page content. A page is a single QuBit (HTML string).
   * @param {string} slug
   * @param {string} html
   */
  async setPage(slug, html) {
    await this.db.put(`${this.pagesPrefix}${slug}`, html)
  }

  async getPage(slug) {
    const q = await this.db.get(`${this.pagesPrefix}${slug}`).catch(() => null)
    return typeof q?.data === 'string' ? q.data : null
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  /**
   * Store a template in QuDB. Templates are HTML strings with {{variable}} placeholders.
   * They can also contain qu-* directive attributes which are activated by mountFn.
   *
   * @param {string} name  - e.g. 'post', 'page', 'list', 'home'
   * @param {string} html  - Template HTML with {{variable}} placeholders
   */
  async setTemplate(name, html) {
    await this.db.put(`${this._spaceId}/templates/${name}`, html)
  }

  /**
   * Get a template from QuDB. Falls back to the built-in default if not found.
   * @param {string} name
   * @returns {Promise<string>} HTML template string
   */
  async getTemplate(name) {
    const q = await this.db.get(`${this._spaceId}/templates/${name}`).catch(() => null)
    return (typeof q?.data === 'string' && q.data)
      ? q.data
      : (DEFAULT_TEMPLATES[name] ?? DEFAULT_TEMPLATES['page'])
  }

  /**
   * Render a named template with variables.
   * {{variable}} placeholders are replaced, then the result is returned.
   * Call mountFn(el) after injecting into the DOM to activate qu-* elements.
   *
   * @param {string} templateName
   * @param {object} vars  - e.g. { title, content, author, excerpt, created, tags }
   * @returns {Promise<string>} rendered HTML
   */
  async render(templateName, vars = {}) {
    const template = await this.getTemplate(templateName)
    const formattedVars = {
      ...vars,
      created: vars.created
        ? new Date(vars.created).toLocaleDateString('en', { year:'numeric', month:'long', day:'numeric' })
        : '',
      tags: Array.isArray(vars.tags) ? vars.tags.join(', ') : (vars.tags ?? ''),
    }
    return _render(template, formattedVars)
  }

  /**
   * Render a post by slug using its template.
   * @param {string} slug
   * @returns {Promise<string>} rendered HTML or error message
   */
  async renderPost(slug) {
    const posts = await this.loadPosts()
    const post  = posts.find(p => p._slug === slug)
    if (!post) return `<p style="color:var(--muted)">Post not found: ${slug}</p>`
    return this.render('post', post)
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  /**
   * Register standard CMS routes with the router.
   * Call this once after creating the CMS to set up Home, Blog, and individual post routes.
   * The admin route is registered separately — call registerAdminRoute().
   */
  async registerRoutes() {
    const existing = this.router.getRoutes()

    if (!existing.find(r => r.path === '/')) {
      // Home page — renders the home template
      await this.db.put(`${this.pagesPrefix}home`, await this.getTemplate('home'))
      await this.router.addRoute({ path:'/', title:'Home', contentKey:`${this.pagesPrefix}home`, order:0 })
    }
    if (!existing.find(r => r.path === '/blog')) {
      await this.router.addRoute({ path:'/blog', title:'Blog', order:1 })  // rendered by JS
    }
  }

  /**
   * Register the admin panel as a route.
   * The admin route has no title (hidden from nav) and no contentKey (rendered by JS).
   * The CMS demo checks isOwner() before showing the admin UI.
   *
   * @param {string} [path='/admin']
   */
  async registerAdminRoute(path = '/admin') {
    const existing = this.router.getRoutes()
    if (!existing.find(r => r.path === path)) {
      await this.router.addRoute({ path, order: 99 })  // no title = hidden from nav
    }
  }

  /**
   * Subscribe to reactive post changes.
   * Fires when any post field is created, updated, or deleted.
   * @param {function} callback  - fn() called on change
   * @returns {function} off
   */
  onPostsChange(callback) {
    return this.db.on('**', (q, { key }) => {
      if (key?.startsWith(this.postsPrefix)) callback()
    })
  }
}

export { DEFAULT_TEMPLATES, POST_FIELDS }
