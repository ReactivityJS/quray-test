# Remote Query

`sync.remoteQuery(prefix, options)` — Daten direkt vom Relay abrufen, ohne sie in die lokale QuDB zu schreiben.

---

## Konzept

Eine normale `db.query()` liest aus dem **lokalen** Backend (IDB, Memory, …). Eine `remoteQuery` sendet eine Anfrage an einen verbundenen Relay-Peer und liefert die Antwort direkt zurück — ohne dabei den lokalen DB-Zustand zu verändern (es sei denn, du willst das explizit).

```
Client                 Relay
  │                      │
  │── DB_SUB (snapshot) →│
  │                      │ (antwortet mit Snapshot)
  │←── DB_RES ──────────│
  │                      │
  ✓ Ergebnis-Array       ✓ Keine lokale DB-Mutation (Standard)
```

---

## API

```js
const rows = await qr.remoteQuery(prefix, options)
// oder direkt:
const rows = await qr._.sync.remoteQuery(prefix, options)
```

### Parameter

| Option | Typ | Default | Beschreibung |
|--------|-----|---------|--------------|
| `order` | `'ts'` \| `'ts-desc'` \| `'key'` \| `'data.order'` | `'ts'` | Sortierung — identisch mit `db.query()` |
| `limit` | `number` | — | Maximale Anzahl Ergebnisse |
| `filter` | `(qubit) => boolean` | — | Clientseitiger Filter-Callback |
| `since` | `number` | — | Nur QuBits mit `ts > since` |
| `includeDeleted` | `boolean` | `false` | Gelöschte QuBits mitliefern |
| `sync` | `boolean` | `false` | `true` → Ergebnisse laufen durch den normalen IN-Pipeline (VerifyPlugin → StoreIn → `db.on` feuert). Verhält sich dann wie ein manueller diffSync für diesen Prefix. |
| `targetMount` | `{ prefix: string, backend?: BackendAdapter }` | — | Ergebnisse in einem neuen DB-Mount ablegen (s.u.) |
| `persist` | `'none'` \| `'session'` \| `'reload'` | `'none'` | Query-Intent-Persistenz (s.u.) |
| `peerId` | `string` | — | Welchen Relay-Peer befragen (default: primärer Relay) |
| `timeout` | `number` | `15000` | Timeout in ms |

### Rückgabe

`Promise<QuBit[]>` — gefiltertes, sortiertes Array von QuBits.

---

## Drei Modi

### 1 · Nur lesen (Standard)

Ergebnisse werden **nicht** in die lokale DB geschrieben. Ideal für UI-Anzeigen, die keine Persistenz brauchen.

```js
const people = await qr.remoteQuery('@users/', {
  order:  'ts-desc',
  limit:  50,
  filter: q => q.data?.active !== false,
})
// people ist ein Array von QuBits — lokale DB unverändert
renderList(people)
```

### 2 · targetMount — Schreibziel definieren

Ergebnisse landen in einem neuen DB-Mount mit eigenem (standardmäßig Memory-) Backend. Danach mit `db.query()` lesbar und reaktiv per `db.on()`.

```js
// Einmalig aufrufen — richtet Mount ein + befüllt ihn
await qr.remoteQuery('@users/', {
  targetMount: { prefix: 'sys/remote/people/' },
  // optional: anderes Backend
  // targetMount: { prefix: 'sys/remote/people/', backend: SessionStorageBackend() }
})

// Ab sofort wie normale lokale Query nutzbar:
const people = await qr.db.query('sys/remote/people/', { order: 'ts-desc' })

// Reaktiv:
qr.db.on('sys/remote/people/**', (q) => updatePersonCard(q))
```

**Key-Mapping:** Die Ergebnis-Keys werden unter den `targetMount.prefix` re-gekeyt.  
`@users/alice123` mit `prefix = '@users/'` → `sys/remote/people/alice123`

### 3 · Normaler DB-Sync (`sync: true`)

Entspricht einem manuellen `diffSync` für einen bestimmten Prefix. Daten laufen durch den IN-Pipeline (VerifyPlugin, StoreIn, Dispatch) und werden dauerhaft in der lokalen DB gespeichert.

```js
// Fehlende Todos vom Relay holen und persistent speichern:
await qr.remoteQuery('@space/todos/', { sync: true })
// Danach normal abrufbar:
const todos = await qr.db.query('@space/todos/')
```

---

## Query-Intent-Persistenz (`persist`)

Die **in-flight Map** (`_pendingQueryRequests`) hält immer Promise-Callbacks im Speicher — das ist nicht konfigurierbar und ein JavaScript-Grundprinzip.

Unabhängig davon kann der **Query-Intent** (Prefix + Optionen + Status) persistent gespeichert werden, damit er bei Verbindungsabbruch oder Page-Reload neu gestartet wird:

| `persist` | Speicherort | Verhalten |
|-----------|-------------|-----------|
| `'none'` | nur in-flight Map | Kein Overhead. Verloren bei Verbindungsabbruch. |
| `'session'` | `sys/rq/{id}` (MemoryBackend) | Überlebt WS-Reconnect, verloren bei Page-Reload. |
| `'reload'` | `conf/rq/{id}` (LocalStorageBackend) | Überlebt Page-Reload. Wird automatisch re-gefeuert beim nächsten Connect. |

```js
// Wird bei Reconnect (selber Tab) automatisch neu gestartet:
await qr.remoteQuery('@users/', {
  targetMount: { prefix: 'sys/remote/people/' },
  persist: 'session',
})

// Wird auch nach Page-Reload beim nächsten Connect neu gestartet:
await qr.remoteQuery('@space/todos/', {
  sync:    true,
  persist: 'reload',
})
```

### Status-Updates via `db.on()`

Für `persist: 'session'` und `persist: 'reload'` schreibt QuSync den Query-Status in QuDB und du kannst darauf reagieren:

```js
qr.db.on('sys/rq/**', (q) => {
  const { status, prefix, count } = q.data
  if (status === 'done')    console.log(`Query "${prefix}" fertig — ${count} Zeilen`)
  if (status === 'error')   console.error(`Query "${prefix}" Fehler:`, q.data.error)
  if (status === 'pending') console.info(`Query "${prefix}" läuft…`)
})
```

---

## Reconnect-Verhalten

```
Page-Load
   │
   ├─ QuSync.init()
   │     └─ _registerConnectHook()
   │
   ├─ Relay verbindet
   │     └─ (nach 800ms)
   │           ├─ syncIn()
   │           ├─ subscribe() für aktive Prefixes
   │           ├─ re-fire sys/rq/  pending (persist:'session')
   │           └─ re-fire conf/rq/ pending (persist:'reload')
   │
   └─ remoteQuery Ergebnisse landen im targetMount → db.on() feuert
```

---

## Performance

- **None (Standard):** Null Overhead — reine In-Memory-Verarbeitung.
- **Session (`sys/`):** MemoryBackend-Write, ~0ms.
- **Reload (`conf/`):** LocalStorageBackend-Write, ~1–3ms pro Entry.

`remoteQuery` ist netzwerkgebunden (typisch 10–200ms), sodass der Persistenz-Overhead irrelevant ist.

---

## Vollständiges Beispiel — People-Liste

```js
// 1. Einmalig beim App-Start (oder nach Relay-Connect):
const offStatus = qr.db.on('sys/rq/**', (q) => {
  if (q.data.prefix === '~' && q.data.status === 'done') {
    renderPeopleList()
  }
})

// 2. Query abfeuern (targetMount + persist für Reconnect-Resilienz):
await qr.remoteQuery('~', {
  order:       'ts-desc',
  limit:       100,
  filter:      q => q.data?.alias,          // nur User mit Alias
  targetMount: { prefix: 'sys/remote/people/' },
  persist:     'session',
})

// 3. Ergebnis lesen und reaktiv halten:
async function renderPeopleList() {
  const people = await qr.db.query('sys/remote/people/', { order: 'ts-desc' })
  document.getElementById('people').innerHTML = people
    .map(q => `<div>${q.data.alias ?? '?'} — ${q.key}</div>`)
    .join('')
}

// 4. Reaktive Updates (z.B. bei erneutem remoteQuery-Call):
qr.db.on('sys/remote/people/**', renderPeopleList)
await renderPeopleList()
```
