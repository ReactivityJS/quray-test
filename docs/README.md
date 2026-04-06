# QuRay

> Offline-first reactive P2P database framework.
> Works in browsers and Node.js. No backend required to start.

```js
import QuRay from './src/quray.js'

const qr = await QuRay.init({ relay: 'wss://relay.example.com', alias: 'Alice' })

// Write data — signed, stored locally, synced in background
await qr.db.put('~' + qr.me.pub + '/note', { text: 'Hello!' })

// React to changes — fires on local writes AND incoming sync
const off = qr.db.on('~' + qr.me.pub + '/note', (q) => {
  console.log(q?.data.text)
})

// Read data — returns QuBit | null
const q = await qr.db.get('~' + qr.me.pub + '/note')
console.log(q?.data, q?.ts, q?.from)
```

---

## Core concepts

### QuBit — the only data format

Every value stored in QuRay is a **QuBit**: a signed, optionally encrypted atomic data point.

```
~{pub64}/           User space   — your data, synced across your devices
@{uuid}/            Space        — shared/group data, ACL-governed
>{pub64}/           Inbox        — received messages, relay-routed
sys/                Ephemeral    — in-memory only, never persisted
conf/               Config       — local-only, survives reload
blobs/              Blobs        — binary content-addressed storage
```

### Everything is reactive

Data flows one way: through `QuDB`. Writes fire `db.on()` listeners. Incoming sync fires the same listeners. UI always sees the same event regardless of source.

### Offline-first

`QuDB` works without any relay. Writes are stored locally with `_status: 'pending'`. When a relay connects, the sync queue drains automatically.

---

## Installation

```bash
# Clone or copy the src/ directory into your project
# No build step required — pure ES modules

# Start a relay server
node relay.js

# Or with options
PORT=8080 DATA_DIR=./data node relay.js
```

**Dependencies** (Node.js relay only):
```bash
npm install ws
npm install web-push   # optional: Web Push notifications
```

---

## QuRay.init() — full option reference

```js
const qr = await QuRay.init({
  // Connection
  relay:  'wss://relay.example.com',      // single relay URL
  relays: ['wss://a.com', 'wss://b.com'], // or multiple

  // Identity
  alias:      'Alice',                    // display name
  passphrase: 'my-secret',               // encrypt identity backup
  identity:   savedBackup,               // restore from previous session

  // Sync behaviour
  blobAutoLoadLimit: 512 * 1024,         // auto-download blobs below 512KB
  syncOnConnect:     true,               // diff-sync on relay connect

  // Transport options (merged into each transport)
  ws:   { pingInterval: 25_000 },
  http: { timeout: 15_000 },

  // Plugins
  presence: true,    // QuPresence — peer.hello/bye/typing (default: true)
  ui:        false,  // Register Custom Elements — qu-text, qu-list, etc.

  // Advanced
  backends: { 'conf/': MyCustomStorage() },  // override a mount backend
  plugins:  [MyLoggingPlugin()],              // custom middleware
  middleware: { sign: true, verify: true },   // disable specific middleware
})
```

---

## QuDB API

```js
// Write
await db.put(key, data)
await db.put(key, data, { type: 'msg', sync: false, enc: recipientEpub })

// Read
const q = await db.get(key)         // → QuBit | null
const qs = await db.query(prefix, {
  order: 'ts',          // 'ts' | 'ts-desc' | 'key' | 'data.order'
  limit: 100,
  since: timestamp,
  filter: (q) => !q.deleted,
})

// Delete (soft — creates tombstone that syncs)
await db.del(key)
// Hard delete (local-only mounts or explicit)
await db.del(key, { hard: true })

// Reactive subscription
const off = db.on('~pub/**', (qubit, { event, key, source }) => {
  if (event === 'put') render(qubit.data)
  if (event === 'del') removeItem(key)
})
// Pattern syntax:
//   '~pub/note'        exact key
//   '~pub/**'          all keys under ~pub/ (recursive)
//   '@space/chat/*'    one level wildcard
//   '**'               all keys

// Signal — thin reactive wrapper around a single key
const alias = db.signal('~pub/alias')
await alias.set('Alice')
alias.on(val => render(val))

// Blobs
await db.blobs.put(hash, arrayBuffer, { mime: 'image/png', name: 'photo.png' })
const status = db.blobs.status(hash)   // → { status, url, meta } | null
const off = db.blobs.on(hash, ({ status, url, meta }) => { ... })
db.blobs.load(hash)   // trigger download for AWAITING_USER status

// Delivery tracking
const off = db.delivery.on(msgKey, ({ state }) => {
  //  local → queued → relay_in → peer_sent → peer_recv → peer_read
  if (state === 'relay_in')  showSingleTick()
  if (state === 'peer_recv') showDoubleTick()
  if (state === 'peer_read') showBlueTick()
})
await db.delivery.isAtLeast(msgKey, 'relay_in')  // → boolean
```

---

## QuSync API

```js
// Access via qr._.sync
const sync = qr._.sync

// Peer management
sync.addPeer({ url: 'wss://relay.example.com', type: 'relay', transportName: 'ws:0' })
sync.removePeer(peerId)
sync.getPeers()   // → PeerEntry[]

// Pull missing data from a peer
await sync.syncIn(prefix?)       // pull specific prefix or all active prefixes
await sync.syncOut()             // push locally-pending QuBits to queue
await sync.fullSync()            // syncIn + syncOut

// Live subscriptions
const off = await sync.subscribe('@space/chat/', { live: true, snapshot: true })
await sync.unsubscribe('@space/chat/')

// Combined local listener + remote subscription
const off = await sync.observe('@space/chat/**', (q, { event }) => {
  if (event === 'put') addMessage(q)
  if (event === 'del') removeMessage(q.key)
})
// cleanup:
off()

// observe + immediate local query (for initial render)
const { off, rows } = await sync.pull('@space/todos/', (q, meta) => updateTodo(q, meta))
renderTodos(rows)

// Plugin hook — intercept specific incoming QuBit types
const off = sync.registerHandler('my.custom.type', async (qubit, src) => {
  console.log('received custom type from', src, qubit.data)
})
```

---

## Space API

```js
const space = qr.space('@uuid-of-space')

// Read
await space.get('chat/001')
await space.query('chat/', { order: 'ts', limit: 100 })

// Write
await space.put('chat/' + Key.ts16(), { text: 'Hello!' })
await space.del('chat/001')

// React
const off = space.on('chat/**', (q, { event }) => { ... })

// ACL check
const canWrite = await space.can(qr.me.pub, 'write')

// Members
await space.members.add(peer)
await space.members.remove(pub)
const members = await space.members.list()
```

---

## Presence and Typing

```js
// Access presence plugin
const presence = qr._.presence

// React to peer online/offline
presence.on('peerOnline',  ({ pub, alias, epub }) => updateUI(pub, true))
presence.on('peerOffline', ({ pub }) => updateUI(pub, false))

// Or via QuDB (fires for every peer state change)
const off = qr.db.on('sys/peers/**', (q, { event }) => {
  if (event === 'put') showOnline(q.data.pub, q.data.alias)
  if (event === 'del') showOffline(q.key)
})

// Send typing indicator
await presence.sendTyping(qr._.net, '@space-uuid')

// React to typing
const off = qr.db.on('conf/typing/@space-uuid/**', (q, { event }) => {
  if (event === 'put') showTypingIndicator(q.data.from)
  if (event === 'del') hideTypingIndicator(q.data?.from)
})
```

---

## Local peer identity

```js
qr.me.pub        // ECDSA public key (base64url)
qr.me.epub       // ECDH public key for E2E encryption
qr.me.pub64      // pub normalized to URL-safe base64url
qr.me.alias      // display name

// Update profile
qr.me.alias = 'Bob'          // saves to ~pub/alias, syncs
await qr.me.setAlias('Bob')  // same, async

// Watch own profile
qr.me.watch(() => render(qr.me.alias, qr.me.avatar))
```

---

## Key helpers

```js
import { KEY } from './src/core/qubit.js'

KEY.user(pub).base          // '~{pub64}'
KEY.user(pub).alias         // '~{pub64}/alias'
KEY.user(pub).avatar        // '~{pub64}/avatar'
KEY.user(pub).blob(hash)    // '~{pub64}/blob/{hash}'
KEY.user(pub).app('myapp')  // '~{pub64}/myapp'

KEY.space(uuid).base        // '@{uuid}'
KEY.space(uuid).acl         // '@{uuid}/~acl'
KEY.space(uuid).meta        // '@{uuid}/~meta'
KEY.space(uuid).chat(ts)    // '@{uuid}/chat/{ts16}-{id}'

KEY.inbox(pub)              // '>{pub64}'
KEY.peer(pub)               // 'sys/peers/{pub64}'

KEY.ts16()                  // sortable timestamp string '0001954abcdef01'
KEY.id()                    // random UUID
```

---

## E2E Encryption

```js
// Encrypt a message for a recipient
const recipientEpub = await qr.peers.getEpub(recipientPub)
await db.put(msgKey, { text: 'Secret message' }, { enc: recipientEpub })

// Decryption is automatic when reading — db.get() decrypts transparently
const q = await db.get(msgKey, { decrypt: true })
```

---

## Transport plugins

All transports implement the same interface. Add custom transports via `qr._.net.use()`.

```js
import { WebRtcTransport, WebRtcPresencePlugin } from './src/transports/webrtc.js'

const webrtc = WebRtcTransport({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
qr._.net.use(webrtc, 'webrtc')

// Wire signaling
const rtcPlugin = WebRtcPresencePlugin({ net: qr._.net, webrtc, identity: qr.me, presence: qr._.presence })
rtcPlugin.attach(qr._.sync)

// Access audio/video (WebRTC-specific — not in core interface)
const stream = await webrtc.startMedia({ audio: true, video: true })
const remoteStream = webrtc.getRemoteStream(peerPub)
webrtc.onMediaStream(({ peerId, stream }) => attachVideo(peerId, stream))
```

---

## Running the relay

```bash
node relay.js
# → http://localhost:8080  WebSocket: ws://localhost:8080

PORT=443 HTTPS_CERT=cert.pem HTTPS_KEY=key.pem node relay.js
# → https://...  wss://...

FEATURE_PUSH=true VAPID_EMAIL=mailto:you@example.com node relay.js
# → Web Push enabled
```

**Environment variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `STATIC_DIR` | `./` | Browser app files |
| `DATA_DIR` | `./quray-data` | QuBit storage directory |
| `API_KEY` | — | Require `X-Api-Key` header |
| `MAX_BLOB_MB` | `100` | Max blob upload size |
| `HTTPS_CERT` | — | TLS certificate path |
| `HTTPS_KEY` | — | TLS key path |
| `FEATURE_PUSH` | `false` | Enable Web Push |
| `FEATURE_SYNC` | `true` | Enable persistence |
| `FEATURE_ROUTER` | `true` | Enable WS peer routing |

---

## Running tests

```bash
# All Node.js tests
npm test

# Specific suites
npm run test:peers      # 2-peer sync integration tests
npm run test:framework  # core DB and pipeline tests
npm run test:contracts  # API contract tests
npm run test:delete     # tombstone sync tests
npm run test:blob-progress  # blob upload/download
```

---

## Architecture overview

```
Apps / UI
   ↓
QuRay facade (quray.js)
   ↓
QuDB     QuSync     QuPresence (plugin)
  ↓         ↓
Backends  QuNet → Transports (WS, HTTP, LocalBridge, WebRTC)
  ↓
MOUNT contract (mounts.js)
  ~ @ > sys/ conf/ blobs/
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design documentation.
