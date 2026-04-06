# QuRay Framework — Architektur & Design-Prinzipien

> **Kern-Prinzip:** Jede Schicht fügt genau eine Verantwortlichkeit hinzu.
> Core bleibt schlank. Alles Optionale kommt per Plugin und Hook.

---

## Schichtenmodell

```
┌─────────────────────────────────────────────────────────────────┐
│  Apps & Demos                                                   │
├─────────────────────────────────────────────────────────────────┤
│  UI Components  src/ui/           (optionales Plugin)           │
│  binding.js · directives.js · components.js                     │
│  → Reaktive DOM-Bindungen, <qu-text>, <qu-list>, <qu-media>     │
├─────────────────────────────────────────────────────────────────┤
│  QuRay API      src/quray.js      (Facade / Bootstrapper)       │
│  qr.db · qr.me · qr.peers · qr.node                            │
│  qr.inbox() · qr.send() · qr.space()                           │
│  qr.addRelay() · qr.removeRelay()                               │
├──────────────────────┬──────────────────────────────────────────┤
│  Presence (Plugin)   │  Network                                 │
│  QuPresence          │  QuNet: Transport-Abstraktion            │
│  peer.hello/bye      │  WsTransport · HttpTransport             │
│  typing-indicators   │  LocalBridge · WebRtcTransport (Plugin)  │
│  presence.on(event)  │                                          │
├──────────────────────┼──────────────────────────────────────────┤
│  Sync                │  Queue                                   │
│  QuSync              │  SYNC_OUT · BLOB_UP · BLOB_DOWN          │
│  addPeer()           │  persistent, retry on reconnect          │
│  subscribe/observe   │                                          │
│  registerHandler()   │                                          │
├──────────────────────┴──────────────────────────────────────────┤
│  QuDB               src/core/db.js                              │
│  put · get · del · query · on · signal                          │
│  blobs.put/get/on/load · delivery.set/get/on                    │
│  db.sync (interface für QuSync — kein Netz-Wissen)              │
│  Backends als Mounts: IDB · Memory · LocalStorage · FS · SQLite │
├─────────────────────────────────────────────────────────────────┤
│  Mounts             src/core/mounts.js   (formaler Contract)    │
│  MOUNT.USER ~ · SPACE @ · INBOX > · SYS · CONF · BLOBS         │
│  mountFor(key) · isSyncable(key) · isLocalOnly(key)             │
├─────────────────────────────────────────────────────────────────┤
│  Plugins            src/plugins/                                │
│  sign · verify · store · dispatch · e2e · access · logger       │
│  IN-Pipeline (prio: VERIFY 80 → STORE 60 → DISPATCH 50)        │
│  OUT-Pipeline (E2E 75 → SIGN 70 → STORE 60 → DISPATCH 49       │
│               → SYNC_OUT 5)                                     │
├─────────────────────────────────────────────────────────────────┤
│  Core Primitives    src/core/                                   │
│  identity.js · qubit.js · events.js · delivery.js · queue.js   │
│  ECDSA/ECDH · QuBit-Format · EventBus/Signal/Hook/PrioStack     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design-Prinzipien

### 1. Core bleibt schlank

QuDB, QuNet, QuSync kennen keine optionalen Features.
Alles Optionale kommt per Plugin/Hook:

| Feature | Lösung |
|---------|--------|
| Verschlüsselung | E2ePlugin (OUT prio 75) |
| Signatur | SignPlugin (OUT prio 70) |
| Presence / Typing | QuPresence (Plugin) |
| WebRTC Audio/Video | WebRtcTransport + WebRtcPresencePlugin |
| UI-Bindungen | QuBinding / QuDirectives (Plugin) |
| Access Control | AccessControlPlugin (IN pipeline) |
| Logging | LoggerPlugin |

### 2. Plugins klinken sich per Hook ein

```js
// Middleware-Plugins über db.useIn / db.useOut:
db.use(SignPlugin(identity))      // OUT pipeline, prio 70
db.use(StoreOutPlugin())          // OUT pipeline, prio 60
db.use(DispatchPlugin())          // OUT pipeline, prio 49

// Sync-spezifisch: type-keyed handler
sync.registerHandler('peer.hello', async (qubit) => { ... })
sync.registerHandler('webrtc.offer', async (qubit) => { ... })

// QuPresence als Plugin (nicht im Core verdrahtet):
const presence = QuPresence({ db, identity })
presence.attach(sync)   // registriert peer.hello / peer.bye / typing handler

// Presence-Events für weitere Plugins:
presence.on('peerOnline',  ({ pub, alias }) => { ... })
presence.on('peerOffline', ({ pub }) => { ... })

// WebRTC erweitert — ohne Core zu kennen:
const webrtc = WebRtcTransport({ iceServers })
net.use(webrtc, 'webrtc')
const rtcPlugin = WebRtcPresencePlugin({ net, webrtc, identity, presence })
rtcPlugin.attach(sync)
// Audio/Video ist nur auf dem Transport-Objekt — nicht in QuDB oder QuSync:
const stream = await webrtc.startMedia({ audio: true, video: false })
```

### 3. Plugin-Konfiguration ist isoliert

Jedes Plugin liest seinen eigenen Namespace aus `options`:

```js
await QuRay.init({
  relay: 'wss://relay.example.com',

  // Core-Optionen — nur für QuDB, QuSync, Identity
  alias: 'Alice',
  blobAutoLoadLimit: 256 * 1024,
  syncOnConnect: true,

  // Plugin-Optionen — eigener Unterbereich
  presence: true,           // false → QuPresence nicht laden
  ws:   { pingInterval: 10_000 },   // an WsTransport weitergereicht
  http: { timeout: 30_000 },        // an HttpTransport weitergereicht
  ui:   true,               // Custom Elements registrieren

  // Middleware-Flags (selten gebraucht)
  middleware: { sign: true, verify: true },

  // Custom Backends für einzelne Mounts
  backends: { 'conf/': MyCustomStore() },

  // Zusätzliche Middleware-Plugins
  plugins: [MyLoggingPlugin()],
})
```

### 4. Peers sind alle gleich — Features kommen per Plugin

Browser-Client, Node-Relay, ReplicaDB — alle basieren auf denselben Primitiven:

```
Peer-Grundinstanz (Browser + Node):
  QuDB + QuSync + QuNet + QuQueue + Identity

Features per Plugin:
  Browser-Relay:    + LocalBridgeTransport
  Node-Relay:       + FsBackend (injiziert in createReplicaDb)
  ReplicaDB:        + createReplicaDb (Backend-agnostisch)
  Audio/Video:      + WebRtcTransport.startMedia()
```

`createReplicaDb` importiert **kein** `node:fs`. Der Aufrufer injiziert das Backend:

```js
// Node.js Relay:
import { FsBackend } from './backends/fs.js'
const replica = await createReplicaDb({
  mainBackend: FsBackend({ dir: './data/msgs' }),
  blobBackend: FsBackend({ dir: './data/blobs' }),
})

// Browser / Test:
import { MemoryBackend } from './backends/memory.js'
const replica = await createReplicaDb({
  mainBackend: MemoryBackend(),
  blobBackend: MemoryBackend(),
})
```

---

## Mount-Contract

```
MOUNT.USER   prefix:'~'      sync:true   store:'idb'      ~{pub64}/...
MOUNT.SPACE  prefix:'@'      sync:true   store:'idb'      @{id}/...
MOUNT.INBOX  prefix:'>'      sync:true   store:'idb'      >{pub64}/...
MOUNT.SYS    prefix:'sys/'   sync:false  store:'memory'   ephemeral
MOUNT.CONF   prefix:'conf/'  sync:false  store:'storage'  lokal persistent
MOUNT.BLOBS  prefix:'blobs/' sync:false  store:'idb'      binary blobs
```

```js
import { MOUNT, mountFor, isSyncable, isLocalOnly } from './core/mounts.js'

mountFor('~pub/alias')   // → MOUNT.USER  { sync: true, store: 'idb', ... }
isSyncable('~pub/note')  // → true
isLocalOnly('conf/key')  // → true
LOCAL_ONLY_RE.test(key)  // → schneller Regex-Check für Hot-Paths
```

---

## Datenschema: QuBit

**Ein QuBit = atomarer, signierter, optional verschlüsselter Datenpunkt.**

```ts
interface QuBit {
  key:   string      // Vollständiger DB-Key: "~pub64/alias"
  data:  any         // Payload: String | Number | Boolean | flaches Object | null
  type:  string      // 'data' | 'msg' | 'blob.meta' | 'peer.hello' | ...
  from:  string      // pub64 des Autors
  ts:    number      // Unix-ms
  id:    string      // UUID
  sig:   string|null // ECDSA-Signatur
  enc:   string|null // 'env-aes-gcm' | null
  refs:  string[]    // Referenzen auf andere Keys
  order: number|null // Fractional-Index für sortierbare Listen
  // Interne Felder (nicht transportiert):
  _status:  'pending' | 'synced' | 'local' | null
  _mine:    boolean
  _localTs: number
}
```

---

## QuDB API

```js
// CRUD
await db.put(key, data, opts?)   // opts: { type, enc, sync, order }
await db.get(key)                // → QuBit | null
await db.del(key)                // Tombstone (syncable) oder hard-delete (lokal)
await db.query(prefix, opts?)    // → QuBit[]

// Reaktivität
const off = db.on(pattern, fn)   // fn(qubit, { event, key, source })
// pattern: 'exact/key' | '~pub/**' | '@space/chat/*' | '**'
// event: 'put' | 'del'

// Blobs
await db.blobs.put(hash, buffer, meta, opts?)
db.blobs.status(hash)            // → { status, url, meta } | null
const off = db.blobs.on(hash, fn)
db.blobs.load(hash)              // manuell laden (bei AWAITING_USER)

// Delivery (6-stage funnel)
const off = db.delivery.on(key, fn)
await db.delivery.isAtLeast(key, 'relay_in')
```

---

## QuSync API

```js
// Peer registrieren (Relay, Client, LocalBridge, ReplicaDB)
sync.addPeer({ url, type, transportName, capabilities, httpUrl })
sync.removePeer(peerId)
sync.getPeers()   // → PeerEntry[]

// Sync-Operationen
await sync.syncIn(prefix?, peerId?)   // Pull missing QuBits from peer
await sync.syncOut()                   // Push locally-pending QuBits to queue
await sync.fullSync(peerId?)           // syncIn + syncOut

// Remote-Subscriptions
const off = await sync.subscribe('@space/chat/', { live: true })
await sync.unsubscribe('@space/chat/')

// Kombiniert: db.on + sync.subscribe
const off = await sync.observe('@space/chat/**', (q, meta) => { ... })

// Mit sofortigem lokalem Ergebnis
const { off, rows } = await sync.pull('@space/todos/', handler)

// Plugin-Hook: eigene QuBit-Typen abfangen
const off = sync.registerHandler('my.type', async (qubit, src) => { ... })
```

---

## Transport-Interface

Alle Transports implementieren dasselbe Interface:

```js
{
  state,           // Signal<'disconnected'|'connecting'|'connected'|'error'>
  connect(url),    // → Promise<void>
  disconnect(),    // → Promise<void>
  send(packet, opts?),  // → Promise<boolean>
  on(event, fn),   // event: 'message' | 'connect' | 'disconnect'
  capabilities: {
    realtime, background, p2p, streaming, maxPacket
  }
}
```

WebRTC erweitert das Interface **ohne den Core zu ändern**:

```js
// Nur auf WebRtcTransport-Instanz — nicht im Core:
webrtc.startMedia({ audio, video })   // → Promise<MediaStream>
webrtc.stopMedia()
webrtc.getRemoteStream(peerId)        // → MediaStream | null
webrtc.onMediaStream(fn)              // → off()
```

---

## Sync-Flow

```
Outgoing write:
  db.put() → OUT pipeline:
    E2ePlugin    (prio 75)  verschlüsseln
    SignPlugin   (prio 70)  ECDSA signieren
    StoreOut     (prio 60)  in IDB schreiben
    DispatchOut  (prio 49)  db.on() feuern
    SyncOut hook (prio  5)  queue.enqueue(SYNC_OUT) ← kein db.on('**') mehr!

Incoming data:
  transport → net.on('message') → sync._processIncoming()
    → sync.registerHandler? (QuPresence, WebRTC, App-Plugin)
    → db.sync.processIn() → IN pipeline:
        VerifyPlugin  (prio 80)
        StoreIn       (prio 60)
        DispatchIn    (prio 50)  → db.on() feuert → UI updated
```

---

## Delivery States

```
1. local      → StoreOutPlugin nach db.put
2. queued     → SyncOut-Hook: SYNC_OUT Task eingereiht
3. relay_in   → HTTP POST /api/msg bestätigt
4. peer_sent  → Relay: WS-Push an Peer gesendet
5. peer_recv  → Peer: ACK zurückgesendet
6. peer_read  → Peer: READ-QuBit zurückgesendet

Blobs (parallel):
blob_local   → db.blobs.put() abgeschlossen
blob_relay   → POST /api/blob bestätigt
blob_peer    → Peer hat Blob heruntergeladen
```
