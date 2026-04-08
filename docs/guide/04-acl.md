# 04 — Access Control (ACL)

QuRay enforces write permissions **cryptographically** — not just at the API level.
The `AccessControlPlugin` checks every QuBit on both the OUT (write) and IN (receive) pipelines.

---

## The ACL Format

A space's access control list is stored at `@{uuid}/~acl` as a JSON object:

```ts
interface SpaceACL {
  owner:   string           // pub64 — the space creator (always may write)
  writers: '*' | string[]   // '*' = open | [pub64,...] = whitelist | missing = owner-only
}
```

| `writers` value | Who can write (besides owner) |
|-----------------|-------------------------------|
| `'*'` | Any authenticated peer (open space) |
| `[pub1, pub2, ...]` | Only the listed public keys |
| _absent / empty_ | Nobody except the owner |

---

## Write Rules per Key Pattern

The `AccessControlPlugin` applies these rules in order:

| Key Pattern | Rule |
|-------------|------|
| `~{pub}/...` | **Owner-only**: only the peer with matching `pub` may write |
| `>{pub}/...` | **Relay-only**: peer-to-peer writes are rejected |
| `@{uuid}/~acl` | **Owner-only**: only the current ACL owner may change the ACL |
| `@{uuid}/~meta` | **Any authenticated**: any peer with a valid signature |
| `@{uuid}/...` (other) | **ACL-governed**: owner OR whitelisted writers |
| `sys/`, `conf/`, `blobs/` | **Local-only**: no remote enforcement, device writes only |

---

## Enforcement Flow

Every QuBit flows through the pipeline twice: once when you write it (OUT), once when peers receive it (IN).

### OUT pipeline (your own write)

```
db.put('@room/msg/001', { text: 'Hello' })
     ↓
ACCESS_OUT (priority 76)
  ├─ Read @room/~acl from local DB
  ├─ Is qr.me.pub in writers OR owner?
  │    Yes → continue
  │    No  → throw AccessDeniedError
     ↓
SIGN (priority 70) — sign with your private key
     ↓
STORE_OUT (priority 60) — save locally
     ↓
SYNC_OUT (priority 5) — queue for relay
```

### IN pipeline (remote QuBit arriving)

```
Relay delivers QuBit from peer Alice
     ↓
VERIFY (priority 80)
  ├─ Verify Alice's ECDSA signature
  │    Invalid sig → reject
     ↓
ACCESS_IN (priority 79)
  ├─ Read @room/~acl from local DB
  ├─ Is Alice's pub in writers OR owner?
  │    No → reject (drop the QuBit)
     ↓
STORE_IN (priority 60) — persist to IndexedDB
     ↓
DISPATCH_IN (priority 50) — fire db.on() listeners
```

> **Even if a malicious peer bypasses the OUT check, the IN check on every recipient's
> device will reject the write.** ACLs are enforced everywhere, not just at the relay.

---

## ACL Examples

### 1 — Owner-only space

Only the creator can write. Useful for personal published data, solo blogs.

```js
const spaceId = crypto.randomUUID()

await qr.db.put(`@${spaceId}/~acl`, {
  owner:   qr.me.pub,
  writers: [qr.me.pub],  // only the owner
})

// Alice (owner) can write
await qr.db.put(`@${spaceId}/posts/intro`, { title: 'Hello World' })

// Bob cannot write (will be rejected)
// await bobDb.put(`@${spaceId}/posts/other`, { ... })  // ← throws
```

### 2 — Open space (anyone can write)

Anyone with a valid identity can contribute. Useful for public boards, anonymous feeds.

```js
await qr.db.put(`@${spaceId}/~acl`, {
  owner:   qr.me.pub,
  writers: '*',   // open to all authenticated peers
})

// Any peer can write
await aliceDb.put(`@${spaceId}/items/1`, { text: 'Alice wrote this' })
await bobDb.put(`@${spaceId}/items/2`,   { text: 'Bob wrote this' })
```

### 3 — Team whitelist

Only named members can write. Useful for team workspaces, closed communities.

```js
await qr.db.put(`@${spaceId}/~acl`, {
  owner:   qr.me.pub,
  writers: [qr.me.pub, alicePub, bobPub],
})

// Alice and Bob can write — Charlie cannot
await aliceDb.put(`@${spaceId}/todos/1`, { title: 'Alice task' })  // ✓
await charlieDb.put(`@${spaceId}/todos/2`, { title: '...' })       // ✗ rejected
```

### 4 — Moderator-controlled space

Owner can write everywhere; other members write to specific subkeys only.

```js
// ACL: open writing for members
await qr.db.put(`@${spaceId}/~acl`, {
  owner:   moderatorPub,
  writers: [moderatorPub, alice, bob, charlie],
})

// Members write to their own namespaces
await aliceDb.put(`@${spaceId}/content/alice/post-1`, { ... })
await bobDb.put(`@${spaceId}/content/bob/post-1`,     { ... })

// Owner controls the pinned top-level keys
await modDb.put(`@${spaceId}/pinned`, { postKey: `@${spaceId}/content/alice/post-1` })
```

*(Note: The framework doesn't enforce sub-key write rules — that's application logic.
Use signed timestamps + the `from` field on QuBits to know who wrote what.)*

---

## Modifying an ACL

**Only the current owner can modify the ACL.** The `owner` field cannot be changed
by anyone other than the existing owner.

### Add a writer

```js
// Read current ACL
const aclQ = await qr.db.get(`@${spaceId}/~acl`)
const acl = aclQ.data

// Add Charlie to the writers list
await qr.db.put(`@${spaceId}/~acl`, {
  ...acl,
  writers: [...(Array.isArray(acl.writers) ? acl.writers : []), charliePub],
})
```

### Remove a writer

```js
const aclQ = await qr.db.get(`@${spaceId}/~acl`)
const acl = aclQ.data

await qr.db.put(`@${spaceId}/~acl`, {
  ...acl,
  writers: Array.isArray(acl.writers)
    ? acl.writers.filter(p => p !== charliePub)
    : acl.writers,
})
```

### Change from open to whitelist

```js
const aclQ = await qr.db.get(`@${spaceId}/~acl`)

await qr.db.put(`@${spaceId}/~acl`, {
  owner:   aclQ.data.owner,
  writers: [aclQ.data.owner, alicePub],  // now restricted
})
```

### Transfer ownership

```js
const aclQ = await qr.db.get(`@${spaceId}/~acl`)

// Only the current owner can do this
await qr.db.put(`@${spaceId}/~acl`, {
  owner:   newOwnerPub,              // ← transfer ownership
  writers: aclQ.data.writers,       // ← preserve writers
})
```

---

## Programmatic ACL Check

Before writing, you can check permissions programmatically:

```js
const space = qr.space('@' + spaceId)

const canWrite = await space.can(qr.me.pub, 'write')

if (canWrite) {
  await space.put('todos/new', { title: 'New task' })
} else {
  showError('You do not have write access to this space.')
}
```

Or read the ACL directly:

```js
const aclQ = await qr.db.get(`@${spaceId}/~acl`)
const { owner, writers } = aclQ?.data ?? {}

const isMine     = owner === qr.me.pub
const isWriter   = Array.isArray(writers)
  ? writers.includes(qr.me.pub)
  : writers === '*'
const canWrite   = isMine || isWriter

console.log({ isMine, isWriter, canWrite })
```

---

## ACL + Reactive UI

Show/hide controls based on ACL:

```js
const space = qr.space('@' + spaceId)

// Initial check
const canWrite = await space.can(qr.me.pub, 'write')
writeControls.hidden = !canWrite

// React to ACL changes (e.g. if owner revokes access)
qr.db.on(`@${spaceId}/~acl`, async () => {
  const canNow = await space.can(qr.me.pub, 'write')
  writeControls.hidden = !canNow
})
```

---

## Advanced: Manual Plugin Composition with ACL

When composing QuDB manually (e.g. in tests), include the `AccessControlPlugin`:

```js
import { QuDB } from './src/core/db.js'
import { MemoryBackend } from './src/backends/memory.js'
import { Identity } from './src/core/identity.js'
import { SignPlugin } from './src/plugins/sign.js'
import { VerifyPlugin } from './src/plugins/verify.js'
import { AccessControlPlugin } from './src/plugins/access.js'
import { StoreOutPlugin, StoreInPlugin } from './src/plugins/store.js'
import { DispatchPlugin } from './src/plugins/dispatch.js'

const identity = await Identity({ alias: 'Alice' })
const db = QuDB({ identity, backends: { /* ... */ } })

db.use(SignPlugin(identity))
db.use(VerifyPlugin(identity))
db.use(AccessControlPlugin())     // ← ACL enforcement
db.use(StoreOutPlugin())
db.use(StoreInPlugin())
db.use(DispatchPlugin())

await db.init()

// Now ACL rules are enforced
await db.put(`@${spaceId}/~acl`, { owner: identity.pub, writers: '*' })
```

---

## Security Model Summary

| Threat | Mitigation |
|--------|------------|
| Peer writes to another user's `~pub/` | Rejected by ACCESS_IN (key prefix check) |
| Peer writes to a restricted space | Rejected by ACCESS_IN (ACL whitelist check) |
| Peer sends invalid/forged signature | Rejected by VERIFY (ECDSA verification) |
| Peer modifies another user's ACL | Rejected by ACCESS_IN (owner-only rule) |
| Relay delivers unsigned QuBits | Rejected by VERIFY on each recipient |
| Replay attacks | Each QuBit has a unique `id` + `ts`; storage overwrite is monotone |

> The relay is treated as **untrusted** — it routes data but cannot forge writes.

---

## Next: API Reference →

Continue to [05 — API Reference](./05-api-reference.md) for the complete JavaScript API documentation.
