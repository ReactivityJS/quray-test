# QuRay — Developer Patterns & Recipes

Practical, copy-paste patterns for the most common QuRay development tasks.

---

## 1. Initialization

### Full initialization (recommended for browser apps)

```js
import QuRay from './src/quray.js'

const qr = await QuRay.init({
  relay:   'wss://relay.example.com',
  alias:   'Alice',             // stored at ~/alias
  ui:      true,                // register qu-* custom elements
  binding: true,                // activate native qu-key DOM bindings
})

// qr.me.pub       — base64url public signing key
// qr.me.epub      — base64url public encryption key
// qr.me.pub64     — alias for pub
// qr.db           — QuDB instance
// qr.net          — QuNet instance
// qr.sync         — QuSync instance
```

### Minimal initialization (no relay, no UI)

```js
import QuRay from './src/quray.js'

const qr = await QuRay.init({
  ui:      false,
  binding: false,
})
```

### Manual QuDB composition (advanced / tests)

Use this when you need fine-grained control over plugins, backends, or pipelines.

```js
import { QuDB } from './src/core/db.js'
import { IdbBackend }        from './src/backends/idb.js'
import { MemoryBackend }     from './src/backends/memory.js'
import { LocalStorageBackend } from './src/backends/local-storage.js'
import { Identity }          from './src/core/identity.js'
import { SignPlugin }        from './src/plugins/sign.js'
import { VerifyPlugin }      from './src/plugins/verify.js'
import { StoreOutPlugin, StoreInPlugin } from './src/plugins/store.js'
import { DispatchPlugin }    from './src/plugins/dispatch.js'
import { AccessControlPlugin } from './src/plugins/access.js'

const identity = await Identity({ alias: 'Alice' })

const db = QuDB({
  identity,
  backends: {
    '~':      IdbBackend({ name: 'quray-user' }),
    '@':      IdbBackend({ name: 'quray-space' }),
    '>':      IdbBackend({ name: 'quray-inbox' }),
    'sys/':   MemoryBackend(),
    'conf/':  LocalStorageBackend({ prefix: 'qr:' }),
    'blobs/': IdbBackend({ name: 'quray-blobs' }),
  },
})

// Plugins run in pipeline-priority order (highest first)
db.use(SignPlugin(identity))           // OUT: 70 — sign outgoing
db.use(VerifyPlugin(identity))         // IN:  80 — verify signatures
db.use(AccessControlPlugin())          // IN/OUT: 79/76 — ACL checks
db.use(StoreOutPlugin())               // OUT: 60 — persist locally
db.use(StoreInPlugin())                // IN:  60 — persist incoming
db.use(DispatchPlugin())               // IN/OUT: 50/49 — fire listeners

await db.init()
```

---

## 2. Key schema

```
~{pub64}/         User space — your data, synced across your devices
@{uuid}/          Shared space — group data, ACL-governed
>{pub64}/         Inbox — received messages, relay-routed
sys/              Ephemeral — in-memory, never persisted
conf/             Config — device-local, never synced
blobs/            Blobs — content-addressed binary storage
```

### KEY helpers

```js
import { KEY } from './src/core/qubit.js'

KEY.user(pub).alias              // '~{pub}/alias'
KEY.user(pub).avatar             // '~{pub}/avatar'
KEY.user(pub).entry('posts', id) // '~{pub}/posts/{ts16}-{id}'
KEY.user(pub).blob(hash)         // '~{pub}/blob/{hash}'

KEY.space(id).acl                // '@{id}/~acl'
KEY.space(id).meta               // '@{id}/~meta'
KEY.space(id).entry('chat', id)  // '@{id}/chat/{ts16}-{id}'
KEY.space(id).field('settings')  // '@{id}/settings'

KEY.inbox(pub).root              // '>{pub}/'
KEY.peer(pub)                    // 'sys/peers/{pub}'
KEY.ts16()                       // sortable 16-digit timestamp string
KEY.sha256url(buffer)            // async SHA-256 → base64url hash
```

---

## 3. CRUD

```js
// Write
await db.put('~/status', { text: 'Online', ts: Date.now() })

// Read
const q = await db.get('~/status')
// q = { key, data, from, ts, type, sig, _status }
console.log(q?.data?.text)   // 'Online'
console.log(q?.from)         // author public key
console.log(q?.ts)           // write timestamp (ms)

// Delete (tombstone on syncable mounts, hard delete on local mounts)
await db.del('~/status')

// Hard delete (no sync, immediate)
await db.del('~/status', { hard: true })

// Query by prefix (returns array sorted by key)
const notes = await db.query('~/notes/', { order: 'ts' })

// Read deleted tombstones
const deleted = await db.get('~/status', { includeDeleted: true })
```

---

## 4. Reactive listeners

```js
// Listen to a single key (immediate: fires once with current value on subscribe)
const off = db.on('~/alias', (qubit, meta) => {
  console.log(qubit?.data)    // current value
  console.log(meta.event)     // 'put' | 'del'
  console.log(meta.previous)  // previous data value
  console.log(meta.scope)     // 'data'
}, { immediate: true })

// Listen to a prefix (glob)
const offPrefix = db.on('@room/chat/**', (qubit, meta) => {
  console.log(meta.event, qubit?.key)
})

// Once — fires once and unsubscribes automatically
db.on('~/status', handler, { once: true })

// Unsubscribe
off()
offPrefix()
```

---

## 5. User profile pattern

The `~/` shorthand expands to the current user's public key.

```js
// Write to your own profile
await db.put('~/alias',  'Alice')
await db.put('~/avatar', 'https://example.com/avatar.jpg')
await db.put('~/bio',    { text: 'P2P enthusiast' })

// Reactive display — using native bindings
```

```html
<span qu-key="~/alias"></span>
<img qu-key="~/avatar" qu-bind="attr:src">
<p><span qu-key="~/bio"></span></p>
```

```js
// Read another user's alias
const otherPub = '...'
const aliasQubit = await db.get(KEY.user(otherPub).alias)
console.log(aliasQubit?.data)   // 'Bob'

// Watch another user's online state
db.on(KEY.peer(otherPub), (peerQubit) => {
  const online = peerQubit?.data?.online ?? false
})
```

---

## 6. Shared spaces and ACL

### Create a space with access control

```js
const spaceId = crypto.randomUUID()

// Only the owner can create the initial ACL
await db.put(KEY.space(spaceId).acl, {
  owner:   myPub,
  writers: [myPub, alicePub, bobPub],  // or '*' for open
})

// Set space metadata
await db.put(KEY.space(spaceId).meta, {
  name:    'Project Alpha',
  created: Date.now(),
})

// Write to the space
await db.put(KEY.space(spaceId).entry('tasks', taskId), {
  title: 'Design the API',
  done:  false,
})
```

### ACL values

| `writers` value | Meaning |
|---|---|
| `[pub1, pub2]` | Only listed actors may write |
| `'*'` | Any authenticated actor may write |
| _(absent)_ | Only the owner may write |

### Listen to a space

```js
db.on(`@${spaceId}/tasks/**`, (qubit, meta) => {
  if (meta.event === 'put') renderTask(qubit)
  if (meta.event === 'del') removeTask(qubit.key)
})
```

---

## 7. Inbox / direct messages

```js
// Send a message to another user
const recipientPub = 'recipient-pub64-key'
const inboxEntry = KEY.inbox(recipientPub).root + KEY.ts16()

await db.put(inboxEntry, {
  type:   'dm',
  text:   'Hello, this is a direct message',
  from:   myPub,
  ts:     Date.now(),
})

// Receive messages — listen to your own inbox
db.on(`>${myPub}/**`, (qubit, meta) => {
  if (meta.event === 'put' && qubit?.data?.type === 'dm') {
    showMessage(qubit)
  }
})
```

---

## 8. Blob upload with progress

```js
// Content-addressed: hash first, then store
const file   = inputEl.files[0]
const buffer = await file.arrayBuffer()
const hash   = await KEY.sha256url(buffer)

// Store locally and queue upload to relay
await db.blobs.put(hash, buffer, {
  mime: file.type,
  name: file.name,
  size: buffer.byteLength,
})

// Get an Object URL for immediate display
const status = db.blobs.status(hash)
imgEl.src = status.url   // blob: URL

// Write blob metadata as a QuBit so peers can subscribe and download
const metaKey = KEY.user(myPub).blob(hash)
await db.put(metaKey, { hash, mime: file.type, name: file.name })

// React to blob status changes
db.on(hash, (entry, meta) => {
  console.log(entry.status)  // 'pending' | 'ready' | 'error'
  if (entry.status === 'ready') imgEl.src = entry.url
}, { scope: 'blob' })

// Stage for later upload (e.g. offline compose)
await db.blobs.stage(hash, buffer, { mime: file.type, name: file.name })
await db.blobs.upload(hash)   // enqueue upload when ready to send
```

---

## 9. Delivery state tracking

Delivery state is local-only and tracks the 6-stage message funnel.

```
local → queued → relay_in → peer_sent → peer_recv → peer_read
```

```js
const msgKey = KEY.space(roomId).entry('chat', msgId)

// React to delivery state changes
const off = db.on(msgKey, (entry, meta) => {
  console.log(entry.state)  // 'local' | 'queued' | ... | 'peer_read'
  updateCheckmarks(entry.state)
}, { scope: 'delivery' })

// Read current delivery state
const delivery = await db.delivery.get(msgKey)
console.log(delivery?.state)  // 'peer_recv'

// Check minimum state (e.g. "has it reached the relay?")
const reached = await db.delivery.isAtLeast(msgKey, 'relay_in')

// Mark as read (client-side explicit confirmation)
await db.delivery.set(msgKey, 'peer_read')
```

```html
<!-- Visual delivery indicator -->
<qu-delivery key="@room/chat/001"></qu-delivery>
<qu-tick state="peer_read"></qu-tick>
```

---

## 10. E2E encryption

```js
// Send an encrypted message to a recipient
const recipientEpub = '...'   // recipient's public encryption key

await db.put(inboxKey, { text: 'Secret message' }, {
  encrypt: { epub: recipientEpub },
})

// Decryption is automatic when reading — QuRay decrypts on the IN pipeline
const q = await db.get(inboxKey)
console.log(q?.data?.text)   // 'Secret message' (already decrypted)
```

---

## 11. App configuration (local-only)

`conf/` keys live only on the current device — they are never synced.

```js
// Persist UI state
await db.put('conf/app/theme',  'dark')
await db.put('conf/app/unread', 0)
await db.put('conf/app/title',  'My App')

// Reactive config binding
db.on('conf/app/theme', (q) => {
  document.documentElement.dataset.theme = q?.data ?? 'light'
})
```

```html
<!-- Two-way input that persists live -->
<input qu-key="conf/app/title" qu-bind="value" qu-mode="two-way" qu-live>

<!-- Reactive page title — updates browser tab -->
<title qu-key="conf/app/title" qu-placeholder="My App">My App</title>
```

---

## 12. Query patterns

```js
// Query all items in a prefix
const items = await db.query('@room/tasks/')

// Query with options
const recent = await db.query('@room/msgs/', {
  order:  'ts',      // sort by ts field
  limit:  50,
  offset: 0,
})

// Reactive query — use db.on() with glob
db.on('@room/tasks/**', (qubit, meta) => {
  if (meta.event === 'put')  taskMap.set(qubit.key, qubit)
  if (meta.event === 'del')  taskMap.delete(qubit.key)
  renderList()
})
// Seed initial state
const initial = await db.query('@room/tasks/')
for (const q of initial) taskMap.set(q.key, q)
renderList()
```

---

## 13. Plugin pipeline priorities

Plugins run in priority order. Higher priority = runs first.

| Constant | Value | Stage |
|---|---|---|
| `PIPELINE_PRIORITY.VERIFY`       | 80 | IN: verify incoming signatures |
| `PIPELINE_PRIORITY.ACCESS_IN`    | 79 | IN: access control check |
| `PIPELINE_PRIORITY.STORE_IN`     | 60 | IN: persist incoming QuBit |
| `PIPELINE_PRIORITY.DISPATCH_IN`  | 50 | IN: fire db.on() listeners |
| `PIPELINE_PRIORITY.ACCESS_OUT`   | 76 | OUT: access control check |
| `PIPELINE_PRIORITY.E2E`          | 75 | OUT: E2E encrypt |
| `PIPELINE_PRIORITY.SIGN`         | 70 | OUT: sign QuBit |
| `PIPELINE_PRIORITY.STORE_OUT`    | 60 | OUT: persist locally |
| `PIPELINE_PRIORITY.DISPATCH_OUT` | 49 | OUT: fire db.on() listeners |
| `PIPELINE_PRIORITY.SYNC_OUT`     |  5 | OUT: enqueue for relay sync |

### Writing a custom plugin

```js
import { PIPELINE_PRIORITY } from './src/core/events.js'

const LogPlugin = (label = 'QuRay') => (db) => {
  const offIn = db.useIn(async ({ args: [ctx], next }) => {
    console.log(`[${label}] IN:`, ctx.qubit?.key)
    await next()
  }, PIPELINE_PRIORITY.DISPATCH_IN - 1)   // run after dispatch

  const offOut = db.useOut(async ({ args: [ctx], next }) => {
    console.log(`[${label}] OUT:`, ctx.qubit?.key)
    await next()
  }, PIPELINE_PRIORITY.DISPATCH_OUT - 1)

  return () => { offIn(); offOut() }   // cleanup function
}

db.use(LogPlugin('MyApp'))
```

---

## 14. Testing patterns

### In-memory database for unit tests

```js
import { QuDB }         from './src/core/db.js'
import { MemoryBackend } from './src/backends/memory.js'
import { StoreOutPlugin, StoreInPlugin } from './src/plugins/store.js'
import { DispatchPlugin } from './src/plugins/dispatch.js'

async function createTestDatabase(identity = null) {
  const db = QuDB({
    identity,
    backends: {
      '~': MemoryBackend(), '@': MemoryBackend(),
      '>': MemoryBackend(), 'sys/': MemoryBackend(),
      'conf/': MemoryBackend(), 'blobs/': MemoryBackend(),
    },
  })
  db.use(StoreOutPlugin())
  db.use(StoreInPlugin())
  db.use(DispatchPlugin())
  if (identity) {
    const { SignPlugin }   = await import('./src/plugins/sign.js')
    const { VerifyPlugin } = await import('./src/plugins/verify.js')
    db.use(SignPlugin(identity))
    db.use(VerifyPlugin(identity))
  }
  await db.init()
  return db
}
```

### waitFor helper for async assertions

```js
function waitFor(expectFn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = async () => {
      try { await expectFn(); resolve() }
      catch (err) {
        if (Date.now() >= deadline) reject(err)
        else setTimeout(tick, 30)
      }
    }
    tick()
  })
}

// Usage
const events = []
db.on('~/status', (q) => events.push(q?.data))
await db.put('~/status', 'online')
await waitFor(() => {
  if (events.length === 0) throw new Error('no event yet')
})
```

---

## 15. Common anti-patterns

### ❌ Don't build keys with string concatenation

```js
// Wrong — fragile and bypasses key schema
const key = '~' + pub + '/alias'

// Correct — use KEY helpers
const key = KEY.user(pub).alias
```

### ❌ Don't store binary data in `data`

```js
// Wrong — QuBit data must be JSON-serializable
await db.put(key, { file: new Uint8Array(buffer) })

// Correct — use blobs for binary content
const hash = await KEY.sha256url(buffer)
await db.blobs.put(hash, buffer, { mime: 'image/png' })
await db.put(KEY.user(myPub).blob(hash), { hash, mime: 'image/png' })
```

### ❌ Don't use `conf/` keys for delivery tracking

`conf/` is `local: true` (device-only). The delivery tracker automatically excludes local-only mount keys. Writing delivery metadata to `conf/` has no effect on the sync pipeline.

### ❌ Don't forget to unsubscribe listeners

```js
// Wrong — listener leaks if the component is destroyed
db.on('~/alias', updateUI)

// Correct — save and call the off function
const off = db.on('~/alias', updateUI)
// ... later
off()
```

### ❌ Don't prefix check keys manually for mount decisions

```js
// Wrong — brittle, misses new mounts
if (!key.startsWith('conf/') && !key.startsWith('sys/')) { ... }

// Correct — use the mount helper
import { isLocalOnly } from './src/core/mounts.js'
if (!isLocalOnly(key)) { ... }
```
