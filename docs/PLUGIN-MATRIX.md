# Plugin and Module Matrix

This file captures the modular intent of the framework.
It is primarily a planning and packaging aid.

## Pipeline priorities

Plugins register at a numeric priority. Higher numbers run earlier in the pipeline.

| Plugin | Priority constant | Value | Pipeline |
|---|---|---|---|
| `VerifyPlugin` | `VERIFY` | 80 | IN |
| `AccessControlPlugin` | `ACCESS_IN` | 79 | IN |
| `StoreInPlugin` | `STORE_IN` | 60 | IN |
| `DispatchPlugin` | `DISPATCH_IN` | 50 | IN |
| `AccessControlPlugin` | `ACCESS_OUT` | 76 | OUT |
| `E2EPlugin` | `E2E` | 75 | OUT |
| `SignPlugin` | `SIGN` | 70 | OUT |
| `StoreOutPlugin` | `STORE_OUT` | 60 | OUT |
| `DispatchPlugin` | `DISPATCH_OUT` | 49 | OUT |
| `SyncPlugin` | `SYNC_OUT` | 5 | OUT |

Pipeline execution order (IN): VERIFY → ACCESS_IN → STORE_IN → DISPATCH_IN
Pipeline execution order (OUT): ACCESS_OUT → E2E → SIGN → STORE_OUT → DISPATCH_OUT → SYNC_OUT

## Storage adapters

| Module | Purpose | Typical mounts | Required in core bundle |
|---|---|---|---|
| `MemoryBackend` | ephemeral runtime state | `sys/`, tests | yes |
| `LocalStorageBackend` | local config persistence | `conf/` | optional in non-browser runtimes |
| `IdbBackend` | browser durable storage | `~`, `@`, `>`, `blobs/` | optional in Node-only runtimes |
| `FsBackend` | Node durable storage | relay/replica, CLI tools | optional |

## Network transports

| Module | Purpose | Typical use | Required in sync bundle |
|---|---|---|---|
| `HttpTransport` | request/response sync and blob transfer | browser relay sync | optional |
| `WsTransport` | realtime relay transport | browser realtime | optional |
| `NodeRelayTransport` | in-process relay integration | tests, local Node relay | optional |
| `LocalBridge` / local bus | local peer-to-peer testing | unit/integration tests | optional |
| future `WebRtcTransport` | direct peer transport | browser p2p | optional |

## Relay and replica modules

| Module | Purpose |
|---|---|
| `createReplicaDb()` | relay-side persistent store abstraction |
| `RelayRouter()` | subscription routing and fan-out |
| `createRelayPeer()` | compose a relay peer runtime |

## Packaging intent

The project should continue to support these production-oriented tiers:

- `quray-core`
- `quray-sync`
- `quray`

A production app should be able to avoid shipping:
- relay runtime helpers when acting only as a client
- IndexedDB code in Node-only relay builds
- browser-only transports in server-only artifacts
- UI components in headless or custom-UI applications
