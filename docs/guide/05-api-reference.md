# 05 — API Reference

Complete reference for all public JavaScript APIs in QuRay.

---

## QuRay.init()

Entry point for the framework. Returns a fully initialized `QuRay` instance.

```js
import QuRay from './src/quray.js'

const qr = await QuRay.init(options)
```

### Options

```ts
interface QuRayInitOptions {
  // ── Connection ────────────────────────────────────────────────────
  relay?:  string           // Single WebSocket relay URL
  relays?: string[]         // Multiple relay URLs (round-robin or failover)

  // ── Identity ──────────────────────────────────────────────────────
  alias?:      string       // Display name (stored at ~/alias)
  passphrase?: string       // Passphrase to decrypt identity backup
  identity?:   BackupData   // Restore from a previous session backup

  // ── Behavior ──────────────────────────────────────────────────────
  blobAutoLoadLimit?: number  // Auto-download blobs below N bytes (default: 512 KB)
  syncOnConnect?:    boolean  // Diff-sync on relay connect (default: true)
  conflictStrategy?: 'lww'    // Conflict strategy: last-write-wins (only supported value)

  // ── Transport options ─────────────────────────────────────────────
  ws?:   { pingInterval?: number }
  http?: { timeout?: number }

  // ── UI ────────────────────────────────────────────────────────────
  ui?:         boolean  // Register <qu-*> custom elements (default: false)
  binding?:    boolean  // Activate native qu-key DOM bindings (default: false)
  directives?: boolean  // Enable <qu-scope>, <qu-for> directives (default: false)

  // ── Plugins ───────────────────────────────────────────────────────
  presence?: boolean        // Enable QuPresence plugin (default: true)
  plugins?:  Plugin[]       // Additional custom plugins
  middleware?: {
    sign?:   boolean        // Disable SignPlugin (default: true)
    verify?: boolean        // Disable VerifyPlugin (default: true)
  }

  // ── Advanced ──────────────────────────────────────────────────────
  backends?: Record<string, Backend>  // Override a mount's storage backend
}
```

### Return value: `QuRay` instance

```js
qr.me           // LocalPeer — current user
qr.peers        // PeerMap — all known remote peers
qr.db           // QuDB — local database
qr.net          // QuNet — network transport layer (internal)
qr._.sync       // QuSync — sync engine (internal)
qr._.presence   // QuPresence — peer awareness (internal)
qr._.net        // QuNet (same as qr.net)

qr.space(id)    // Space API helper
```

---

## QuDB — `qr.db`

The local database. All reads and writes go through here.

### `db.put(key, data, options?)`

Write a value. Signed, stored locally, queued for sync.

```ts
await db.put(
  key:  string,
  data: any,           // JSON-serializable
  opts?: {
    type?:  string,    // QuBit type: 'data' | 'msg' | 'blob.meta' | custom
    sync?:  boolean,   // Queue for relay sync (default: true)
    enc?:   string,    // Recipient epub (triggers E2E encryption)
    order?: number,    // Fractional index for ordered lists
  }
): Promise<QuBit>
```

**Examples:**

```js
// Simple write
await db.put('~/status', 'online')

// Write with options
await db.put(`@${spaceId}/chat/${KEY.ts16()}`, { text: 'Hi' }, {
  type: 'msg',
  sync: true,
})

// Encrypted write (E2E)
await db.put(`>${bobPub}/${KEY.ts16()}`, { text: 'Secret' }, {
  enc: bobEpub,   // Bob's ECDH public key
})

// Local-only (no sync)
await db.put('conf/app/theme', 'dark', { sync: false })
```

---

### `db.get(key, options?)`

Read a single QuBit by exact key.

```ts
await db.get(
  key:  string,
  opts?: {
    includeDeleted?: boolean,  // Return tombstones (default: false)
    decrypt?:        boolean,  // Auto-decrypt encrypted QuBits (default: true)
  }
): Promise<QuBit | null>
```

**Examples:**

```js
const q = await db.get('~/alias')
console.log(q?.data)     // 'Alice'
console.log(q?.from)     // pub64 of writer
console.log(q?.ts)       // Unix ms
console.log(q?._mine)    // true if written by current identity

// Include tombstones
const deleted = await db.get('~/note', { includeDeleted: true })
console.log(deleted?.data)    // null (tombstone)

// Read without decryption (get raw envelope)
const raw = await db.get(encryptedKey, { decrypt: false })
console.log(raw?.enc)   // { ct, iv, by, epub, keys }
```

---

### `db.del(key, options?)`

Delete a value. Creates a signed tombstone that syncs to peers.

```ts
await db.del(
  key:  string,
  opts?: {
    hard?: boolean,  // Hard-delete (no tombstone, local only) (default: false)
  }
): Promise<void>
```

**Examples:**

```js
// Soft delete (syncs to peers — they will also delete)
await db.del('~/draft')

// Hard delete (local only, no sync)
await db.del('conf/cache/key', { hard: true })
```

---

### `db.query(prefix, options?)`

Query all QuBits under a key prefix.

```ts
await db.query(
  prefix: string,
  opts?: {
    order?:  'ts' | 'ts-desc' | 'key' | 'key-desc' | string, // sort field
    limit?:  number,
    offset?: number,
    since?:  number,                       // ts > since (ms)
    filter?: (qubit: QuBit) => boolean,    // client-side filter
  }
): Promise<QuBit[]>
```

**Examples:**

```js
// All items, default sort (by key)
const items = await db.query(`@${spaceId}/todos/`)

// Most recent first
const recent = await db.query(`@${spaceId}/chat/`, {
  order: 'ts-desc',
  limit: 50,
})

// Since a timestamp
const newMsgs = await db.query(`@${spaceId}/chat/`, {
  since: lastSyncTs,
  order: 'ts',
})

// With client filter
const myPosts = await db.query(`@${spaceId}/posts/`, {
  filter: q => q.from === qr.me.pub,
})

// Paginated
const page2 = await db.query(`@${spaceId}/items/`, {
  order: 'ts',
  limit: 20,
  offset: 20,
})
```

---

### `db.on(pattern, callback, options?)`

Subscribe to database events. Fires on both local writes and incoming sync.

```ts
const off = db.on(
  pattern:  string,         // exact key, glob, or '**'
  callback: (qubit: QuBit | null, meta: EventMeta) => void,
  opts?: {
    scope?:     'data' | 'blob' | 'delivery',  // default: 'data'
    once?:      boolean,    // unsubscribe after first fire
    immediate?: boolean,    // fire once immediately with current value
  }
): () => void               // cleanup function — call to unsubscribe
```

**Pattern syntax:**

| Pattern | Matches |
|---------|---------|
| `~/alias` | Exact key only |
| `~/**` | All keys under `~/` (recursive) |
| `@room/chat/*` | One level wildcard |
| `**` | All keys |

**`EventMeta` shape:**

```ts
interface EventMeta {
  event:    'put' | 'del'
  key:      string
  source:   'local' | 'sync'   // where the event came from
  previous: any                 // previous data value (or null)
  scope:    'data' | 'blob' | 'delivery'
}
```

**Examples:**

```js
// Watch a single key
const off = db.on('~/alias', (q, meta) => {
  console.log('Name changed to:', q?.data)
  console.log('Previous was:', meta.previous)
})

// Watch a space
const off = db.on(`@${spaceId}/chat/**`, (q, { event }) => {
  if (event === 'put') addMessage(q)
  if (event === 'del') removeMessage(q.key)
})

// One-shot listener (unsubscribes after first event)
db.on('~/ready', handler, { once: true })

// Fire immediately with current value
db.on('~/alias', updateNameDisplay, { immediate: true })

// Cleanup
const off = db.on('~/note', updateNote)
// ... later when component unmounts:
off()
```

---

### `db.signal(key)`

Thin reactive wrapper for a single key.

```ts
const signal = db.signal(key: string)

await signal.set(value: any)       // db.put() shorthand
signal.on(callback: (value) => void): () => void
const value = await signal.get()   // db.get() shorthand
```

**Example:**

```js
const themeSignal = db.signal('conf/app/theme')

await themeSignal.set('dark')

const off = themeSignal.on((theme) => {
  document.body.dataset.theme = theme ?? 'light'
})
```

---

### Blob API — `db.blobs`

Content-addressed binary storage.

```js
// Write a blob
const file   = input.files[0]
const buffer = await file.arrayBuffer()
const hash   = await KEY.sha256url(buffer)

await db.blobs.put(hash, buffer, {
  mime: file.type,
  name: file.name,
  size: buffer.byteLength,
})

// Read blob status (local)
const status = db.blobs.status(hash)
// → { status: 'ready' | 'pending' | 'awaiting-user' | 'error', url: string, meta: object }

if (status?.status === 'ready') imgEl.src = status.url

// React to blob status changes
const off = db.blobs.on(hash, ({ status, url, meta }) => {
  if (status === 'ready') imgEl.src = url
  if (status === 'error') showError('Download failed')
})

// Trigger download of a remote blob (for AWAITING_USER blobs)
db.blobs.load(hash)

// Stage + upload flow
await db.blobs.stage(hash, buffer, { mime: file.type })
await db.blobs.upload(hash)   // enqueue for relay upload
```

**Blob status values:**

| Status | Meaning |
|--------|---------|
| `ready` | Available locally, accessible via Object URL |
| `pending` | Download in progress |
| `awaiting-user` | Blob is larger than `blobAutoLoadLimit`, waiting for user to trigger |
| `error` | Download or storage failed |

---

### Delivery Tracking — `db.delivery`

Track the 6-stage delivery funnel for sent messages.

```
local → queued → relay_in → peer_sent → peer_recv → peer_read
```

```js
const msgKey = `@${roomId}/chat/${KEY.ts16()}`

// React to state changes
const off = db.on(msgKey, (entry, meta) => {
  if (meta.scope !== 'delivery') return
  switch (entry.state) {
    case 'local':     showClock(); break
    case 'queued':    showClock(); break
    case 'relay_in':  showSingleTick(); break
    case 'peer_recv': showDoubleTick(); break
    case 'peer_read': showBlueTick(); break
  }
}, { scope: 'delivery' })

// Read current state
const delivery = await db.delivery.get(msgKey)
console.log(delivery?.state)   // 'peer_recv'

// Check threshold
const delivered = await db.delivery.isAtLeast(msgKey, 'relay_in')

// Manually mark as read (client confirms read)
await db.delivery.set(msgKey, 'peer_read')
```

---

## QuSync — `qr._.sync`

The remote synchronization engine. Manages subscriptions and relay communication.

### `sync.subscribe(prefix, options?)`

Subscribe to a prefix on the relay (live updates).

```ts
const off = await sync.subscribe(
  prefix: string,
  opts?: {
    live?:     boolean,  // keep listening after initial snapshot (default: false)
    snapshot?: boolean,  // pull current data first (default: false)
    peerId?:   string,
    timeout?:  number,
  }
): Promise<() => void>  // cleanup
```

```js
// Subscribe with snapshot
const off = await sync.subscribe(`@${roomId}/chat/`, {
  live: true,
  snapshot: true,
})
// db.on() listeners will fire for all received QuBits
```

### `sync.observe(pattern, callback, options?)`

Combined local listener + remote subscription. Preferred over manual `db.on()` + `subscribe()`.

```ts
const off = await sync.observe(
  pattern:  string,
  callback: (qubit, meta) => void,
  opts?: {
    live?:     boolean,
    snapshot?: boolean,
  }
): Promise<() => void>
```

```js
const off = await sync.observe(`@${spaceId}/chat/**`, (q, { event }) => {
  if (event === 'put') renderMessage(q)
  if (event === 'del') removeMessage(q.key)
}, { live: true, snapshot: true })
```

### `sync.pull(prefix, callback?, options?)`

Pull a snapshot AND set up a local listener. Returns current rows immediately.

```ts
const { off, rows } = await sync.pull(
  prefix:    string,
  callback?: (qubit, meta) => void,
  opts?:     { peerId?: string, timeout?: number }
): Promise<{ off: () => void, rows: QuBit[] }>
```

```js
// Ideal for initial render + live updates
const { off, rows } = await sync.pull(`@${boardId}/tasks/`, (q, { event }) => {
  if (event === 'put') taskMap.set(q.key, q.data)
  if (event === 'del') taskMap.delete(q.key)
  renderBoard()
})

// Render initial state
rows.forEach(q => taskMap.set(q.key, q.data))
renderBoard()
```

### Manual sync

```js
await sync.syncIn(prefix?)   // pull from relay (prefix optional)
await sync.syncOut()         // push all pending local writes
await sync.fullSync()        // both directions
```

### Custom type handler

```js
const off = sync.registerHandler('my.invite', async (qubit, src) => {
  console.log('Received invitation from', src, qubit.data)
  await handleInvitation(qubit)
})
```

---

## Space API — `qr.space(id)`

Higher-level API for working with a specific space.

```js
const space = qr.space('@' + spaceId)

// Read
const q       = await space.get('settings')
const entries = await space.query('chat/', { order: 'ts-desc', limit: 50 })

// Write
await space.put('chat/' + KEY.ts16(), { text: 'Hi' })
await space.del('chat/old-key')

// ACL
const aclQ    = await space.acl()        // → QuBit with ACL data
const canRead  = await space.can(pub, 'read')
const canWrite = await space.can(pub, 'write')

// Members
await space.members.add(peer)            // RemotePeer instance
await space.members.remove(pub)
const list = await space.members.list()  // → QuBit[]

// Reactive
const off = space.on('chat/**', (q, meta) => { ... })
```

---

## LocalPeer — `qr.me`

```js
// Properties
qr.me.pub     // ECDSA public key (base64url)
qr.me.epub    // ECDH public key (base64url)
qr.me.alias   // Display name (string | null)
qr.me.avatar  // Avatar data (string | null)

// Profile
await qr.me.setAlias('Bob')
const off = qr.me.watch(() => updateUI(qr.me.alias))

// Cryptography
const sig       = await qr.me.sign(dataString)
const valid     = await qr.me.verify(dataString, sig, otherPub)
const envelope  = await qr.me.encrypt(plaintext, [{ pub, epub }])
const plaintext = await qr.me.decrypt(envelope)

// Backup
const backup = await qr.me.backup()            // unencrypted
const backup = await qr.me.backup('passphrase') // PBKDF2-encrypted
```

---

## PeerMap — `qr.peers`

```js
// Access
const alice = qr.peers.get(alicePub)    // RemotePeer | undefined
const all   = qr.peers.all              // RemotePeer[]
const live  = qr.peers.online           // online RemotePeer[]

// React to any peer change
const off = qr.peers.onChange((map) => {
  for (const peer of map.all) updatePeerRow(peer)
})
```

### RemotePeer

```js
peer.pub     // public key
peer.epub    // encryption key (null if not yet synced)
peer.alias   // display name (null if not yet synced)
peer.online  // boolean

const off = peer.on((updatedPeer) => updatePeerCard(updatedPeer))
```

---

## KEY Helpers

```js
import { KEY } from './src/core/qubit.js'

// User space keys
KEY.user(pub).base               // '~{pub64}'
KEY.user(pub).alias              // '~{pub64}/alias'
KEY.user(pub).avatar             // '~{pub64}/avatar'
KEY.user(pub).blob(hash)         // '~{pub64}/blob/{hash}'
KEY.user(pub).app('myapp')       // '~{pub64}/myapp'
KEY.user(pub).field('bio')       // '~{pub64}/bio'
KEY.user(pub).entry('posts', id) // '~{pub64}/posts/{ts16}-{id}'

// Space keys
KEY.space(uuid).base             // '@{uuid}'
KEY.space(uuid).acl              // '@{uuid}/~acl'
KEY.space(uuid).meta             // '@{uuid}/~meta'
KEY.space(uuid).field('settings')// '@{uuid}/settings'
KEY.space(uuid).entry('chat', id)// '@{uuid}/chat/{ts16}-{id}'

// Inbox
KEY.inbox(pub)                   // '>{pub64}/'

// System
KEY.peer(pub)                    // 'sys/peers/{pub64}'

// Utilities
KEY.ts16()                       // '000195a4bc12ef01' — sortable timestamp
KEY.id()                         // crypto.randomUUID()
await KEY.sha256url(buffer)      // SHA-256 → base64url hash string
```

---

## QuPresence — `qr._.presence`

```js
const presence = qr._.presence

// Peer events
presence.on('peerOnline',  ({ pub, alias, epub }) => markOnline(pub))
presence.on('peerOffline', ({ pub }) => markOffline(pub))

// Send typing indicator to a space
await presence.sendTyping(qr._.net, spaceId)

// Listen for typing in a space
qr.db.on(`conf/typing/@${spaceId}/**`, (q, { event }) => {
  if (event === 'put') showTyping(q.data.from)
  if (event === 'del') hideTyping(q.data?.from)
})
```

---

## E2E Encryption

```js
// Write an encrypted message
const recipientEpub = '...'    // get from qr.peers.get(pub).epub
await db.put(msgKey, { text: 'Secret message' }, { enc: recipientEpub })

// Read is automatic — QuRay decrypts on the IN pipeline
const q = await db.get(msgKey)
console.log(q?.data.text)   // 'Secret message' (decrypted transparently)

// Multi-recipient encryption
const envelope = await qr.me.encrypt(plaintext, [
  { pub: alicePub, epub: aliceEpub },
  { pub: bobPub,   epub: bobEpub   },
])
await db.put(msgKey, null, { enc: envelope })
```

---

## Relay Server

Run the relay from Node.js:

```bash
node relay.js

# With options
PORT=443 DATA_DIR=./data node relay.js
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `STATIC_DIR` | `./` | Static file directory |
| `DATA_DIR` | `./quray-data` | QuBit persistence directory |
| `API_KEY` | — | Require `X-Api-Key` header |
| `MAX_BLOB_MB` | `100` | Max blob upload size |
| `HTTPS_CERT` | — | TLS certificate path |
| `HTTPS_KEY` | — | TLS key path |
| `FEATURE_PUSH` | `false` | Enable Web Push notifications |
| `FEATURE_SYNC` | `true` | Enable QuBit persistence |
| `FEATURE_ROUTER` | `true` | Enable WebSocket peer routing |

---

## Manual QuDB Composition

For tests or advanced use cases, compose `QuDB` manually:

```js
import { QuDB } from './src/core/db.js'
import { IdbBackend } from './src/backends/idb.js'
import { MemoryBackend } from './src/backends/memory.js'
import { LocalStorageBackend } from './src/backends/local-storage.js'
import { Identity } from './src/core/identity.js'
import { SignPlugin } from './src/plugins/sign.js'
import { VerifyPlugin } from './src/plugins/verify.js'
import { StoreOutPlugin, StoreInPlugin } from './src/plugins/store.js'
import { DispatchPlugin } from './src/plugins/dispatch.js'
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

db.use(SignPlugin(identity))
db.use(VerifyPlugin(identity))
db.use(AccessControlPlugin())
db.use(StoreOutPlugin())
db.use(StoreInPlugin())
db.use(DispatchPlugin())

await db.init()
```

---

## Next: UI Components →

Continue to [06 — UI Components](./06-ui.md) for reactive DOM bindings and custom elements.
