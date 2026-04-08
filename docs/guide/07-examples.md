# 07 — Complete Examples

Full application walkthroughs combining users, spaces, ACLs, sync, and UI.

---

## Example 1 — Chat App (Simple)

A minimal real-time group chat in a single HTML file.

### Features
- Open space (anyone can join and post)
- Live message list via `<qu-list>`
- Typing indicator via QuPresence

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QuRay Chat</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 2rem auto; }
    .messages { height: 400px; overflow-y: auto; border: 1px solid #ddd; padding: 1rem; }
    .message  { margin: .5rem 0; }
    form      { display: flex; gap: .5rem; margin-top: 1rem; }
    input     { flex: 1; padding: .5rem; }
  </style>
</head>
<body>

<h1>QuRay Chat — <span qu-key="~/alias"></span></h1>
<p>Room: <code id="room-id"></code></p>

<div class="messages">
  <qu-list id="msg-list" order="ts">
    <template>
      <div class="message">
        <strong data-qu-bind="data.alias"></strong>:
        <span data-qu-bind="data.text"></span>
        <small data-qu-bind="ts" data-qu-format="rel-time"></small>
      </div>
    </template>
  </qu-list>
</div>

<form id="compose">
  <input id="msg" type="text" placeholder="Type a message…" autocomplete="off">
  <button type="submit">Send</button>
</form>

<script type="module">
  import QuRay from './src/quray.js'
  import { KEY } from './src/core/qubit.js'

  const qr = await QuRay.init({
    relay:   'wss://relay.example.com',
    alias:   'User-' + Math.random().toString(36).slice(2, 6),
    ui:      true,
    binding: true,
  })

  // Use a fixed room ID (or generate one and share via URL)
  const roomId = new URLSearchParams(location.search).get('room')
    ?? crypto.randomUUID()
  document.getElementById('room-id').textContent = roomId
  history.replaceState({}, '', '?room=' + roomId)

  // Create the room ACL if it doesn't exist yet
  const existing = await qr.db.get(`@${roomId}/~acl`)
  if (!existing) {
    await qr.db.put(`@${roomId}/~acl`, {
      owner:   qr.me.pub,
      writers: '*',          // open to all
    })
    await qr.db.put(`@${roomId}/~meta`, { name: 'Chat Room', created: Date.now() })
  }

  // Point the list at the right prefix
  document.getElementById('msg-list').setAttribute('prefix', `@${roomId}/chat/`)

  // Subscribe to live updates
  await qr._.sync.subscribe(`@${roomId}/chat/`, { live: true, snapshot: true })

  // Send
  document.getElementById('compose').addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = document.getElementById('msg').value.trim()
    if (!text) return
    await qr.db.put(KEY.space(roomId).entry('chat', KEY.id()), {
      text,
      alias: qr.me.alias,
      from:  qr.me.pub,
    })
    document.getElementById('msg').value = ''
  })
</script>
</body>
</html>
```

---

## Example 2 — Collaborative Task Board (Complex)

A multi-user Kanban board with ACL-controlled write access, live sync, and reactive UI.

### Features
- Private board with invited members only
- Tasks with status: `todo` / `in-progress` / `done`
- Drag-to-reorder via fractional `order` field
- Delivery tracking per task
- Reactive filters

```js
import QuRay from './src/quray.js'
import { KEY } from './src/core/qubit.js'

// ── Init ───────────────────────────────────────────────────────────────────
const qr = await QuRay.init({
  relay:   'wss://relay.example.com',
  alias:   localStorage.getItem('alias') ?? 'Alice',
  ui:      true,
  binding: true,
})

const BOARD_ID = localStorage.getItem('boardId') ?? crypto.randomUUID()
localStorage.setItem('boardId', BOARD_ID)

// ── Create board (first time only) ────────────────────────────────────────
async function setupBoard(memberPubs = []) {
  const existing = await qr.db.get(KEY.space(BOARD_ID).acl)
  if (existing) return   // already set up

  await qr.db.put(KEY.space(BOARD_ID).acl, {
    owner:   qr.me.pub,
    writers: [qr.me.pub, ...memberPubs],
  })
  await qr.db.put(KEY.space(BOARD_ID).meta, {
    name:    'Project Board',
    created: Date.now(),
  })
}

// ── Task CRUD ─────────────────────────────────────────────────────────────
async function createTask(title, status = 'todo') {
  const id  = KEY.id()
  const key = `@${BOARD_ID}/tasks/${id}`

  // Compute fractional order: put at end of column
  const existing = await qr.db.query(`@${BOARD_ID}/tasks/`, {
    filter: q => q.data?.status === status,
    order:  'data.order',
  })
  const maxOrder = existing.length
    ? Math.max(...existing.map(q => q.data.order ?? 0))
    : 0

  await qr.db.put(key, {
    id,
    title,
    status,
    order:     maxOrder + 1,
    createdBy: qr.me.pub,
    createdAt: Date.now(),
    assignee:  null,
  })
  return id
}

async function moveTask(taskId, newStatus) {
  const key = `@${BOARD_ID}/tasks/${taskId}`
  const q   = await qr.db.get(key)
  if (!q) return
  await qr.db.put(key, { ...q.data, status: newStatus, updatedAt: Date.now() })
}

async function assignTask(taskId, pub) {
  const key = `@${BOARD_ID}/tasks/${taskId}`
  const q   = await qr.db.get(key)
  if (!q) return
  await qr.db.put(key, { ...q.data, assignee: pub })
}

async function deleteTask(taskId) {
  await qr.db.del(`@${BOARD_ID}/tasks/${taskId}`)
}

// ── ACL: invite a new member ───────────────────────────────────────────────
async function inviteMember(newPub) {
  const aclQ = await qr.db.get(KEY.space(BOARD_ID).acl)
  if (!aclQ) return
  const { owner, writers } = aclQ.data
  if (owner !== qr.me.pub) {
    alert('Only the board owner can invite members.')
    return
  }
  const newWriters = Array.isArray(writers)
    ? [...writers, newPub]
    : [newPub]
  await qr.db.put(KEY.space(BOARD_ID).acl, { owner, writers: newWriters })

  // Send inbox invitation
  await qr.db.put(`>${newPub}/${KEY.ts16()}-invite`, {
    type:    'board-invite',
    boardId: BOARD_ID,
    from:    qr.me.pub,
    name:    (await qr.db.get(KEY.space(BOARD_ID).meta))?.data?.name,
  })
}

// ── Reactive board state ───────────────────────────────────────────────────
const taskMap = new Map()

const { off, rows } = await qr._.sync.pull(
  `@${BOARD_ID}/tasks/`,
  (q, { event }) => {
    if (event === 'put') taskMap.set(q.key, q.data)
    if (event === 'del') taskMap.delete(q.key)
    renderBoard()
  }
)
rows.forEach(q => taskMap.set(q.key, q.data))
renderBoard()

function renderBoard() {
  const columns = ['todo', 'in-progress', 'done']
  for (const col of columns) {
    const tasks = [...taskMap.values()]
      .filter(t => t.status === col)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    document.getElementById(`col-${col}`).innerHTML = tasks
      .map(t => `
        <div class="task-card" data-id="${t.id}">
          <p>${t.title}</p>
          ${t.assignee ? `<qu-avatar pub="${t.assignee}" size="24"></qu-avatar>` : ''}
          <div class="actions">
            ${col !== 'done' ? `<button onclick="moveTask('${t.id}', 'done')">✓</button>` : ''}
            <button onclick="deleteTask('${t.id}')">✕</button>
          </div>
        </div>
      `).join('')
  }
}
```

```html
<!-- Board HTML -->
<div class="kanban">
  <div class="column">
    <h3>To Do</h3>
    <div id="col-todo"></div>
  </div>
  <div class="column">
    <h3>In Progress</h3>
    <div id="col-in-progress"></div>
  </div>
  <div class="column">
    <h3>Done</h3>
    <div id="col-done"></div>
  </div>
</div>

<form id="new-task">
  <input id="task-title" placeholder="New task title…">
  <select id="task-status">
    <option value="todo">To Do</option>
    <option value="in-progress">In Progress</option>
  </select>
  <button type="submit">Add Task</button>
</form>
```

---

## Example 3 — Encrypted Direct Messages

Peer-to-peer DMs with E2E encryption. Only sender and recipient can read.

### Features
- E2E encrypted messages via ECDH + AES-256-GCM
- Inbox routing via `>{pub}/`
- Message threads via QuDB prefix queries
- Delivery tracking

```js
import QuRay from './src/quray.js'
import { KEY } from './src/core/qubit.js'

const qr = await QuRay.init({
  relay: 'wss://relay.example.com',
  alias: 'Alice',
})

// ── Send an encrypted DM ───────────────────────────────────────────────────
async function sendDM(recipientPub, text) {
  // Look up recipient's ECDH key (must be synced from relay)
  const recipient = qr.peers.get(recipientPub)
  if (!recipient?.epub) {
    throw new Error('Recipient encryption key not yet available — try again after sync')
  }

  const msgKey = `>${recipientPub}/${KEY.ts16()}-${KEY.id()}`

  await qr.db.put(msgKey, { text, from: qr.me.pub }, {
    enc: recipient.epub,   // ← encrypts for recipient only
    type: 'dm',
  })
}

// ── Listen to own inbox ───────────────────────────────────────────────────
qr.db.on(`>${qr.me.pub}/**`, (q, { event }) => {
  if (event !== 'put') return

  // Decryption is automatic — q.data is already plaintext
  const { text, from } = q.data ?? {}

  if (q.type === 'dm') {
    showMessage({ key: q.key, text, from, ts: q.ts })
    // Mark as read
    qr.db.delivery.set(q.key, 'peer_read')
  }
})

// Subscribe to inbox updates from relay
await qr._.sync.subscribe(`>${qr.me.pub}/`, { live: true, snapshot: true })

// ── Conversation view ─────────────────────────────────────────────────────
async function loadConversation(otherPub) {
  // Messages sent to them (in their inbox, written by us)
  const sent = await qr.db.query(`>${otherPub}/`, {
    filter: q => q.from === qr.me.pub,
    order:  'ts',
  })

  // Messages received from them (in our inbox)
  const received = await qr.db.query(`>${qr.me.pub}/`, {
    filter: q => q.from === otherPub,
    order:  'ts',
  })

  // Merge and sort by timestamp
  return [...sent, ...received].sort((a, b) => a.ts - b.ts)
}

// ── Example usage ─────────────────────────────────────────────────────────
const bobPub = '...'   // obtained via peer discovery

await sendDM(bobPub, 'Hey Bob, want to collaborate?')

const thread = await loadConversation(bobPub)
for (const msg of thread) {
  const isMine = msg.from === qr.me.pub
  console.log(`${isMine ? 'Me' : 'Bob'}: ${msg.data.text}`)
}
```

---

## Example 4 — Multi-Space Dashboard

A user dashboard showing membership in multiple spaces with per-space notifications.

### Features
- Track joined spaces in `conf/` (device-local)
- Per-space unread counters
- Space discovery via inbox invitations
- Dynamic subscription management

```js
import QuRay from './src/quray.js'
import { KEY } from './src/core/qubit.js'

const qr = await QuRay.init({
  relay:   'wss://relay.example.com',
  alias:   localStorage.getItem('myAlias') ?? 'Alice',
  ui:      true,
  binding: true,
})

// ── Track joined spaces ────────────────────────────────────────────────────
async function getMySpaces() {
  const entries = await qr.db.query('conf/myspaces/')
  return entries.map(q => q.data)
}

async function joinSpace(spaceId, name) {
  // Subscribe to live updates from relay
  await qr._.sync.subscribe(`@${spaceId}/`, { live: true, snapshot: true })

  // Remember membership locally
  await qr.db.put(`conf/myspaces/${spaceId}`, {
    id:       spaceId,
    name:     name ?? spaceId,
    joinedAt: Date.now(),
    unread:   0,
  })
}

async function leaveSpace(spaceId) {
  await qr._.sync.unsubscribe(`@${spaceId}/`)
  await qr.db.del(`conf/myspaces/${spaceId}`, { hard: true })
}

// ── Unread counters per space ─────────────────────────────────────────────
const lastReadTs = {}

function trackUnread(spaceId) {
  qr.db.on(`@${spaceId}/chat/**`, async (q, { event, source }) => {
    // Only count remote (incoming) messages, not our own
    if (event !== 'put' || source !== 'sync' || q.from === qr.me.pub) return

    const spaceEntry = await qr.db.get(`conf/myspaces/${spaceId}`)
    if (!spaceEntry) return

    const current = spaceEntry.data.unread ?? 0
    await qr.db.put(`conf/myspaces/${spaceId}`, {
      ...spaceEntry.data,
      unread: current + 1,
    })
  })
}

function markAllRead(spaceId) {
  lastReadTs[spaceId] = Date.now()
  qr.db.put(`conf/myspaces/${spaceId}/unread`, 0)
}

// ── Handle inbox invitations ───────────────────────────────────────────────
qr.db.on(`>${qr.me.pub}/**`, async (q, { event }) => {
  if (event !== 'put') return
  if (q?.data?.type !== 'board-invite' && q?.data?.type !== 'space-invite') return

  const { spaceId, name, from } = q.data
  const sender = qr.peers.get(from)

  // Show UI prompt
  const accepted = confirm(
    `${sender?.alias ?? from} invited you to "${name}". Accept?`
  )
  if (!accepted) return

  await joinSpace(spaceId, name)
  trackUnread(spaceId)
})

// ── Subscribe to inbox live ────────────────────────────────────────────────
await qr._.sync.subscribe(`>${qr.me.pub}/`, { live: true })

// ── Bootstrap: re-subscribe to all known spaces ───────────────────────────
const mySpaces = await getMySpaces()
for (const space of mySpaces) {
  await qr._.sync.subscribe(`@${space.id}/`, { live: true, snapshot: true })
  trackUnread(space.id)
}

renderDashboard(mySpaces)

// ── Render ────────────────────────────────────────────────────────────────
function renderDashboard(spaces) {
  const list = document.getElementById('space-list')
  list.innerHTML = spaces.map(s => `
    <div class="space-card" data-id="${s.id}">
      <h3>${s.name}</h3>
      <span class="unread" qu-key="conf/myspaces/${s.id}" qu-format="data.unread"></span>
      <button onclick="openSpace('${s.id}')">Open</button>
      <button onclick="leaveSpace('${s.id}')">Leave</button>
    </div>
  `).join('')

  // Re-activate qu-key bindings on newly inserted HTML
  qr._.ui?.rescan?.()
}

// Watch for space-level changes (name, unread)
qr.db.on('conf/myspaces/**', async () => {
  renderDashboard(await getMySpaces())
})
```

```html
<div id="dashboard">
  <header>
    <qu-avatar pub="SELF_PUB" size="36" round></qu-avatar>
    <span qu-key="~/alias"></span>
    <qu-sync-state></qu-sync-state>
  </header>

  <section>
    <h2>My Spaces</h2>
    <div id="space-list"></div>
    <button id="create-space">+ New Space</button>
  </section>
</div>
```

---

## Example 5 — Offline-First Notes App

Single-user note-taking that works offline, syncs when connected.

```js
import QuRay from './src/quray.js'
import { KEY } from './src/core/qubit.js'

// Works fully offline — no relay required
const qr = await QuRay.init({
  relay:   navigator.onLine ? 'wss://relay.example.com' : undefined,
  alias:   'Me',
  ui:      true,
  binding: true,
})

const noteMap = new Map()

// Load all notes reactively
const off = qr.db.on('~/notes/**', (q, { event }) => {
  if (event === 'put') {
    noteMap.set(q.key, { key: q.key, ...q.data, ts: q.ts })
    renderNoteList()
  }
  if (event === 'del') {
    noteMap.delete(q.key)
    renderNoteList()
  }
}, { immediate: false })

// Seed from local IndexedDB
const existing = await qr.db.query('~/notes/', { order: 'ts-desc' })
existing.forEach(q => noteMap.set(q.key, { key: q.key, ...q.data, ts: q.ts }))
renderNoteList()

// Create note
async function newNote() {
  const id  = KEY.id()
  const key = `~/notes/${id}`
  await qr.db.put(key, { title: 'New note', body: '', id })
  openNote(key)
}

// Auto-save note (debounced)
let saveTimer
async function autoSave(key, title, body) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    await qr.db.put(key, { title, body, updatedAt: Date.now() })
  }, 500)
}

// Delete note
async function deleteNote(key) {
  await qr.db.del(key)
}

function renderNoteList() {
  const notes = [...noteMap.values()].sort((a, b) => b.ts - a.ts)
  document.getElementById('note-list').innerHTML = notes.map(n => `
    <li class="note-item" onclick="openNote('${n.key}')">
      <strong>${n.title || 'Untitled'}</strong>
      <small>${new Date(n.ts).toLocaleDateString()}</small>
      <button onclick="event.stopPropagation(); deleteNote('${n.key}')">✕</button>
    </li>
  `).join('')
}

function openNote(key) {
  qr.db.get(key).then(q => {
    if (!q) return
    document.getElementById('note-title').value = q.data.title ?? ''
    document.getElementById('note-body').value  = q.data.body  ?? ''
    document.getElementById('editor').dataset.key = key

    // Auto-save on input
    document.getElementById('note-title').oninput = (e) =>
      autoSave(key, e.target.value, document.getElementById('note-body').value)
    document.getElementById('note-body').oninput = (e) =>
      autoSave(key, document.getElementById('note-title').value, e.target.value)
  })
}
```

---

## Anti-Patterns to Avoid

### ❌ Don't build keys by string concatenation

```js
// Bad — fragile, bypasses key schema validation
const key = '~' + pub + '/alias'

// Good — use KEY helpers
const key = KEY.user(pub).alias
```

### ❌ Don't store binary data in `data`

```js
// Bad — QuBit data must be JSON-serializable
await db.put(key, { file: new Uint8Array(buffer) })

// Good — use blobs for binary content
const hash = await KEY.sha256url(buffer)
await db.blobs.put(hash, buffer, { mime: 'image/png' })
await db.put(KEY.user(myPub).blob(hash), { hash, mime: 'image/png' })
```

### ❌ Don't forget to clean up listeners

```js
// Bad — listener leaks on navigation or component destroy
db.on('~/alias', updateUI)

// Good — always save and call the off function
const off = db.on('~/alias', updateUI)
// ...
off()  // on unmount, navigation, or cleanup
```

### ❌ Don't write to `conf/` expecting it to sync

```js
// Bad — conf/ is device-local, never synced
await db.put('conf/app/sharedSetting', value)

// Good — use a space for shared data
await db.put(`@${spaceId}/settings`, value)
```

### ❌ Don't check ACL by key prefix manually

```js
// Bad — brittle, misses edge cases
if (!key.startsWith('conf/')) enqueueSync(key)

// Good — use the mount helper
import { isLocalOnly } from './src/core/mounts.js'
if (!isLocalOnly(key)) enqueueSync(key)
```

---

← Back to [06 — UI Components](./06-ui.md) | [README](./README.md)
