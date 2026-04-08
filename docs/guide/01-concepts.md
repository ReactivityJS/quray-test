# 01 — Core Concepts

## What is QuRay?

QuRay is an **offline-first, reactive P2P database** for browsers and Node.js.

- **No backend required to start** — data lives in the browser (IndexedDB)
- **Reactive** — write once via `db.put()`, listen via `db.on()` — same API for local and remote changes
- **Cryptographic** — every value is ECDSA-signed; optional E2E encryption
- **Modular** — thin core, extensible via plugins and custom backends

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        Your Application                            │
├────────────────────────────────────────────────────────────────────┤
│               UI Layer  ·  qu-* attributes  ·  <qu-list> etc.      │
├────────────────────────────────────────────────────────────────────┤
│                       QuRay Facade  (quray.js)                     │
├──────────────────┬──────────────────────┬──────────────────────────┤
│      QuDB        │       QuSync         │      QuPresence          │
│  (local store)   │   (replication)      │   (peer awareness)       │
├──────────────────┴──────────────────────┴──────────────────────────┤
│         Backends                     Transports                    │
│  IndexedDB · Memory · LocalStorage   WS · HTTP · WebRTC · Local   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Key Schema — Where Data Lives

Every key in QuRay has a **prefix** that determines:

- Which storage backend is used
- Whether data syncs to remote peers
- Who is allowed to write

```
~{pub64}/       User space   — owned by a specific user, synced across devices
@{uuid}/        Space        — shared group data, ACL-governed
>{pub64}/       Inbox        — relay-routed messages for a specific peer
sys/            System       — in-memory only, never persisted, never synced
conf/           Config       — device-local only, persists across reloads
blobs/          Blobs        — content-addressed binary storage
```

### Mount Table

| Prefix | Syncs | Persists | Storage | Hard-delete |
|--------|-------|----------|---------|-------------|
| `~` (user) | ✓ | ✓ | IndexedDB | ✗ (tombstone) |
| `@` (space) | ✓ | ✓ | IndexedDB | ✗ (tombstone) |
| `>` (inbox) | ✓ | ✓ | IndexedDB | ✗ (tombstone) |
| `sys/` | ✗ | ✗ | Memory | ✓ |
| `conf/` | ✗ | ✓ | LocalStorage | ✓ |
| `blobs/` | ✗ | ✓ | IndexedDB | ✓ |

> **`~/`** is a shorthand for the current user's own user space: `~{myPub}/`.

---

## The QuBit — Universal Data Format

Every value stored in QuRay is a **QuBit**. QuBits are atomic, signed, JSON-serializable records.

```ts
interface QuBit {
  key:    string        // Storage key, e.g. "~pub64/alias"
  data:   any           // JSON-serializable payload
  from:   string        // pub64 — who wrote this QuBit
  ts:     number        // Unix milliseconds — when it was written
  type:   string        // 'data' | 'msg' | 'blob.meta' | custom
  id:     string        // UUID — globally unique per QuBit
  sig:    string | null // ECDSA signature (base64url) — null if unsigned
  enc?:   object        // Encryption envelope (only if encrypted)
  refs?:  string[]      // Optional references to other keys
  order?: number        // Fractional sort index for orderable lists

  // Internal (not transported over the wire):
  _status:  'pending' | 'synced' | 'local' | null
  _mine:    boolean     // true if written by the current identity
  _localTs: number      // device-local write time
}
```

### Reading a QuBit

```js
const q = await qr.db.get('~/alias')

q.key     // '~abc123.../alias'
q.data    // 'Alice'             ← your payload
q.from    // 'abc123...'         ← who wrote it
q.ts      // 1712345678000       ← when
q.sig     // 'MEQ...'            ← ECDSA signature
q._mine   // true                ← written by current identity
```

### Deleted QuBits (Tombstones)

Deleting a synced key creates a **tombstone** — a special QuBit with no data that propagates the deletion to all peers:

```js
await qr.db.del('~/note')

// The tombstone can be read back:
const tomb = await qr.db.get('~/note', { includeDeleted: true })
tomb.data     // null
tomb.sig      // still signed — deletion is authenticated
```

---

## The Plugin Pipeline

Every write in QuRay flows through an ordered middleware pipeline. Plugins are ordered by priority (higher = runs first):

### OUT Pipeline (on `db.put()` / `db.del()`)

```
Priority 76  ACCESS_OUT   — check if the current user may write this key
Priority 75  E2E          — optionally encrypt the payload
Priority 70  SIGN         — ECDSA-sign the QuBit
Priority 60  STORE_OUT    — persist to local backend
Priority 49  DISPATCH_OUT — fire db.on() listeners
Priority  5  SYNC_OUT     — enqueue for relay sync
```

### IN Pipeline (on incoming sync from relay)

```
Priority 80  VERIFY       — verify the incoming ECDSA signature
Priority 79  ACCESS_IN    — re-check ACL rules for the incoming write
Priority 60  STORE_IN     — persist to local backend
Priority 50  DISPATCH_IN  — fire db.on() listeners
```

> Both pipelines fire `db.on()` — your UI code reacts identically to local writes and remote sync.

### Custom Plugin Example (simple logger)

```js
import { PIPELINE_PRIORITY } from './src/core/events.js'

const LogPlugin = (label = 'QuRay') => (db) => {
  db.useOut(async ({ args: [ctx], next }) => {
    console.log(`[${label}] OUT:`, ctx.qubit?.key)
    await next()
  }, PIPELINE_PRIORITY.DISPATCH_OUT - 1)

  db.useIn(async ({ args: [ctx], next }) => {
    console.log(`[${label}] IN:`, ctx.qubit?.key)
    await next()
  }, PIPELINE_PRIORITY.DISPATCH_IN - 1)
}

db.use(LogPlugin('MyApp'))
```

---

## KEY Helpers

Never build keys by hand — use the `KEY` helpers:

```js
import { KEY } from './src/core/qubit.js'

// User keys
KEY.user(pub).base          // '~{pub64}'
KEY.user(pub).alias         // '~{pub64}/alias'
KEY.user(pub).avatar        // '~{pub64}/avatar'
KEY.user(pub).blob(hash)    // '~{pub64}/blob/{hash}'
KEY.user(pub).app('myapp')  // '~{pub64}/myapp'
KEY.user(pub).entry('posts', id) // '~{pub64}/posts/{ts16}-{id}'

// Space keys
KEY.space(uuid).base        // '@{uuid}'
KEY.space(uuid).acl         // '@{uuid}/~acl'
KEY.space(uuid).meta        // '@{uuid}/~meta'
KEY.space(uuid).field('settings')  // '@{uuid}/settings'
KEY.space(uuid).entry('chat', id)  // '@{uuid}/chat/{ts16}-{id}'

// Inbox
KEY.inbox(pub)              // '>{pub64}/'

// System / Peers
KEY.peer(pub)               // 'sys/peers/{pub64}'

// Utilities
KEY.ts16()                  // sortable 16-char timestamp string
KEY.id()                    // crypto.randomUUID()
await KEY.sha256url(buffer) // SHA-256 → base64url hash
```

### Why Sortable Timestamps?

`KEY.ts16()` produces a zero-padded hex timestamp that sorts lexicographically by time. Combined with a random UUID, this gives you naturally time-ordered keys perfect for chat messages, events, and logs:

```js
// Good: time-ordered keys
const msgKey = KEY.space(roomId).entry('chat', KEY.id())
// → '@{uuid}/chat/0001954abc123def-{uuid}'

// All messages in chronological order:
const msgs = await qr.db.query(`@${roomId}/chat/`, { order: 'key' })
```

---

## Offline-First Operation

QuRay works without any relay. Writes are immediately stored locally:

```js
// Works fully offline — no relay needed
const qr = await QuRay.init({ alias: 'Alice' })

await qr.db.put('~/note', { text: 'Written offline' })
// Stored in IndexedDB, _status: 'pending'

// Later, when relay connects:
await QuRay.init({ relay: 'wss://relay.example.com', alias: 'Alice' })
// Pending QuBits are automatically drained to the relay
```

---

## Next: Users & Identity →

Continue to [02 — Users & Identity](./02-users.md) to learn how cryptographic identities, user spaces, and profile data work.
