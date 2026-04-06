# QuRay Framework — Entwickler-Dokumentation (v0.9)

## Architektur-Übersicht

QuRay ist ein reaktives P2P-Framework. Das Kernprinzip:

> **Jeder Knoten im Netzwerk ist ein Peer. Ein Relay ist nur ein Peer mit persistenter Speicherung, HTTP-API und Routing-Features.**

```
┌─────────────────────────────────────────────────────────────────┐
│                        QuRay Framework                          │
├────────────────┬───────────────────────┬───────────────────────┤
│   IDENTITY     │       QUDB             │     NETWORK           │
│                │                        │                       │
│  LocalPeer     │  Backends:             │  QuNet                │
│  • pub/epub    │  • IdbBackend          │  • WebSocket          │
│  • sign/verify │  • LocalStorage        │  • HTTP               │
│  • encrypt     │  • MemoryBackend       │  • WebRTC (slot)      │
│  • decrypt     │  • FileSystem          │                       │
│  • me.watch()  │                        │  Relay = Peer +       │
│                │  Pipelines:            │  • persistence        │
│  RemotePeer    │  • sign → store →      │  • routing            │
│  • alias       │    dispatch            │  • HTTP API           │
│  • avatar      │  • verify → store →    │  • push notify        │
│  • props       │    dispatch            │                       │
│  • online      │                        │  Transport:           │
│  • onChange()  │  QuNode:               │  wss:// oder ws://    │
│                │  • node.write()        │  https:// oder http://│
│  PeerMap       │  • node.read()         │                       │
│  • get(pub)    │  • node.watch()        │                       │
│  • all / online│  • node.user.*         │                       │
│  • onChange()  │  • node.list()         │                       │
├────────────────┴───────────────────────┴───────────────────────┤
│                     SYNC & QUEUE                                │
│  QuSync: diffSync, blob up/download, relay connect/reconnect    │
│  QuQueue: persistente Tasks, retry, progress callbacks          │
├────────────────────────────────────────────────────────────────┤
│                     UI COMPONENTS                               │
│  <qu-bind>  <qu-media>  <qu-list>  ProfileManager              │
└────────────────────────────────────────────────────────────────┘
```

---

## 1. Datenstruktur: QuBit

Jede Datenmutation im System ist ein **QuBit** — die atomare Einheit.

```ts
interface QuBit {
  key:      string          // DB-Key (Pfad, s. Key-Schema unten)
  data:     any             // Payload (JSON-serialisierbar)
  from:     string          // pub64 des Schreibers
  ts:       number          // Unix-Millisekunden
  type:     QuBitType       // 'data' | 'msg' | 'blob.meta' | ...
  sig?:     string          // ECDSA-Signatur über (key+data+ts)
  enc?:     EnvelopeData    // Verschlüsselungs-Envelope
  refs?:    string[]        // Referenzen auf andere QuBit-Keys
  id:       string          // UUID (wird bei Erstellung generiert)
  // Interne Felder (nie vom App-Code gesetzt)
  _status:  'pending' | 'synced' | 'local'
  _mine?:   boolean         // vom lokalen Peer geschrieben
}
```

### QuBit-Typen

| Typ | Beschreibung | Persistiert |
|---|---|---|
| `'data'` | Generischer atomarer Wert (Profile, App-Daten) | ✓ |
| `'msg'` | Nachricht (optional E2E-verschlüsselt) | ✓ |
| `'blob.meta'` | Blob-Metadaten (MIME, Name, Hash) | ✓ |
| `'peer.hello'` | Peer verbunden (RAM-only) | ✗ |
| `'peer.bye'` | Peer getrennt (RAM-only) | ✗ |
| `'webrtc.*'` | WebRTC-Signaling (RAM-only) | ✗ |

---

## 2. Key-Schema

**Grundprinzip:** Ein Key = ein atomarer Wert. Kein verschachteltes Objekt als Root.

```
~{pub64}/                   User-Space
  ~{pub64}                  User Node root: {pub, epub, alias}
  ~{pub64}/avatar           base64-JPEG (max 128px)
  ~{pub64}/props            [{key, value, encrypted?, enc?}]
  ~{pub64}/backup           PBKDF2-Ciphertext (Keypair-Backup)
  ~{pub64}/status           online-Sichtbarkeit: 'public'|'hidden'
  ~{pub64}/{app}/{key}      App-spezifische User-Daten

>{pub64}/                   Inbox (relay-managed)
  >{pub64}/{ts16}-{id}      eingehende Nachrichten / Einladungen

@{uuid}/                    Shared Space
  @{uuid}/~acl              {owner, writers: '*'|[pub64,...]}
  @{uuid}/~meta             {name, created, type, ...}
  @{uuid}/members/{pub64}   true
  @{uuid}/{type}/{ts16}-{id} Space-Daten (Nachrichten, Todos, ...)

sys/                        System (RAM-only, nie sync'd)
  sys/peers/{pub64}         Peer-Status (online/offline)

conf/                       Lokale Konfiguration (nie sync'd)
  conf/identity             Keypair-Backup (verschlüsselt)
  conf/chats                gespeicherte Chat-Metadaten
  conf/{app}-{key}          App-spezifische lokale Config

blobs/                      Binary Store (separates Backend)
  blobs/{sha256}            Rohdaten (ArrayBuffer)
```

### KEY-API (programmatisch)

```js
import { KEY } from 'quray'

KEY.user(pub).root              // → ~{pub64}
KEY.user(pub).field('avatar')   // → ~{pub64}/avatar
KEY.user(pub).app('myapp', 'x') // → ~{pub64}/myapp/x
KEY.user(pub).blob(hash)        // → ~{pub64}/blob/{hash}

KEY.space(id).meta              // → @{id}/~meta (shortcut)
KEY.space(id).acl               // → @{id}/~acl
KEY.space(id).data('chat', key) // → @{id}/chat/{key}

KEY.inbox(pub).item(ts, id)     // → >{pub64}/{ts16}-{id}
KEY.peer(pub)                   // → sys/peers/{pub64}
```

---

## 3. Init

```js
import QuRay from './src/quray.js'

const qr = await QuRay.init({
  // Relay-Verbindung (Relay ist ein Peer mit Persistenz + HTTP)
  relay:   'wss://my-relay.example.com',   // string oder Array
  relays:  [{ url: 'wss://...', priority: 10, label: 'main' }],

  // Identität
  alias:    'Alice',                   // Anzeigename (wird in User Node gespeichert)
  backup:   savedBackupString,         // Keypair wiederherstellen
  passphrase: 'secret',               // Backup-Passphrase

  // DB-Optionen
  blobAutoLoadLimit: 512 * 1024,       // max. Auto-Download in Bytes (default: 512 KB)
  conflictStrategy:  'lww',            // Last-Write-Wins (default)

  // UI-Komponenten
  ui: true,   // registers the generic UI components such as <qu-bind>, <qu-media>, <qu-list>
})
```

---

## 4. LocalPeer — `qr.me`

Der eigene Peer. Alles wird in `~{pub}/` in der DB persistiert und via Relay sync'd.

```js
// Identität
qr.me.pub           // pub64 — URL-sicherer ECDSA-Public-Key (base64url)
qr.me.epub          // epub64 — ECDH-Public-Key für Envelope-Verschlüsselung
qr.me.pub64         // alias für me.pub (identisch)
qr.me.epub64        // alias für me.epub (identisch)

// Profil — reaktiv: Schreiben → DB → Relay-Sync → andere Peers sehen es
qr.me.alias              // string (getter)
qr.me.alias = 'Bob'      // setter → schreibt ~pub + conf/identity
qr.me.avatar             // Promise<string|null> — liest ~pub/avatar aus IDB
qr.me.avatar = base64    // setter → schreibt ~pub/avatar → relay sync'd
qr.me.nodeKey            // '~{pub64}' (DB-Key des Root-Nodes)

// Reaktivität — feuert bei JEDER Änderung unter ~{pub}/** (eigenes Gerät oder Relay-Sync)
const off = qr.me.watch(async () => {
  const alias = qr.me.alias
  const avatar = await qr.me.avatar
  updateUI(alias, avatar)
})
// off() — Listener entfernen

// Krypto
await qr.me.sign(dataString)                   // → base64-Signatur
await qr.me.verify(dataString, sig, peerPub)   // → boolean
await qr.me.encrypt(plaintext, recipients)     // → EnvelopeData
// recipients: null (self-only) | [{pub, epub}] | [{pub, epub}, ...]
await qr.me.decrypt(envelopeData)              // → string

// Keypair-Backup
const backup = await qr.me.backup()            // exportiert (ohne Passphrase)
const backup = await qr.me.backup('passphrase') // PBKDF2-verschlüsselt
```

---

## 5. RemotePeer — `qr.peers.get(pub)`

Ein anderer Peer. Reaktiv: wird automatisch aus DB und Relay befüllt.

```js
const peer = qr.peers.get(pub)   // PeerMap.get() — immer dieselbe Instanz

// Identität
peer.pub         // pub64
peer.epub        // epub64 (oder null, wenn noch nicht empfangen)
peer.pub64       // alias für peer.pub
peer.epub64      // alias für peer.epub

// Profil (reaktiv — aus ~{pub}/** in DB)
peer.alias       // string
peer.avatar      // string|null (base64-JPEG)
peer.props       // [{key, value}] — nur öffentliche Props
peer.online      // boolean

// Reaktivität
const off = peer.on(updatedPeer => {
  console.log(updatedPeer.alias, updatedPeer.online)
})

// Krypto (für E2E mit diesem Peer)
await peer.verify(dataString, sig)
await peer.encrypt(plaintext, myEcdhPrivateKey)
```

### PeerMap — `qr.peers`

```js
qr.peers.get(pub)     // RemotePeer (stabile Referenz, auto-erstellt)
qr.peers.all          // RemotePeer[] — alle bekannten Peers
qr.peers.online       // RemotePeer[] — nur online
qr.peers.count        // Anzahl

// Reaktivität — feuert wenn irgendein Peer sein Profil/Status ändert
const off = qr.peers.onChange(peerMap => {
  for (const peer of peerMap.all) { renderPeer(peer) }
})
```

---

## 6. QuDB — `qr.db`

Reaktive lokale Datenbank mit Relay-Sync. Offline-First.

```js
// Schreiben — Änderung wird in IDB gespeichert + in Sync-Queue eingereiht
await qr.db.put(key, data)
await qr.db.put(key, data, { type: 'msg', sync: false, enc: envelopeData })

// Lesen — aus lokalem IDB
const qubit = await qr.db.get(key)
const value = qubit?.data ?? qubit  // data ist in qubit.data

// Löschen
await qr.db.del(key)

// Query — gibt alle QuBits mit diesem Key-Prefix zurück
const qubits = await qr.db.query(prefix)
const qubits = await qr.db.query('@space/chat/', { order: 'ts', limit: 50 })

// Reaktiver Listener — feuert auf lokale + remote Änderungen
// Muster unterstützen '*' (ein Segment) und '**' (beliebig viele)
const off = qr.db.on('~{pub}/**', (qubit, { key, event, source }) => {
  // source: 'local' (eigener db.put) | 'remote' (via Relay)
  if (event === 'del') { /* gelöscht */ }
  else { /* neuer/geänderter Wert */ }
})

// Sync-Status
qr.db.syncState()  // { pending, synced } — Anzahl ausstehender Sync-Tasks
await qr.db.syncAll()  // alle pending Tasks sofort sync'en
```

### Blobs — `qr.db.blobs`

```js
// Lokal speichern (erzeugt ObjectURL, stellt in Sync-Queue)
await qr.db.blobs.put(hash, arrayBuffer, { mime, name, size })

// Status abfragen
const status = qr.db.blobs.status(hash)
// { status: 'ready'|'pending'|'awaiting-user'|'error', url, meta }

// Reaktiver Listener
const off = qr.db.blobs.on(hash, ({ status, url, meta }) => {
  if (status === 'ready') { img.src = url }
})

// Manueller Download (für Dateien > blobAutoLoadLimit)
qr.db.blobs.load(hash)

// Upload-Fortschritt via Queue
qr.db.queue.on('task.progress', task => {
  if (task.data?.hash === hash) console.log(task.progress + '%')
})

// Blob-Status-Konstanten
qr.db.blobs.STATUS.READY          // 'ready'
qr.db.blobs.STATUS.PENDING        // 'pending'
qr.db.blobs.STATUS.AWAITING_USER  // 'awaiting-user'
qr.db.blobs.STATUS.ERROR          // 'error'
```

---

## 7. QuNode — `qr.node`

Convenience-API auf DB-Ebene. Kennt das Key-Schema und bietet typisierte Helfer.

```js
// ── Generische Nodes ─────────────────────────────────────────────────────────

// Schreiben (signiert, optional verschlüsselt)
await qr.node.write(key, data)
await qr.node.write(key, data, { enc: recipients })  // encrypt für Empfänger

// Lesen (extrahiert .data aus QuBit)
const value = await qr.node.read(key)   // null wenn nicht vorhanden

// Reaktiver Listener
const off = qr.node.watch(key, (value, qubit) => { /* value = qubit.data */ })

// Query mit optionalem Cursor
const entries = await qr.node.list(prefix, { limit, order, since })
// → [{ key, value, qubit }]


// ── User Nodes / Profile ─────────────────────────────────────────────────────

// Eigenes Profil schreiben
await qr.node.user.setAlias('Alice')
await qr.node.user.setAvatar(base64Jpeg)          // → ~pub/avatar
await qr.node.user.setProps([                      // → ~pub/props
  { key: 'website', value: 'https://...' },        // öffentlich sichtbar
  { key: 'email',   value: 'x@y.z', encrypted: true },  // nur für mich
])
// Prop für bestimmte Peers freischalten:
await qr.node.user.setProps([
  { key: 'phone', value: '+49...', recipients: [peer1Epub, peer2Epub] }
])
await qr.node.user.setVisibility('public')   // im Verzeichnis sichtbar
await qr.node.user.setVisibility('hidden')   // nicht im Verzeichnis

// Fremdes Profil lesen
const profile = await qr.node.user.read(pub)
// → { pub, epub, alias, avatar, props, online, visibility }

// Alle bekannten User Nodes (lokal)
const users = await qr.node.user.list()
// → RemotePeer[] (epub-gated: nur bestätigte User Nodes)

// Reaktiv eigene Profiländerungen
const off = qr.node.user.watch(cb)   // alias für qr.me.watch()


// ── Nachrichten / Inbox ──────────────────────────────────────────────────────

// Eingehende Nachrichten abonnieren (inkl. DM-Einladungen, Gruppen-Invites, ...)
const off = qr.node.inbox(async (data, qubit) => {
  if (data.type === 'dm.invite')    openChat(data.spaceId)
  if (data.type === 'group.invite') joinGroup(data.spaceId)
})

// Nachricht an Peer senden (persist + WS-Push dual delivery)
await qr.node.send(toPub, payload)
// Intern:
//   1. db.put('>toPub/ts-id', payload)   → Relay sync'd für offline delivery
//   2. net.send({to: toPub, payload})    → WS-Push für online delivery
// Die Relay-Routing-Garantie: wenn Peer offline → zugestellt beim nächsten Connect.
```

---

## 8. SpaceHandle — `qr.space(id)`

Shared Spaces für kollaborative Daten.

```js
const space = qr.space('@uuid')   // '@' wird automatisch hinzugefügt wenn nötig

// Metadaten
const meta = await space.meta()   // ~meta QuBit
const acl  = await space.acl()    // ~acl QuBit
const can  = await space.can(pub, 'write')   // Berechtigungs-Check

// CRUD
await space.put('chat/{ts}-{id}', message)
const qubit = await space.get('~meta')
await space.del('chat/{ts}-{id}')
const msgs  = await space.query('chat/', { order: 'ts', limit: 100 })

// Reaktiv
const off = space.on('chat/**', (qubit, { event, key }) => {
  if (event === 'del') removeMsg(key)
  else renderMsg(qubit)
})

// Mitglieder
await space.members.add(peer)
await space.members.remove(pub)
const pubs = await space.members.list()   // [pub64, ...]
```

---

## 9. Relay-Verbindung

```js
// Relay-Verwaltung
await qr.addRelay('wss://relay.example.com')
await qr.removeRelay('wss://relay.example.com')
qr.relays    // [{ url, label }]

// Verbindungs-Status (reaktiv)
qr._.net.state$.on(states => {
  const connected = Object.values(states).some(s => s === 'connected')
  updateDot(connected)
})

// Direktes Senden (umgeht DB, für Signaling)
qr._.net.send({ to: peerPub, payload: { type: 'webrtc.offer', sdp } })

// WS-Nachrichten empfangen
qr._.net.on('message', (packet) => {
  const q = packet?.payload ?? packet
  if (q?.type === 'peer.hello') { /* ... */ }
})
```

---

## 9b. remoteQuery — Relay-Daten ohne lokalen DB-Sync

Daten direkt vom Relay abrufen. Die lokale QuDB bleibt unverändert (Standard). Vollständige Dokumentation → [`docs/REMOTE-QUERY.md`](./REMOTE-QUERY.md).

```js
// Einfachste Form — Ergebnis-Array, kein lokales Schreiben
const people = await qr.remoteQuery('@users/', {
  order:  'ts-desc',
  limit:  50,
  filter: q => !!q.data?.alias,
})

// targetMount — Ergebnis in eigenem DB-Mount ablegen
await qr.remoteQuery('@users/', {
  targetMount: { prefix: 'sys/remote/people/' },
  persist:     'session',   // 'none' | 'session' | 'reload'
})
// danach normal lesbar:
const rows = await qr.db.query('sys/remote/people/')
qr.db.on('sys/remote/people/**', handler)

// Normaler DB-Sync (wie manueller diffSync)
await qr.remoteQuery('@space/todos/', { sync: true })
```

| Option | Beschreibung |
|--------|-------------|
| `order` | `'ts'` / `'ts-desc'` / `'key'` / `'data.order'` — wie `db.query()` |
| `limit` | Max. Ergebnis-Anzahl |
| `filter` | `(qubit) => boolean` — clientseitiger Filter |
| `since` | Nur QuBits mit `ts > since` |
| `sync` | `true` → IN-Pipeline (persist in lokale DB) |
| `targetMount` | `{ prefix, backend? }` — Schreibziel (default: MemoryBackend) |
| `persist` | `'none'` / `'session'` / `'reload'` — Query-Intent-Persistenz |
| `peerId` | Welchen Relay-Peer befragen |
| `timeout` | Timeout in ms (default: 15 000) |

---

## 10. Utility


```js
qr.toPub64(rawPub)   // Base64 → base64url (normalisiert +/= weg)
```

---

## 11. UI-Komponenten (bei `ui: true`)

Alle Komponenten sind Web Components — sie registrieren sich als Custom Elements.

### `<qu-bind>`
Reaktives Textfeld. Bindet sich an einen DB-Key.

```html
<qu-bind key="~{pub}/alias"></qu-bind>
<qu-bind key="@{space}/~meta" get="data.name"></qu-bind>
```

### `<qu-media>`
Bild/Video/Audio/Datei mit Fortschrittsbalken, Download-Button, Sync-Status.

```html
<!-- Zeigt Bild sobald lokal verfügbar -->
<qu-media key="~{pub}/blob/{hash}" autoload>
  <template slot="pending">
    <div class="spinner"></div>
  </template>
  <template slot="awaiting">
    <!-- erscheint wenn Datei > blobAutoLoadLimit -->
    <button data-qu-action="load">⬇ Laden (<span data-qu-size></span>)</button>
  </template>
</qu-media>

<!-- Sync-Status via CSS-Klassen: qu-pending | qu-synced | qu-local -->
<qu-media key="..." class="qu-synced"></qu-media>
```

**Lifecycle:**
1. `qu-local` — lokal gespeichert, Upload ausstehend
2. `qu-pending` — Upload läuft (Fortschrittsbalken aktiv)
3. `qu-synced` — im Relay gespeichert und bestätigt

### `<qu-list>`
Reaktive sortierbare Liste.

```html
<qu-list prefix="@{space}/todos/" sortable editable>
  <template>
    <li data-qu-text="data.text" class="todo-item"></li>
  </template>
</qu-list>
```

### `<qu-context>`
Bindet DB-Daten an einen DOM-Teilbaum.

```html
<qu-context prefix="~{pub}/">
  <span data-qu-text="alias"></span>
  <img data-qu-src="avatar">
</qu-context>
```

---

## 12. ProfileManager (UI-Helper)

Zustandslos, nur Convenience über `qr.db` + `qr.me`.

```js
import { ProfileManager } from 'quray/ui/profile'

const pm = await ProfileManager(qr)

const data = await pm.load()
// → { alias, avatar, props, backup }

await pm.saveAlias('Alice')
await pm.saveAvatar(base64Jpeg)      // null → löscht Avatar
const storedProps = await pm.saveProps([{ key, value, encrypted }])
const decrypted   = await pm.decryptProps(storedProps)
await pm.saveBackup('passphrase')    // null → löscht Backup

// Reaktiv auf alle eigenen Profiländerungen (delegates to qr.me.watch)
const off = pm.watchSelf(freshData => updateUI(freshData))

// Hilfsfunktion: Bild auf max. 128px/JPEG resizen
const b64 = await pm.resizeImg(file, 128)
```

---

## 13. Sync-Garantien

### Local-First
Jeder `db.put()` wird **sofort** lokal in IDB gespeichert — kein Warten auf Relay.

### Sync-Queue
Jede Änderung wird in eine persistente Queue eingereiht (in `conf/_tasks` in LocalStorage). Bei Unterbrechung (offline, Tab-Reload) wird beim nächsten Connect automatisch nachgesynct.

### Delivery-Garantie via Inbox
`qr.send(pub, payload)` nutzt **Dual-Delivery**:
1. `db.put('>pub/ts-id', ...)` → Relay persistiert `>{pub}/` → B bekommt es beim nächsten Connect via `syncIn()`
2. `net.send({to: pub})` → Relay routet direkt an B wenn online

Keine Zustellungsquittung implementiert (kommt in v1.0 mit signed ACK).

### DiffSync
Beim Relay-Connect: `syncIn()` holt alle `~{mein-pub}/` und `>{mein-pub}/` Einträge die neuer als der lokale Stand sind.

---

## 14. Datentypen für Apps

### Temp-Daten (nie sync'd)
```
conf/{prefix}-{key}
```
Nur LocalStorage, bleibt über Reload erhalten aber wird nicht zum Relay sync'd.

### Persistente User-Daten
```
~{pub}/{app}/{key}
```
In eigener User-Space, automatisch sync'd. Write-Authority: nur der Inhaber.

### Shared App-Daten
```
@{spaceId}/{type}/{ts16}-{id}
```
In Shared Space, sync'd für alle Mitglieder. Write-Authority via ACL.

### Nachrichten
```
@{spaceId}/chat/{ts16}-{id}    Gruppen/DM-Nachrichten
>{pub}/{ts16}-{id}             Inbox-Items (Relay-managed)
```

---

## 15. Entwicklungs-Checkliste

Neue App auf Basis von QuRay:

```js
// 1. Init
const qr = await QuRay.init({ relay, alias })

// 2. Eigenes Profil reaktiv halten
qr.me.watch(() => updateMyAvatar(qr.me.avatar))

// 3. Peer-Updates abonnieren
qr.peers.onChange(() => renderPeerList(qr.peers.all))

// 4. Eigene Daten schreiben
await qr.db.put(`~${qr.me.pub}/myapp/config`, { theme: 'dark' })
// ODER via node helper:
await qr.node.write(`~${qr.me.pub}/myapp/config`, { theme: 'dark' })

// 5. Reactive listener
qr.db.on(`~${qr.me.pub}/myapp/**`, (qubit) => { /* update */ })

// 6. Shared Space
const space = qr.space('@' + spaceId)
await space.put('items/' + ts16() + '-' + uuid(), { text: 'Hello' })
const off = space.on('items/**', (qubit) => renderItem(qubit))

// 7. Inbox
qr.inbox(data => { if (data.type === 'invite') acceptInvite(data) })

// 8. Direkte Nachricht (Einladung etc.)
await qr.send(peerPub, { type: 'my.invite', spaceId })
```
