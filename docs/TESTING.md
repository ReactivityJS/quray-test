# Testing Guide

This project should be validated as a framework first.
Demos are intentionally secondary.

## Test priorities

1. QuDB local correctness
2. QuDB reactive semantics
3. QuNet transport and endpoint behavior
4. QuSync explicit subscription and pull behavior
5. relay replica restore behavior
6. blob and delivery state propagation
7. multi-part integration paths such as peer → relay → peer

## Node suites

Current Node suites:

- `tests/framework.test.js`
- `tests/db-event-flow.test.js`
- `tests/db-listener-contract.test.js`
- `tests/delete-tombstone-sync.test.js`
- `tests/access-control.test.js`
- `tests/value-binding-helpers.test.js`
- `tests/blob-progress-relay.test.js`
- `tests/modular.test.js`
- `tests/api.contract.test.js`
- `tests/relay-blob-sync.test.js`

Run everything:

```bash
npm test
```

Run specific suites:

```bash
npm run test:framework
npm run test:modular
npm run test:contracts
npm run test:binding-helpers
npm run test:access
npm run test:delete
npm run test:blob-progress
node tests/db-event-flow.test.js
node tests/relay-blob-sync.test.js
```

Node reports are generated automatically:

- `tests/reports/node-test-report.txt`
- `tests/reports/node-test-report.csv`
- `tests/reports/node-test-report.json`

## Browser suites

Browser tests are intentionally split into topic-oriented suite files.
The central entry point is:

- `tests/index.html`

Serve and open them:

```bash
npm run test:serve
```

```text
http://localhost:8787/tests/index.html
```

Current browser suite files:

- `tests/browser/suites/qubit.browser.test.js`
- `tests/browser/suites/db.browser.test.js`
- `tests/browser/suites/idb.browser.test.js`
- `tests/browser/suites/db-flow.browser.test.js`
- `tests/browser/suites/identity.browser.test.js`
- `tests/browser/suites/ui.browser.test.js`
- `tests/browser/suites/ui-binding-flow.browser.test.js`
- `tests/browser/suites/native-binding.browser.test.js`
- `tests/browser/suites/integration.browser.test.js`

The browser harness can export the latest run as TXT, CSV or JSON.

## What the contract tests focus on

The contract layer verifies behavior that should remain stable even if the
internal implementation changes:

- `db.on()` semantics across scopes
- `once` and `immediate` listener options
- consistent event naming for replayed state callbacks
- endpoint-based routing in QuNet
- explicit sync without patching QuDB listeners
- relay-backed restore after a hard local cache delete
- signed tombstone propagation for syncable deletes
- ACL enforcement for allowed and denied writes
- relay-backed blob sync plus upload/download progress in Node environments without HTTP blob endpoints

## Coverage guidance for future work

Every new core feature should ship with:

- at least one happy-path test
- at least one cleanup or unsubscribe test
- at least one direct-binding test for simple UI features when they are user-facing
- at least one failure or reconnect-oriented test when networked
- at least one integration test when the feature spans multiple modules

The framework should prefer deterministic tests using local peers and a local
relay transport before browser demos are used as validation.

## Interactive manual verification

For DOM-heavy manual checks, open:

```text
http://localhost:8787/tests/manual-bindings.html
```

That page is intentionally separate from the regression harness so interactive checks stay readable and do not destabilize the automated test run.


## Source maintenance

Keep source cleanup aligned with tests. When a rename or API cleanup changes behaviour,
add or update the smallest matching contract test instead of only adjusting demos.
