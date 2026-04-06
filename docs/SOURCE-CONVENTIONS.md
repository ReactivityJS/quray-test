# Source Conventions

QuRay is a new framework. The source should optimise for clarity first and avoid
compatibility shims unless they provide a clear long-term benefit.

## Naming

Use descriptive names for variables and helper functions. Prefer names that explain
what a value represents over abbreviations that only save a few characters.

Good examples:

- `relayConfigurations`
- `pluginCleanupFunctions`
- `resolveDirectiveKey(...)`
- `findDirectiveScopeKey(...)`

Avoid introducing short opaque names such as `_v`, `_d`, `cfg`, or `tmp` unless the
scope is extremely small and the meaning is immediately obvious.

## Module boundaries

- `src/core/*` contains storage, identity, queue, network, and sync primitives.
- `src/plugins/*` contains middleware units that can be enabled or disabled.
- `src/ui/*` contains binding runtimes and UI components.
- `src/relay/*` contains relay-peer runtime pieces used by the Node relay transport.

A module should only do one job. If a helper starts mixing transport logic, storage
logic, and DOM logic, split it out.

## Comments

Use comments to explain *why* a path exists or *why* a constraint matters. Avoid
comments that only restate the line below them.

Useful comments often explain:

- why a mount or prefix exists
- why a write must skip reactive dispatch
- why a listener is cleaned up in a particular place
- why a relay or sync edge case is intentionally ignored

## Debug output

Debug messages should:

- stay in English
- use stable prefixes such as `[QuRay:QuDB]`
- mention the important identifier (key, hash, replica, task id)
- avoid noisy logs in hot loops unless they are clearly debug-only

## Tests

When adding behaviour, prefer:

1. a focused contract test for the smallest unit
2. a flow test for the module
3. an integration test only when multiple modules must cooperate

Keep browser-only interaction checks in browser suites or manual playground pages.
Keep deterministic core guarantees in Node tests whenever possible.
