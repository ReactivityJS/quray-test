# QuRay Developer Guide

Welcome to the QuRay Developer Guide. This guide is structured from the ground up:
starting with the fundamental building blocks and progressively building toward
more advanced use cases.

## Contents

| # | Topic | Description |
|---|-------|-------------|
| [01](./01-concepts.md) | **Core Concepts** | Key schema, QuBit format, pipeline, mounts |
| [02](./02-users.md) | **Users & Identity** | Creating users, user spaces, profiles, crypto |
| [03](./03-spaces.md) | **Spaces** | Shared spaces, membership, inbox |
| [04](./04-acl.md) | **Access Control (ACL)** | Who can write what, enforcement rules |
| [05](./05-api-reference.md) | **API Reference** | Full JS API for QuDB, QuSync, KEY helpers |
| [06](./06-ui.md) | **UI Components** | Native bindings, custom elements, directives |
| [07](./07-examples.md) | **Complete Examples** | Chat, task board, DMs, blog |

---

## Quick Start

```js
import QuRay from './src/quray.js'

// 1. Initialize (creates or restores a cryptographic identity)
const qr = await QuRay.init({
  relay: 'wss://relay.example.com',
  alias: 'Alice',
  ui: true,       // register <qu-*> custom elements
})

// 2. Write data — signed, stored locally, synced in background
await qr.db.put('~/note', { text: 'Hello!' })

// 3. React to changes — fires on local writes AND incoming sync
qr.db.on('~/note', (q) => console.log(q?.data.text))

// 4. Create a shared space
const spaceId = crypto.randomUUID()
await qr.db.put(`@${spaceId}/~acl`, {
  owner: qr.me.pub,
  writers: '*',          // anyone can write
})
```

---

## Key Principles

- **Everything is a QuBit** — atomic, signed, JSON value
- **All data flows through QuDB** — one API for local and remote changes
- **Offline-first** — writes persist locally; sync happens in background
- **Cryptographic** — every QuBit is ECDSA-signed; E2E encryption available
- **Modular** — core is small; features come via plugins

---

## HTML Documentation

Open [`../index.html`](../index.html) in a browser (when served by the relay or any HTTP server)
for a fully navigable HTML version of this documentation with syntax highlighting.

```bash
# Serve docs with the built-in relay
node relay.js
# then open http://localhost:8080/docs/index.html
```
