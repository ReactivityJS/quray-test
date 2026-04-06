# UI Binding Guide

QuRay supports two complementary UI binding styles:

1. **Native `qu-*` attributes on normal HTML elements** for small, direct bindings.
2. **`<qu-bind>` and `<qu-list>`** for structured bindings and template-driven rendering.

The direct attribute style is the recommended default for simple values such as aliases,
app configuration, counters, titles or input fields.

## Recommended inline element

For a simple inline word, short text or number inside a sentence, use **`<span>`**.

Why `span` is the default recommendation:
- inline by default
- does not introduce block layout changes
- works well for words, counters and short labels
- easy to replace with another inline element if semantics require it

Example:

```html
<p>
  Welcome back, <span qu-key="~/alias"></span>.
</p>
```

## Native attribute binding

Supported attributes:

- `qu-key` — storage key or shorthand such as `~/alias`
- `qu-get` — value path inside the QuBit, default depends on scope
- `qu-bind` — target: `text`, `html`, `value`, `attr:title`, `prop:checked`, ...
- `qu-mode` — `one-way` or `two-way`
- `qu-live` — save on every keystroke instead of `change`
- `qu-format` — `text`, `count`, `date`, `time`, `datetime`, `bytes`, `json`, `bool`
- `qu-placeholder` — fallback for missing values
- `qu-prefix` / `qu-suffix` — static text around the formatted value
- `qu-scope` — optional explicit scope: `data`, `blob`, `delivery`

### One-way text binding

```html
<span qu-key="~/alias"></span>
<h1 qu-key="conf/app/title"></h1>
```

### Two-way input binding

```html
<input qu-key="conf/app/title" qu-bind="value" qu-mode="two-way">
```

### Live input binding

```html
<input qu-key="conf/app/title" qu-bind="value" qu-mode="two-way" qu-live>
```

### Attribute binding

```html
<span qu-key="conf/app/title" qu-bind="attr:title">Hover me</span>
<img qu-key="~/avatarUrl" qu-bind="attr:src">
<input qu-key="conf/app/enabled" qu-bind="prop:checked" qu-mode="two-way">
```

### Reactive page title

```html
<title qu-key="conf/app/title"></title>
```

This stays reactive. When the bound key changes, QuRay updates both the `<title>`
element and `document.title`.

## Inline counter example

```html
<p>
  You have <span qu-key="conf/app/unread" qu-format="count"></span> unread items.
</p>
```

That pattern is intentionally documented and tested because it is one of the most
common UI needs: a small reactive value embedded inside normal prose.

## `<qu-bind>` for structured value bindings

Use `<qu-bind>` when you want:
- a dedicated binding element
- an embedded `<template>`
- more explicit component-based markup
- easier encapsulation of a small reusable binding block

Example:

```html
<qu-bind key="@room/message/001">
  <template>
    <article>
      <strong data-qu-bind="data.author"></strong>
      <span data-qu-bind="data.text"></span>
      <time data-qu-bind="ts" data-qu-format="time"></time>
    </article>
  </template>
</qu-bind>
```

## `<qu-list>` for repeated items

Use `<qu-list>` when you want a reactive list for a prefix.

```html
<qu-list prefix="@room/messages/">
  <template>
    <li>
      <span data-qu-bind="data.text"></span>
      <time data-qu-bind="ts" data-qu-format="time"></time>
    </li>
  </template>
</qu-list>
```

## Cleanup and temporary DOM elements

Native `qu-*` bindings are automatically cleaned up.

QuRay uses a `MutationObserver` to:
- discover new bound elements added to the DOM
- disconnect listeners when bound elements are removed
- rebind elements when relevant `qu-*` attributes change

This means temporary DOM elements such as popovers, modals or conditional inline
fragments do not keep stale database listeners after removal.

### Recommendation

Use native `qu-*` bindings freely for simple and temporary DOM nodes.
For larger stateful widgets or when you want explicit lifecycle boundaries, prefer
Custom Elements such as `<qu-bind>`, `<qu-list>` or your own app-specific elements.

## Binding shorthand

`~/...` expands to the current logged-in user's public key.

Examples:
- `~/alias` → `~<currentUserPublicKey>/alias`
- `~/avatar` → `~<currentUserPublicKey>/avatar`
- `~` → `~<currentUserPublicKey>`

## API design guidance

Recommended default choices:

- inline text or number → `<span qu-key="..."></span>`
- input field → native `<input>` with `qu-key` + `qu-bind="value"`
- reactive title → `<title qu-key="..."></title>`
- structured single-record UI → `<qu-bind>` + `<template>`
- repeated records → `<qu-list>` + `<template>`

That keeps the framework small and avoids creating many specialised wrapper
components for aliases, counters, titles or configuration values.


## Automated vs. interactive verification

Use the automated browser suites for regression coverage.
Use `tests/manual-bindings.html` for manual inspection of user-facing behavior such as:

- typing into a two-way input while the DB updates live
- checking that inline `<span>` bindings keep sentence layout unchanged
- observing `<title>` updates in the browser tab
- mounting and removing temporary DOM fragments to verify cleanup behavior visually

That split keeps the automated tests deterministic while still giving the project a good page for human UI verification.

## Deletion semantics

`db.del(key)` now creates a **signed tombstone** on syncable mounts by default.
Normal reads hide tombstones, while `db.get(key, { includeDeleted: true })` exposes the stored deletion record.

This makes deletions:

- synchronizable across peers and relays
- attributable to the deleting actor
- signable like any other QuBit write

For local cache purges or ephemeral cleanup, use a hard delete:

```js
await db.del(key, { hard: true })
```


## Inline values inside text

Use a plain `<span>` for a single inline word, text fragment or counter that should not disturb line height or layout. This keeps the DOM small and works well for reactive text updates.

```html
<p>
  You have <span qu-key="conf/app/unread" qu-format="count"></span> unread items.
</p>
```

`<span>` is the recommended inline carrier because it is naturally inline, semantically neutral and does not introduce block layout side effects.

## Editable qu-bind inputs

`<qu-bind>` remains useful when a binding needs a small self-contained wrapper that manages its own internal target element. A common example is an editable input.

```html
<qu-bind key="~/alias" tag="input" set="value" editable></qu-bind>
```

This is reactive in both directions:
- database updates refresh the generated `<input>` value
- user edits write the changed value back to QuDB

The implementation now keeps the generated target element mounted even when observed attributes such as `key`, `tag`, `set`, `placeholder`, `editable` or `live` change before or after the component is connected.

## Automatic cleanup

Native `qu-*` bindings and `<qu-bind>` listeners are cleaned up automatically when their DOM nodes are removed. Use native elements with `qu-key` for the simplest inline case, and use `<qu-bind>` or `<qu-list>` when you need a local wrapper or template context.


## Inline values inside running text

For a single reactive word, number, or short text fragment inside a sentence, use a native inline element such as `<span>`.

```html
<p>
  Welcome back, <span qu-key="~/alias"></span>.
  You have <span qu-key="conf/app/unread" qu-format="count"></span> unread items.
</p>
```

The bindings demo also shows a full `qu-list` example with:
- adding a row from an input field,
- editing a row after clicking **Edit**,
- confirming changes with **OK**,
- deleting a row with confirmation,
- and browser-console snippets for direct `db.put(...)` writes.
