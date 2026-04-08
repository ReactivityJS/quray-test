# 03 — Spaces

Spaces are **shared data containers** — the primary mechanism for multiple users to
collaborate. A space has a unique ID, optional metadata, and an ACL that controls
who can write.

---

## What is a Space?

A **space** (`@{uuid}/`) is a region of the database that multiple users can read
and write (subject to the ACL). Think of a space as a **shared folder** with
fine-grained access control.

```
@{uuid}/~acl               ACL — owner + writer list (who can write)
@{uuid}/~meta              Metadata — name, description, created date
@{uuid}/members/{pub64}    Membership markers
@{uuid}/chat/{ts16}-{id}   Example: chat messages
@{uuid}/todos/{ts16}-{id}  Example: to-do items
@{uuid}/files/{hash}       Example: file references
@{uuid}/settings           Example: space-level settings
@{uuid}/anything/...       Any subkey structure you define
```

**Spaces sync to all peers who are subscribed to them via the relay.**

---

## Creating a Space

Every space starts with an **ACL write** — this establishes the owner and access rules.

### Simple: Open space (anyone can write)

```js
const spaceId = crypto.randomUUID()

await qr.db.put(`@${spaceId}/~acl`, {
  owner:   qr.me.pub,
  writers: '*',         // any authenticated peer can write
})

await qr.db.put(`@${spaceId}/~meta`, {
  name:    'Public Board',
  created: Date.now(),
})
```

### Simple: Private space (only owner can write)

```js
const spaceId = crypto.randomUUID()

await qr.db.put(`@${spaceId}/~acl`, {
  owner:   qr.me.pub,
  writers: [qr.me.pub],  // only owner
})
```

### Complex: Team space with co-authors

```js
import { KEY } from './src/core/qubit.js'

const spaceId = crypto.randomUUID()

// Set ACL with specific writers
await qr.db.put(KEY.space(spaceId).acl, {
  owner:   qr.me.pub,
  writers: [qr.me.pub, alicePub, bobPub],
})

// Set metadata
await qr.db.put(KEY.space(spaceId).meta, {
  name:        'Project Alpha',
  description: 'Team workspace for Q1',
  type:        'workspace',
  created:     Date.now(),
})

// Write initial data
await qr.db.put(KEY.space(spaceId).field('settings'), {
  color: '#4f46e5',
  icon:  '🚀',
  lang:  'en',
})
```

---

## Space API

QuRay provides a high-level space API via `qr.space(id)`:

```js
const space = qr.space('@' + spaceId)

// Read a single key
const settings = await space.get('settings')
console.log(settings?.data)   // { color, icon, lang }

// Query all items in a prefix
const todos = await space.query('todos/', { order: 'ts', limit: 50 })

// Write
await space.put('todos/' + KEY.ts16(), {
  title: 'Write docs',
  done:  false,
})

// Delete
await space.del('todos/old-id')

// Check ACL
const canWrite = await space.can(qr.me.pub, 'write')

// Reactive — fires on local writes AND incoming sync
const off = space.on('todos/**', (q, { event }) => {
  if (event === 'put') renderTodo(q)
  if (event === 'del') removeTodo(q.key)
})
```

---

## Working Directly with QuDB

You can also use `qr.db` directly (more explicit control):

```js
// Write
await qr.db.put(`@${spaceId}/chat/${KEY.ts16()}-${KEY.id()}`, {
  text: 'Hello, team!',
  from: qr.me.pub,
})

// Read
const q = await qr.db.get(`@${spaceId}/settings`)

// Query
const messages = await qr.db.query(`@${spaceId}/chat/`, {
  order: 'ts',
  limit: 100,
})

// React
const off = qr.db.on(`@${spaceId}/**`, (q, meta) => {
  console.log(meta.event, q?.key)
})
```

---

## Membership

Membership is tracked by writing a marker to `@{uuid}/members/{pub64}`:

```js
// Via space API
await space.members.add(peer)           // peer = RemotePeer instance
await space.members.remove(alicePub)
const members = await space.members.list()  // → QuBit[]

// Or directly via QuDB
await qr.db.put(`@${spaceId}/members/${alicePub}`, {
  joinedAt: Date.now(),
  role: 'writer',
})

// Check membership
const isMember = await qr.db.get(`@${spaceId}/members/${alicePub}`)
```

---

## Inbox: `>{pub64}/`

The **inbox** is a special relay-managed space for one-to-one messages.
The relay writes messages here on behalf of the sender.

### Send a direct message

```js
import { KEY } from './src/core/qubit.js'

const recipientPub = '...'
const msgKey = `>${recipientPub}/${KEY.ts16()}-${KEY.id()}`

await qr.db.put(msgKey, {
  type: 'dm',
  text: 'Hey, want to join my space?',
  from: qr.me.pub,
  ts:   Date.now(),
})
```

### Listen to your inbox

```js
qr.db.on(`>${qr.me.pub}/**`, (q, { event }) => {
  if (event !== 'put') return
  const msg = q.data

  if (msg.type === 'dm')     showDirectMessage(msg)
  if (msg.type === 'invite') showSpaceInvitation(msg)
})
```

### Space invitation via inbox

```js
// Alice invites Bob to her space
await qr.db.put(`>${bobPub}/${KEY.ts16()}-invite`, {
  type:    'invite',
  spaceId: mySpaceId,
  from:    qr.me.pub,
  message: 'Join our project space!',
})

// Bob accepts (subscribes to the space)
qr.db.on(`>${qr.me.pub}/**`, async (q) => {
  if (q?.data?.type !== 'invite') return

  const { spaceId, from } = q.data
  // Subscribe to the space
  await qr._.sync.subscribe(`@${spaceId}/`, { live: true, snapshot: true })
  // Add self to members
  await qr.db.put(`@${spaceId}/members/${qr.me.pub}`, { joinedAt: Date.now() })
})
```

---

## Subscribing to a Space (Remote Sync)

Locally writing to a space is immediate. To receive writes from other peers, subscribe via `QuSync`:

```js
// One-time snapshot: pull all current data
await qr._.sync.syncIn(`@${spaceId}/`)

// Live subscription: receive updates in real time
const off = await qr._.sync.subscribe(`@${spaceId}/`, {
  live:     true,      // stay subscribed
  snapshot: true,      // also pull existing data
})

// Combined (recommended): local listener + remote subscription
const off = await qr._.sync.observe(`@${spaceId}/chat/**`, (q, meta) => {
  if (meta.event === 'put') addMessage(q)
  if (meta.event === 'del') removeMessage(q.key)
})
```

### Initial render + live updates

```js
// Pull existing items AND set up live listener
const { off, rows } = await qr._.sync.pull(
  `@${spaceId}/todos/`,
  (q, meta) => updateTodo(q, meta),   // called for future changes
)

// `rows` contains the current snapshot
rows.forEach(renderTodo)
```

---

## Space Examples

### Example 1 — Chat Room

```js
const roomId = crypto.randomUUID()

// Create open chat room
await qr.db.put(KEY.space(roomId).acl, { owner: qr.me.pub, writers: '*' })
await qr.db.put(KEY.space(roomId).meta, { name: 'General', type: 'chat' })

// Post a message
async function sendMessage(text) {
  await qr.db.put(KEY.space(roomId).entry('chat', KEY.id()), {
    text,
    from: qr.me.pub,
    ts:   Date.now(),
  })
}

// Listen and render
const { off, rows } = await qr._.sync.pull(
  `@${roomId}/chat/`,
  (q, { event }) => {
    if (event === 'put') appendMessage(q.data)
    if (event === 'del') removeMessage(q.key)
  }
)
rows.forEach(q => appendMessage(q.data))
```

### Example 2 — Shared Task Board

```js
const boardId = crypto.randomUUID()

// Board with specific team members
await qr.db.put(KEY.space(boardId).acl, {
  owner:   qr.me.pub,
  writers: [qr.me.pub, alicePub, bobPub],
})

// Create a task
async function createTask(title, assignee) {
  const taskId = KEY.id()
  await qr.db.put(`@${boardId}/tasks/${taskId}`, {
    title,
    assignee,
    done:      false,
    createdAt: Date.now(),
    createdBy: qr.me.pub,
  })
  return taskId
}

// Toggle task done
async function toggleTask(taskId) {
  const q = await qr.db.get(`@${boardId}/tasks/${taskId}`)
  await qr.db.put(`@${boardId}/tasks/${taskId}`, {
    ...q.data,
    done:     !q.data.done,
    updatedAt: Date.now(),
    updatedBy: qr.me.pub,
  })
}

// Reactive list
const taskMap = new Map()
const { off, rows } = await qr._.sync.pull(`@${boardId}/tasks/`, (q, { event }) => {
  if (event === 'put') taskMap.set(q.key, q.data)
  if (event === 'del') taskMap.delete(q.key)
  renderBoard(taskMap)
})
rows.forEach(q => taskMap.set(q.key, q.data))
renderBoard(taskMap)
```

### Example 3 — Multi-Space Application

```js
// User can be a member of multiple spaces
const mySpaces = await qr.db.query('conf/myspaces/')

// Load all subscribed spaces
for (const q of mySpaces) {
  const spaceId = q.data.id
  const { off, rows } = await qr._.sync.pull(`@${spaceId}/`, updateSpace)
  rows.forEach(q => updateSpace(q, { event: 'put' }))
}

// Add a new space
async function joinSpace(spaceId, spaceName) {
  // Subscribe to updates
  await qr._.sync.subscribe(`@${spaceId}/`, { live: true, snapshot: true })

  // Remember locally (conf/ = device-local, never synced)
  await qr.db.put(`conf/myspaces/${spaceId}`, {
    id:       spaceId,
    name:     spaceName,
    joinedAt: Date.now(),
  })
}
```

---

## Next: Access Control →

Continue to [04 — Access Control (ACL)](./04-acl.md) to learn exactly how write
permissions are enforced and how to configure them.
