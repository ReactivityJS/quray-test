# qu-* Elements Reference

QuRay provides two types of reactive UI integration:

1. **Native `qu-*` attributes** on any HTML element — preferred for simple bindings
2. **`<qu-*>` custom elements** — specialized widgets for common patterns

Both are registered when you call `QuRay.init({ ui: true, binding: true })` or
`registerComponents(db, { me, peers, net })` directly.

---

## Native `qu-*` attributes

Any HTML element can become a reactive binding by adding `qu-key`.

### Core attributes

| Attribute | Description |
|---|---|
| `qu-key` | Storage key or shorthand (`~/alias`, `conf/app/title`, `@room/...`) |
| `qu-bind` | Binding target: `text` (default), `html`, `value`, `attr:name`, `prop:name` |
| `qu-mode` | `one-way` (default) or `two-way` (input → db on change) |
| `qu-live` | For two-way: write on every keystroke (not just `change`) |
| `qu-format` | Format the value: `text`, `count`, `date`, `time`, `datetime`, `bytes`, `json`, `bool` |
| `qu-placeholder` | Fallback text when the key has no value |
| `qu-prefix` | Static text prepended before the formatted value |
| `qu-suffix` | Static text appended after the formatted value |
| `qu-scope` | Explicit scope: `data` (default), `blob`, `delivery` |

### Examples

```html
<!-- Text binding — reactive display -->
<span qu-key="~/alias"></span>
<h1 qu-key="conf/app/title" qu-placeholder="My App"></h1>

<!-- Reactive browser tab title -->
<title qu-key="conf/app/title" qu-placeholder="My App">My App</title>

<!-- Inline counter inside prose -->
<p>You have <span qu-key="conf/app/unread" qu-format="count"></span> unread messages.</p>

<!-- Attribute binding (reactive tooltip) -->
<button qu-key="conf/app/title" qu-bind="attr:title">Help</button>

<!-- Two-way input — saves on change -->
<input qu-key="~/alias" qu-bind="value" qu-mode="two-way">

<!-- Two-way input — saves on every keystroke -->
<input qu-key="conf/app/title" qu-bind="value" qu-mode="two-way" qu-live>

<!-- Checkbox property binding -->
<input type="checkbox" qu-key="conf/app/notifications" qu-bind="prop:checked" qu-mode="two-way">

<!-- Image src binding -->
<img qu-key="~/avatar" qu-bind="attr:src" qu-placeholder="/default-avatar.png">
```

### Shorthand `~/`

`~/` expands to the current logged-in user's public key namespace.

```html
<span qu-key="~/alias"></span>    → ~{currentUserPub}/alias
<span qu-key="~/bio"></span>      → ~{currentUserPub}/bio
<img  qu-key="~/avatar" qu-bind="attr:src">
```

### Automatic cleanup

Native `qu-*` bindings self-clean via `MutationObserver`. When an element is removed from
the DOM its database listener is disconnected automatically. No manual cleanup required.

---

## `<qu-bind>`

Structured single-record binding with optional template rendering.

### Attributes

| Attribute | Description |
|---|---|
| `key` | Storage key to bind to |
| `get` | Value path inside the QuBit (default: `data`) |
| `fmt` / `format` | Format: `text`, `count`, `date`, `time`, `datetime`, `bytes`, `bool`, `json` |
| `placeholder` | Fallback content when key is empty |
| `prefix` | Static prefix before the value |
| `suffix` | Static suffix after the value |
| `tag` | Tag name for the generated target element (default: `span`) |
| `set` | Property to bind to: `textContent`, `value`, `src`, `href`, … |
| `editable` | Enable two-way editing (writes back on change/input) |
| `live` | Write on every keystroke when `editable` |

### Simple usage

```html
<!-- Show user alias -->
<qu-bind key="~/alias"></qu-bind>

<!-- Show alias in a generated <h2> -->
<qu-bind key="~/alias" tag="h2"></qu-bind>

<!-- Show with placeholder -->
<qu-bind key="~/alias" placeholder="Anonymous"></qu-bind>

<!-- Editable two-way input -->
<qu-bind key="~/alias" tag="input" set="value" editable></qu-bind>

<!-- Live editing (saves on every keystroke) -->
<qu-bind key="conf/app/title" tag="input" set="value" editable live></qu-bind>
```

### With a native `<template>` for structured output

Use a `<template>` child to render the QuBit data into a rich DOM structure.
`data-qu-bind` on elements inside the template binds to a field of `qubit.data`.

```html
<qu-bind key="@room/message/001">
  <template>
    <article class="msg-card" title="{{key}}">
      <strong data-qu-bind="text"></strong>
      <time   data-qu-bind="ts" data-qu-format="time"></time>
    </article>
  </template>
</qu-bind>
```

Template interpolation:
- `{{key}}` — the QuBit key
- `{{ts}}` — the QuBit timestamp
- `{{from}}` — the author public key
- `data-qu-bind="fieldName"` — bind element to `qubit.data.fieldName`
- `data-qu-format="time|date|..."` — format the bound value

---

## `<qu-list>`

Reactive list that renders one item per QuBit under a prefix.

### Attributes

| Attribute | Description |
|---|---|
| `prefix` | Storage key prefix (e.g. `@room/messages/`) |
| `order` | Sort field: `ts` (default), `key`, or any `data.*` field |
| `limit` | Maximum number of items to render |
| `filter-field` | Filter by a `data.*` field name |
| `filter-value` | Value to match for the filter |
| `editable` | Enable inline edit on each item |
| `deletable` | Show delete button on each item |
| `addable` | Show an add input below the list |

### With native `<template>`

```html
<qu-list prefix="@room/chat/">
  <template>
    <li class="msg-row">
      <span class="author" data-qu-bind="from"></span>
      <span class="text"   data-qu-bind="text"></span>
      <time class="ts"     data-qu-bind="ts" data-qu-format="time"></time>
    </li>
  </template>
</qu-list>
```

### Filtered list

```html
<!-- Show only incomplete tasks -->
<qu-list prefix="@room/tasks/" filter-field="done" filter-value="false">
  <template>
    <li data-qu-bind="title"></li>
  </template>
</qu-list>
```

### With add/edit/delete controls

```html
<qu-list prefix="@room/tasks/" editable deletable addable limit="50">
  <template>
    <li data-qu-bind="text"></li>
  </template>
</qu-list>
```

---

## `<qu-media>`

Reactive media display for blob content (image, video, audio, PDF).

### Attributes

| Attribute | Description |
|---|---|
| `hash` | Blob hash (SHA-256 base64url) — resolves to an Object URL |
| `key` | QuBit key containing `{ hash, mime }` — resolves hash automatically |
| `mime` | MIME type hint (`image/png`, `video/mp4`, `audio/mp3`, …) |
| `size` | Display size in pixels (for square images) |
| `compact` | Smaller variant |
| `lazy` | Defer loading until visible (IntersectionObserver) |

```html
<!-- From a hash directly -->
<qu-media hash="sha256-base64url-hash" mime="image/jpeg"></qu-media>

<!-- From a QuBit key that contains { hash, mime } -->
<qu-media key="~{pub}/blob/sha256-hash"></qu-media>

<!-- Sized avatar-style image -->
<qu-media key="~/avatar" size="64"></qu-media>
```

---

## `<qu-avatar>`

Displays a user's avatar image with fallback initials.

### Attributes

| Attribute | Description |
|---|---|
| `pub` | User public key (loads avatar from `~{pub}/avatar`) |
| `size` | Diameter in pixels (default: 36) |
| `compact` | Smaller variant |

```html
<qu-avatar pub="base64url-public-key" size="48"></qu-avatar>
```

---

## `<qu-peer>`

Shows a peer card with avatar, alias, and online status dot.

### Attributes

| Attribute | Description |
|---|---|
| `pub` | Peer public key |
| `size` | Avatar size in px |
| `compact` | Compact variant (smaller, inline) |

```html
<qu-peer pub="base64url-public-key"></qu-peer>
<qu-peer pub="base64url-public-key" compact></qu-peer>
```

---

## `<qu-user-profile>`

Full user profile card with avatar, alias, bio, and optional edit mode.

### Attributes

| Attribute | Description |
|---|---|
| `pub` | User public key (shows their profile) |
| `editable` | Show edit controls (only works for own profile) |
| `compact` | Compact variant |

```html
<!-- View another user's profile -->
<qu-user-profile pub="base64url-public-key"></qu-user-profile>

<!-- Own editable profile -->
<qu-user-profile pub="myPub" editable></qu-user-profile>
```

---

## `<qu-field>`

Reactive editable field tied to a specific key and data path.

### Attributes

| Attribute | Description |
|---|---|
| `pub` | User public key (for `~{pub}/...` keys) |
| `field` | Field name within `data` (e.g. `alias`, `bio`) |
| `editable` | Show an edit input instead of read-only display |
| `placeholder` | Fallback when field is empty |
| `fmt` | Format: `text`, `date`, `time`, … |

```html
<!-- Reactive alias display for a user -->
<qu-field pub="base64url-key" field="alias"></qu-field>

<!-- Editable alias for own profile -->
<qu-field pub="myPub" field="alias" editable placeholder="Enter your name"></qu-field>
```

---

## `<qu-delivery>`

Inline delivery status indicator for a QuBit.

### Attributes

| Attribute | Description |
|---|---|
| `msg-key` | QuBit key to track delivery state for |

Renders a text symbol that updates reactively as the delivery state advances.

```html
<qu-delivery msg-key="@room/chat/msg-001"></qu-delivery>
```

Renders:
- `○` local
- `⏳` queued
- `✓` relay_in
- `✓✓` peer_sent / peer_recv
- `✓✓✓` peer_read

---

## `<qu-tick>`

SVG delivery tick icon — WhatsApp-style message status.

### Attributes

| Attribute | Description |
|---|---|
| `state` | Static state: `local` `queued` `relay_in` `peer_sent` `peer_recv` `peer_read` `failed` |
| `msg-key` | Reactive: subscribes to `db.delivery.on(key)` and updates automatically |

```html
<!-- Static icon (e.g. in a story/legend) -->
<qu-tick state="peer_recv"></qu-tick>

<!-- Reactive delivery status for a message -->
<qu-tick msg-key="@room/chat/msg-001"></qu-tick>
```

Renders SVG ticks:
- `○` local — no network yet
- `⏳` queued — waiting for relay
- Single grey tick — relay confirmed
- Double grey tick — peer device received
- Double green tick — peer app loaded
- Double blue tick — read receipt confirmed

---

## `<qu-status>`

Online / connection status indicator for a peer.

### Attributes

| Attribute | Description |
|---|---|
| `pub` | Peer public key |
| `label` | Show text label beside the dot |

```html
<qu-status pub="base64url-key"></qu-status>
<qu-status pub="base64url-key" label></qu-status>
```

---

## `<qu-sync-state>`

Shows the sync connection state as a colored dot.

States: `connecting` → `connected` → `syncing` → `idle` → `offline`

```html
<qu-sync-state></qu-sync-state>
```

No attributes needed — subscribes to the global sync state automatically.

---

## `<qu-dot>`

Simple colored status dot (CSS-only, no DB subscription).

### Attributes

| Attribute | Description |
|---|---|
| `color` | CSS variable name suffix: `green`, `red`, `amber`, `blue`, `sub` |
| `size` | Diameter in px (default: 8) |
| `pulse` | Add pulse animation (boolean) |

```html
<qu-dot color="green" size="8"></qu-dot>
<qu-dot color="amber" pulse></qu-dot>
```

---

## `<qu-badge>`

Numeric count badge, auto-hides when value is 0.

### Attributes

| Attribute | Description |
|---|---|
| `value` | Numeric count |
| `max` | Cap value (default: 99, shows `99+`) |
| `color` | `amber` (default), `red`, `green`, `blue` |
| `pill` | Pill shape instead of square |

```js
// Read/write via property
badgeEl.value = 5
```

```html
<qu-badge value="3" color="red"></qu-badge>
<qu-badge value="100" max="99" pill></qu-badge>
```

---

## `<qu-counter>`

Reactive QuBit count under a prefix.

### Attributes

| Attribute | Description |
|---|---|
| `prefix` | Key prefix to count (e.g. `@room/messages/`) |
| `filter-field` | Filter by `data.*` field name |
| `filter-value` | Only count items where `data[filter-field] === filter-value` |

Fires a `qu-count` custom event with `{ detail: { count } }` after each update.

```html
<!-- Total message count -->
<qu-counter prefix="@room/messages/"></qu-counter>

<!-- Unread message count -->
<qu-counter prefix="@room/messages/" filter-field="read" filter-value="false"></qu-counter>
```

---

## `<qu-ts>`

Formats a QuBit timestamp reactively.

### Attributes

| Attribute | Description |
|---|---|
| `key` | QuBit key |
| `field` | Field within the QuBit to read (default: `ts`) |
| `format` | `time`, `date`, `datetime`, `relative` |

```html
<qu-ts key="@room/chat/msg-001" format="time"></qu-ts>
<qu-ts key="@room/chat/msg-001" format="relative"></qu-ts>
```

---

## `<qu-enc-badge>`

Encryption indicator — shows a lock icon when a QuBit is E2E encrypted.

### Attributes

| Attribute | Description |
|---|---|
| `key` | QuBit key (reactive — updates if encryption changes) |
| `encrypted` | Static boolean attribute |

```html
<!-- Reactive from DB -->
<qu-enc-badge key="@room/chat/msg-001"></qu-enc-badge>

<!-- Static display -->
<qu-enc-badge encrypted></qu-enc-badge>
```

---

## `<qu-blob-thumb>`

Thumbnail / preview for a stored blob.

### Attributes

| Attribute | Description |
|---|---|
| `hash` | Blob hash |
| `mime` | MIME type hint |
| `size` | Thumbnail size in px |
| `compact` | Smaller variant |

```html
<qu-blob-thumb hash="sha256url-hash" mime="image/jpeg" size="80"></qu-blob-thumb>
```

---

## `<qu-blob-progress>`

Upload/download progress bar for a blob.

### Attributes

| Attribute | Description |
|---|---|
| `hash` | Blob hash to track |

```html
<qu-blob-progress hash="sha256url-hash"></qu-blob-progress>
```

---

## `<qu-blob-card>`

Combined blob card with thumbnail, filename, size, and progress.

### Attributes

| Attribute | Description |
|---|---|
| `hash` | Blob hash |
| `mime` | MIME type |
| `name` | Display filename |
| `size` | File size in bytes |
| `compact` | Compact variant |

```html
<qu-blob-card hash="sha256url-hash" mime="image/jpeg" name="photo.jpg" size="2400000">
</qu-blob-card>
```

---

## `<qu-blob-drop>`

Drag-and-drop file upload zone.

Emits a `qu-blob-drop` custom event with `{ detail: { hash, mime, name, size } }` after
each dropped or picked file is stored in `db.blobs`.

```html
<qu-blob-drop>Drop a file here or click to browse</qu-blob-drop>
```

```js
document.querySelector('qu-blob-drop').addEventListener('qu-blob-drop', ({ detail }) => {
  console.log('Blob stored:', detail.hash, detail.name)
})
```

---

## `<qu-peer-list>`

Shows a list of connected peers (uses `sys/peers/**`).

### Attributes

| Attribute | Description |
|---|---|
| `compact` | Compact / minimal list |
| `show-offline` | Include offline peers |

```html
<qu-peer-list></qu-peer-list>
<qu-peer-list compact show-offline></qu-peer-list>
```

---

## `<qu-inbox-badge>`

Badge showing the unread inbox message count for the current user.

```html
<qu-inbox-badge></qu-inbox-badge>
```

---

## `<qu-chat-msg>`

Full chat message component with delivery ticks, E2E indicator, and reactions.

### Attributes

| Attribute | Description |
|---|---|
| `msg-key` | Key of the message QuBit |
| `me` | Current user's public key (determines own vs. received styling) |
| `compact` | Compact variant |

```html
<qu-chat-msg msg-key="@room/chat/001" me="myPub"></qu-chat-msg>
```

---

## `<qu-profile-card>`

Profile card with avatar, alias, bio, and optional connect/message action buttons.

### Attributes

| Attribute | Description |
|---|---|
| `pub` | Target user's public key |
| `editable` | Show edit controls (for own profile) |

```html
<qu-profile-card pub="base64url-key"></qu-profile-card>
```

---

## `<qu-profile-edit>`

Full profile editor — alias, bio, avatar upload with live preview.

### Attributes

| Attribute | Description |
|---|---|
| `pub` | Own public key |

```html
<qu-profile-edit pub="myPub"></qu-profile-edit>
```

---

## `<qu-grid>`

Reactive data grid with sorting, filtering, inline editing, and deletion.

### Attributes

| Attribute | Description |
|---|---|
| `prefix` | Key prefix to query (e.g. `@space/todos/`) |
| `columns` | Comma-separated column names: `key`, `type`, `ts`, `data` or `data.field` |
| `sortable` | Enable column header click to sort |
| `filterable` | Show a search field above the grid |
| `editable` | Enable double-click inline editing |
| `deletable` | Show delete button per row |
| `limit` | Maximum rows to display (default: 100) |
| `flash-duration` | Duration in ms to highlight changed rows (default: 600) |

### Events

| Event | Detail |
|---|---|
| `qu-grid-select` | `{ qubit }` — row was clicked |
| `qu-grid-edit`   | `{ key, data }` — cell was edited |
| `qu-grid-delete` | `{ key }` — row was deleted |

```html
<qu-grid
  prefix="@room/todos/"
  columns="key,data.title,ts,type"
  sortable filterable deletable
  limit="50">
</qu-grid>
```

---

## `<qu-scope>` and `<qu-for>` (directives)

These provide template-level data context and iteration.

### `<qu-scope>`

Sets a QuBit context for child directives.

```html
<qu-scope key="@room/message/001">
  <!-- children can use {{data.text}}, {{ts}}, etc. -->
</qu-scope>
```

### `<qu-for>`

Iterates over QuBits under a prefix, renders one copy of child content per item.

```html
<qu-for prefix="@room/tasks/">
  <template>
    <li data-qu-bind="text"></li>
  </template>
</qu-for>
```

---

## `<qu-context>`

Sets a database context for an isolated subtree (advanced use — separate `QuDB` instance).

```html
<qu-context>
  <!-- bindings inside use this element's db instance -->
</qu-context>
```

---

## Registration

All elements are registered automatically when using `QuRay.init({ ui: true })`.

For manual registration (e.g. when composing `QuDB` directly):

```js
import { registerComponents } from './src/ui/components.js'
import { registerDirectives }  from './src/ui/directives.js'
import { QuBinding }           from './src/ui/binding.js'

registerComponents(db, { me: { pub: identity.pub }, peers, net })
registerDirectives(db, { me: { pub: identity.pub } })
QuBinding(db, { getCurrentUserPublicKey: () => identity.pub })
```
