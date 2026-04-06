# Debugging Guide

QuRay intentionally keeps development builds verbose and source-readable.
The goal is to make failures explainable while preserving lean production output.

## Development build philosophy

Development builds should favor:
- readable source
- explicit comments
- meaningful variable names
- high-signal debug output around storage, transport, sync, and relay behavior

Production builds should favor:
- stripped debug lines
- compact bundles
- optional modular artifacts

## Current debug channels

The framework already emits detailed development logs for:
- QuDB writes and reactive dispatch
- QuQueue task lifecycle
- QuNet transport state and incoming packets
- QuSync replica/subscription activity
- relay routing and snapshot sync in Node-based tests

## Recommended debug areas

When adding or refactoring code, prefer debug output around:
- storage mount resolution
- middleware entry/exit
- network connect/disconnect state
- sync subscription setup and teardown
- relay snapshot responses
- blob upload/download state changes
- delivery state transitions

## Logging rules for source changes

- Keep debug statements guarded so production builds can strip them.
- Prefer module-prefixed messages.
- Prefer structured payloads over opaque strings.
- Keep comments in English.
- Keep log messages actionable.

Good:

```js
/*DEBUG*/ console.debug('[QuRay:QuSync] subscribe', { prefix, live, snapshot })
```

Avoid:

```js
/*DEBUG*/ console.log('something happened')
```

## Production logging

Use `LoggerPlugin` when you need structured runtime logging for tests, local
inspection, or remote collection.

Useful transports already available:
- memory transport for tests
- console transport for local debugging
- HTTP transport for central collection

## Future direction

A future cleanup pass should unify legacy debug strings and legacy non-English
messages behind a small helper layer while keeping the current dev ergonomics.
