# Framework Core Contract

This document defines the intended long-lived boundaries of the framework.
It is meant as the main reference for core work before demos and higher-level UX.

## Design goals

- Keep **QuDB**, **QuNet**, **QuSync**, and **QuUI** independently maintainable.
- Keep the public API consistent across data, blobs, delivery state, and listeners.
- Keep development builds readable and debuggable.
- Keep production builds small and modular so unused transports, relay helpers,
  and storage adapters do not have to ship together.

## Module boundaries

### QuDB

QuDB is the local source of truth.

Responsibilities:
- mounted storage backends
- local reads and writes
- local query execution
- local event emission
- delivery state tracking
- blob status tracking
- middleware for incoming and outgoing writes

QuDB must not know about:
- transport selection
- relay routing
- remote subscription policy

### QuNet

QuNet is the transport runtime.

Responsibilities:
- transport registration
- endpoint registration
- transport lifecycle
- capability-based routing
- unified incoming message/state events

QuNet must not know about:
- database writes
- conflict resolution
- sync policy

### QuSync

QuSync connects QuDB with QuNet.

Responsibilities:
- explicit remote subscriptions
- snapshot pulls
- live sync fan-out
- relay/replica interaction
- reconnect recovery
- blob transfer scheduling

QuSync must not patch QuDB listener semantics.
Remote sync must always be explicit through `sync.subscribe()`, `sync.observe()`,
`sync.pull()`, and future sync-specific APIs.

### QuUI

QuUI depends on stable reactive contracts only.

Responsibilities:
- bind to data and status APIs
- render and update
- remain optional

QuUI must not know about relay internals or transport-specific behavior.

## API shape

The preferred framework shape is:

```js
const qr = await QuRay.init(...)

qr.db
qr.net
qr.sync
qr.ui
qr.me
qr.peers
```

## Unified event contract

Reactive subscriptions should follow one family of rules:

```js
const off = db.on(keyOrPattern, callback, {
  scope: 'data' | 'blob' | 'delivery',
  once: false,
  immediate: true,
})
```

Callback contract:

```js
(entry, meta) => {
  meta.scope
  meta.event
  meta.key
  meta.current
  meta.previous
  meta.value
  meta.oldValue
  meta.source
}
```

Guidelines:
- Always return an `off()` cleanup function.
- Keep wildcard semantics stable.
- Preserve `previous`/`oldValue` where practical.
- Do not overload `db.on()` with implicit network behavior.

## Data model guidelines

The framework should treat all payloads as data first.
Different persistence and transport behavior is a policy layer.

Examples:
- app records and messages
- temporary signaling data
- blob metadata QuBits
- delivery state entries

Binary blob bytes may live in dedicated storage, but blob metadata and blob state
should still fit the same reactive and observable model.

## Replica and relay model

A relay is a peer-accessible endpoint that can also expose replica storage.

Recommended interpretation:
- relay connectivity is provided through a transport
- the relay itself behaves like a peer endpoint
- replica storage is optional but first-class
- replica data enables restore after local deletion or device migration

## Build targets

Supported build tiers should stay modular:

- `quray-core` — local DB + identity + storage helpers
- `quray-sync` — core + sync + transports + relay helpers, no UI
- `quray` — full bundle

Guideline:
- adding a feature should not force every production build to include it
- plugin and transport boundaries should remain tree-shakable at the source level
  even if the current build pipeline is bundle-first
