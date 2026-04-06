# Modular API Notes

This document describes the refactoring direction used in this package snapshot.

## Module boundaries

### QuDB
QuDB is the local runtime and source of truth for application state.

Responsibilities:
- key-value storage through mounted backends
- local queries
- local reactive listeners
- blob state tracking
- delivery state tracking
- middleware pipelines for incoming and outgoing QuBits

Non-responsibilities:
- transport selection
- replica routing
- remote subscription policy

### QuNet
QuNet manages transports and endpoints.

Responsibilities:
- transport registration
- endpoint registration
- connection lifecycle
- send routing through a chosen transport
- unified incoming `message` / `state` events

Non-responsibilities:
- database writes
- replication policy
- protocol-specific persistence rules

### QuSync
QuSync connects QuDB and QuNet.

Responsibilities:
- explicit remote subscriptions
- snapshot sync / pull
- outgoing sync queue integration
- blob transfer scheduling
- reconnect re-subscription

The key change is that QuSync no longer patches `db.on()`.
Remote replication is now explicit through:
- `sync.subscribe(prefixOrPattern, options)`
- `sync.observe(pattern, callback, options)`
- `sync.pull(prefix, options)`

### RelayPeer
The Node.js relay runtime is now split into:
- `createReplicaDb()` for persistent relay storage
- `RelayRouter()` for live routing and subscription fan-out
- `createRelayPeer()` for composing the relay runtime
- `NodeRelayTransport()` for in-process Node tests and local integration

## Unified reactive API

QuDB keeps the `on()` / `off()` style and now supports explicit scopes.

```js
const off = db.on('@room/chat/**', callback)
const offBlob = db.on('hash123', callback, { scope: 'blob' })
const offDelivery = db.on('@room/chat/001', callback, { scope: 'delivery' })
```

Callback signature:

```js
(qubitOrEntry, meta) => {
  meta.scope      // 'data' | 'blob' | 'delivery'
  meta.event
  meta.key
  meta.current
  meta.previous
  meta.value
  meta.oldValue
}
```

## Compatibility

Existing lower-level APIs remain available where possible. The goal of this
snapshot is to introduce cleaner seams while keeping the current codebase
usable and testable.
