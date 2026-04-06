# QuCMS + QuRouter — Developer Guide

Two lightweight QuRay plugins for building serverless CMS-driven apps.
All content, routes, and templates live in QuDB — no static HTML files on the server needed.

---

## Files

| File | Description |
|------|-------------|
| `src/plugins/qu-cms.js`    | CMS plugin: posts, pages, templates, ACL |
| `src/plugins/qu-router.js` | Hash-based SPA router |
| `demo/cms.html`            | Full blog demo with admin panel |

---

## Quickstart

```js
import QuRay, { registerComponents, registerDirectiveComponents } from './src/quray.js'
import { QuRouter } from './src/plugins/qu-router.js'
import { QuCMS }    from './src/plugins/qu-cms.js'

const qr = await QuRay.init({ alias: 'Alice', relay: 'wss://…', ui: true, directives: true })

// Register qu-* custom elements so they activate reactively
registerComponents(qr.db, { me: qr.me })
registerDirectiveComponents()

// Router: renders content from QuDB into #app
const router = await QuRouter.create(qr.db, {
  prefix:  'conf/router/',
  outlet:  '#app',
  mountFn: el => qr._.ui.directives.mount(el),  // activates qu-* after navigation
})

// CMS: creates a UUID space, manages posts/pages/templates
const cms = await QuCMS.create(qr.db, router, qr.me, {
  spaceName:        'My Blog',
  spaceDescription: 'A reactive blog on QuRay',
})
```

---

## Data Schema

All CMS content is stored in a UUID space (`@{id}`). The space ID is generated on first run
and persisted in `conf/cms/settings` (local-only, survives reloads).

```
@{id}/~acl                       → { owner: pub, writers: [pub,...] | '*' }
@{id}/~meta                      → { name, description, created }
@{id}/posts/{slug}/title         → 'Post Title'           (AtomicQuBit)
@{id}/posts/{slug}/excerpt       → 'Short preview text'   (AtomicQuBit)
@{id}/posts/{slug}/status        → 'draft' | 'published'  (AtomicQuBit)
@{id}/posts/{slug}/author        → 'Alice'                (AtomicQuBit)
@{id}/posts/{slug}/tags          → ['tag1', 'tag2']       (AtomicQuBit)
@{id}/posts/{slug}/created       → 1700000000             (AtomicQuBit)
@{id}/posts/{slug}/content       → '<article>…</article>' (AtomicQuBit)
@{id}/pages/{slug}               → '<div>HTML…</div>'     (single QuBit)
@{id}/templates/{name}           → '<article>{{content}}</article>'
conf/cms/settings                → { spaceId, spaceName }  (local-only)
conf/router/{id}/path            → '/about'                (AtomicQuBit)
conf/router/{id}/title           → 'About'
conf/router/{id}/contentKey      → '@id/pages/about'
conf/router/{id}/order           → 2
```

### Why atomic QuBits per post field?

Each field (`title`, `content`, `status`, …) is stored as a **separate** QuBit.
This means:

- Two peers can edit different fields simultaneously without conflict
- Changing `status` to `published` doesn't require re-writing the full post
- `db.on('@id/posts/slug/status', handler)` gives reactive updates to a specific field
- Last-Write-Wins conflict resolution works at the field level, not the document level

---

## QuCMS API

### Creating the CMS

```js
const cms = await QuCMS.create(db, router, identity, {
  spaceName:        'My Blog',        // default 'My Blog'
  spaceDescription: 'A blog',
  spaceId:          '@existingUuid',  // optional: use existing space
})

// Access space info
console.log(cms.space)          // '@abc123…'
console.log(cms.postsPrefix)    // '@abc123…/posts/'
console.log(cms.pagesPrefix)    // '@abc123…/pages/'
```

### Posts

```js
// Create (each field stored as its own QuBit)
const slug = await cms.createPost('my-first-post', {
  title:   'My First Post',
  excerpt: 'A short preview',
  content: '<p>Post body HTML</p>',
  status:  'draft',           // default: 'draft'
  tags:    ['quray', 'demo'],
  author:  'Alice',           // default: identity.alias
})

// Update a single field atomically (only this field is written)
await cms.updatePost(slug, 'title', 'Updated Title')
await cms.updatePost(slug, 'status', 'published')
await cms.updatePost(slug, 'content', '<p>New content</p>')

// Load posts (groups atomic QuBits by slug client-side)
const allPosts       = await cms.loadPosts()
const published      = await cms.loadPosts({ status: 'published' })
const tagged         = await cms.loadPosts({ tag: 'quray', limit: 5 })

// Render a post using its template
const html = await cms.renderPost(slug)

// Delete (soft-deletes all field QuBits)
await cms.deletePost(slug)
```

### Pages

```js
// Pages are single QuBits — simpler than posts, no per-field atomicity
await cms.setPage('about', '<div class="post-view"><h1>About</h1><p>…</p></div>')
const html = await cms.getPage('about')
```

### Templates

Templates are HTML strings stored in QuDB at `@{id}/templates/{name}`.
They support `{{variable}}` placeholders and `qu-*` elements.

```js
// Store a custom post template in QuDB (no server file needed!)
await cms.setTemplate('post', `
  <article class="post-view">
    <a onclick="history.back()">← Back</a>
    <h1>{{title}}</h1>
    <div class="meta">{{author}} · {{created}}</div>
    <div class="post-body">{{content}}</div>
  </article>
`)

// Get template (falls back to built-in default if not in QuDB)
const template = await cms.getTemplate('post')

// Render a template with variables
const html = await cms.render('post', {
  title:   'Hello World',
  content: '<p>My content</p>',
  author:  'Alice',
  created: Date.now(),
  tags:    ['quray'],
})
```

**Available placeholders:**
| Placeholder | Description |
|-------------|-------------|
| `{{title}}` | Post/page title |
| `{{content}}` | Main HTML content |
| `{{author}}` | Author name |
| `{{excerpt}}` | Short preview |
| `{{created}}` | Formatted creation date |
| `{{tags}}` | Comma-separated tags |
| `{{name}}` | Space name (for home template) |
| `{{description}}` | Space description |

**Built-in templates:** `post`, `page`, `home`, `list`
(Override by calling `cms.setTemplate(name, html)`)

### Access control

```js
// Check if current user is space owner
const isOwner = await cms.isOwner()

// Protect a route (admin panel, etc.)
if (!await cms.isOwner()) {
  outlet.innerHTML = '<p>Access denied</p>'
  return
}
```

The space ACL is stored at `@{id}/~acl`:
```js
// Owner-only write (default)
{ owner: pub, writers: [pub] }

// Any authenticated peer can write
{ owner: pub, writers: '*' }

// Specific co-authors
{ owner: pub, writers: [pub, alicePub, bobPub] }
```

To allow team members to contribute, update the ACL:
```js
await qr.db.put(`${cms.space}/~acl`, {
  owner:   qr.me.pub,
  writers: [qr.me.pub, alicePub, bobPub],
})
```

### Reactive updates

```js
// Subscribe to any post change (group re-renders, etc.)
const off = cms.onPostsChange(async () => {
  const posts = await cms.loadPosts({ status: 'published' })
  renderList(posts)
})

// Subscribe to a specific field
const offTitle = qr.db.on(`${cms.postsPrefix}my-post/title`, (q) => {
  document.title = q?.data ?? 'Blog'
})

// Clean up when done
off()
offTitle()
```

### Routes

```js
// Register standard /home and /blog routes
await cms.registerRoutes()

// Register the admin panel route (no title = hidden from nav)
await cms.registerAdminRoute('/admin')

// Custom route
await router.addRoute({
  path:       '/pricing',
  title:      'Pricing',
  contentKey: `${cms.pagesPrefix}pricing`,
  order:      3,
})
```

---

## QuRouter API

```js
const router = await QuRouter.create(db, {
  prefix:  'conf/router/',  // QuDB prefix for route storage
  outlet:  '#app',          // CSS selector for the content outlet
  mountFn: el => qr._.ui.directives.mount(el),  // activates qu-* in new content
})

// Add a route
const routeId = await router.addRoute({
  path:       '/about',
  title:      'About',          // null/missing = hidden from nav
  contentKey: '@space/pages/about',
  order:      2,
})

// Update route fields
await router.updateRoute(routeId, { title: 'About Us', order: 3 })

// Delete
await router.deleteRoute(routeId)

// Navigate programmatically
router.navigate('/about')

// Get all routes
const routes = router.getRoutes()   // sorted by order

// React to navigation
router.onNavigate((path, route) => {
  updateActiveNav(path)
  if (path.startsWith('/blog/')) renderPost(path.slice(6))
})
```

### contentKey and content rendering

The `contentKey` is a QuDB key whose value (a string) is injected as `innerHTML` into the outlet.
After injection, `mountFn(outlet)` is called to activate `qu-*` elements.

```js
// Store page content — can include any HTML including qu-* elements
await qr.db.put('@space/pages/about', `
  <div>
    <h1>About</h1>
    <!-- qu-text reads from QuDB reactively -->
    <p>Site name: <span qu-key="@space/~meta" qu-bind="data.name"></span></p>
  </div>
`)
```

Routes without a `contentKey` are not rendered by the router — you handle them in `onNavigate`.
This is useful for dynamic routes like `/blog/:slug`.

---

## Blog list rendering — why not `qu-for`?

`qu-for prefix="@space/posts/"` returns **one list item per QuBit** — which means one item per
field (`/title`, `/excerpt`, `/content`, `/status`, …), not one item per post.

**Correct approach:** query the posts prefix and group by slug:

```js
// Load posts — internally groups atomic QuBits by slug
const posts = await cms.loadPosts({ status: 'published' })

// Render blog list (plain JS — not qu-for)
function renderList(posts) {
  return posts.map(p => `
    <div class="post-card" onclick="location.hash='#/blog/${p._slug}'">
      <h3>${p.title}</h3>
      <p>${p.excerpt}</p>
    </div>`).join('')
}

// React to changes
const off = cms.onPostsChange(async () => {
  document.getElementById('post-grid').innerHTML = renderList(await cms.loadPosts())
})
```

`qu-for` is great for **flat lists** where each QuBit is one item (todos, tags, chat messages):
```html
<!-- Works: each @space/todos/{id} is ONE QuBit -->
<qu-for prefix="@space/todos/">
  <template>
    <div qu-text="data.text"></div>
  </template>
</qu-for>
```

---

## Admin panel as a route

The admin panel is registered as a regular route at `/admin` with no `title` (hidden from nav).
Access is protected by checking `cms.isOwner()` before rendering:

```js
async function renderRoute(path) {
  if (path === '/admin') {
    if (!await cms.isOwner()) {
      outlet.innerHTML = '<p>Access denied</p>'
      return
    }
    renderAdminPanel(outlet)
    return
  }
  // … other routes
}
```

This means the admin panel is:
- Part of the same SPA, no separate page
- Protected by cryptographic ownership check (not just a password)
- Reactive — changes are reflected instantly via QuDB

---

## Multi-device and sync

By default the CMS space uses `@{id}` which is synced via the relay:

```
Alice's browser → put(@id/posts/slug/title, 'New Title') → Relay → Bob's browser
```

Bob sees the title update immediately via `db.on(postsPrefix + 'slug/title', handler)`.

To run QuBlog across multiple devices:
1. Connect all devices to the same relay
2. Use the same space ID (stored in `conf/cms/settings`)
3. Only the space owner can write posts by default (ACL enforced by QuRay)

To allow guest comments or multi-author blogs:
```js
await qr.db.put(`${cms.space}/~acl`, {
  owner:   qr.me.pub,
  writers: '*',   // any authenticated peer
})
```
