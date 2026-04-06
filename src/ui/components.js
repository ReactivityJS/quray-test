// ════════════════════════════════════════════════════════════════════════════
// QuRay — ui/components.js
// Generic Web Components for database bindings, list rendering, blob handling,
// peer/profile views and small reactive UI helpers.
//
// Design goals:
//   - readable source with explicit names and comments
//   - generic building blocks instead of many specialised wrapper elements
//   - source-first development with optional debug output
//   - safe rendering: no eval, no implicit script execution in templates
//
// Native <template> elements are the preferred templating primitive.
// Components such as <qu-bind> and <qu-list> can render a child <template>
// against the current QuBit context without introducing a second template DSL.
// ════════════════════════════════════════════════════════════════════════════

import { QuBinding, registerBindingComponents } from './binding.js'
import {
  QUBIT_ROOT_FIELD_NAMES,
  findInlineTemplateElement,
  cloneInlineTemplateElement,
  formatBindingValue,
  readNestedValue,
  writeNestedValue,
  createTemplateBindingContext,
  resolveTemplateBindingValue,
  applyTemplateBindingValue,
  replaceTemplateTokensInString,
  applyTemplateBindingsToNode,
  renderTemplateIntoElement,
} from './value-binding.js'
import { sha256b64url } from '../core/identity.js'
import { KEY, resolveStorageKeyReference } from '../core/qubit.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared runtime references configured by registerComponents(db, { me, peers, net })
let _globalDb = null
let _globalBlobStore = null
let _globalMe = null
let _globalPeers = null
let _globalNet = null
let _globalBindingRuntime = null

const setDb = (dbInstance, opts = {}) => {
  // Backwards compat: setDb(db) or setDb(db, blobStore)
  if (opts && typeof opts.query === 'function') { _globalBlobStore = opts; opts = {} }
  _globalDb        = dbInstance
  _globalBlobStore = opts.blobs   ?? null
  _globalMe        = opts.me      ?? null
  _globalPeers     = opts.peers   ?? null
  _globalNet       = opts.net     ?? null
  // Re-initialize any profile-edit components that were deferred (DOM before init)
  if (_globalMe && _globalDb) {
    setTimeout(() => QuProfileEdit?._reinitPending?.(), 0)
  }
}

// Resolve shorthand key references such as ~/alias into canonical storage keys.
const resolveActiveUserPublicKey = (explicitPublicKey = null) => explicitPublicKey || _globalMe?.pub || null

const resolveComponentKeyReference = (rawKeyReference, explicitPublicKey = null) =>
  resolveStorageKeyReference(rawKeyReference, {
    currentUserPublicKey: resolveActiveUserPublicKey(explicitPublicKey),
  })

const createBindingElement = ({
  keyReference,
  placeholderText = '–',
  explicitPublicKey = null,
  tagName = null,
  target = null,
} = {}) => {
  const bindingElement = document.createElement('qu-bind')
  const resolvedKeyReference = resolveComponentKeyReference(keyReference, explicitPublicKey)
  if (resolvedKeyReference) bindingElement.setAttribute('key', resolvedKeyReference)
  bindingElement.setAttribute('placeholder', placeholderText)
  if (tagName) bindingElement.setAttribute('tag', tagName)
  if (target) bindingElement.setAttribute('set', target)
  return bindingElement
}


// ─────────────────────────────────────────────────────────────────────────────
// SYNC-STATUS-KLASSEN (CSS)
// Werden als Klassen auf die Komponente gesetzt — App-CSS kann sie stylen
// ─────────────────────────────────────────────────────────────────────────────
const SYNC_CSS_CLASS = {
  local:   'qu-sync-local',     // nur lokal, noch nicht gesendet
  pending: 'qu-sync-pending',   // wird gerade gesendet
  synced:  'qu-sync-synced',    // erfolgreich synchronisiert
  failed:  'qu-sync-failed',    // Fehler beim Sync
}

const BLOB_CSS_CLASS = {
  pending:       'qu-blob-pending',        // Download steht aus
  downloading:   'qu-blob-downloading',   // Download in progress
  ready:         'qu-blob-ready',         // ready
  awaiting:      'qu-blob-awaiting',      // wartet auf User
  error:         'qu-blob-error',         // Fehler
}


// ─────────────────────────────────────────────────────────────────────────────
// QU-ELEMENT — BASIS-KLASSE
// Alle QuRay-Komponenten erben von hier.
// Verwaltet auto-cleanup von Subscriptions und Signals.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Base class for all QuRay Custom Elements.
 * Provides automatic subscription cleanup and QuRay-specific helpers.
 *
 * Lifecycle:
 *   connectedCallback()    → initialises _offFns[], calls _quInit()
 *   disconnectedCallback() → calls all off() functions, calls _quDestroy()
 *
 * Helpers:
 *   _subscribe(pattern, fn)  — db.on() with auto-cleanup
 *   _watch(signal, fn)       — Signal.on() with auto-cleanup
 *   _attr(name, default)     — getAttribute with fallback
 *   _boolAttr(name)          — hasAttribute
 *   _updateSyncClass(status) — reflects QuBit._status as CSS class
 *
 * @group Custom Elements
 * @since 0.1.0
 *
 * @example
 * class QuMyWidget extends QuElement {
 *   _quInit() {
 *     this._key = this._attr('key')
 *     this._subscribe(this._key, q => { this.textContent = q?.data ?? '–' })
 *   }
 * }
 * // Register outside the QuRay bundle — never pass example code to customElements.define()
 */
class QuElement extends HTMLElement {
  connectedCallback() {
    this._offFns = []   // cleanup-Funktionen aller Subscriptions
    this._quInit()
  }

  disconnectedCallback() {
    this._offFns.forEach(offFn => offFn?.())
    this._offFns = []
    this._quDestroy?.()
  }

  // subscribe — db.on() mit auto-cleanup
  _subscribe(pattern, callbackFn) {
    if (!_globalDb) return
    this._offFns.push(_globalDb.on(pattern, callbackFn))
  }

  // watch — Signal.on() mit auto-cleanup
  _watch(signalInstance, callbackFn) {
    this._offFns.push(signalInstance.on(callbackFn))
  }

  // Attribut-Hilfsfunktionen
  _attr(name, defaultValue = null) {
    return this.hasAttribute(name) ? (this.getAttribute(name) || defaultValue) : defaultValue
  }
  _boolAttr(name) { return this.hasAttribute(name) }

  // sync-Klassen aktualisieren
  _updateSyncClass(syncStatus) {
    Object.values(SYNC_CSS_CLASS).forEach(cls => this.classList.remove(cls))
    if (SYNC_CSS_CLASS[syncStatus]) this.classList.add(SYNC_CSS_CLASS[syncStatus])
  }

  // Overridable by subclasses.
  _quInit()    {}
  _quDestroy() {}
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-bind> — Generic reactive value binding
//
// Attribute:
//   key="data/me/name"       DB-Key des QuBit
//   field="data.text"        Feld im QuBit (dot-notation, default: "data")
//   block                    <div> statt <span>
//   editable                 Inline-Editing via contenteditable
//   sync-indicator           Sync-Status als CSS-Klasse
//   placeholder="…"          Text wenn kein Wert vorhanden
//
// Verwendung:
//   <qu-bind key="data/me/profile/name" get="data.name" editable></qu-bind>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Universal reactive binding element. Reads any DB key, subscribes reactively,
 * and reflects the value to any HTML element or attribute.
 * Covers simple reactive display and edit cases without specialised wrapper elements.
 *
 * Attribute reference:
 *   key="~pub/alias"       DB key to subscribe (required)
 *   get="val|ts|id|from|type|sig|^root|x.y.z"  QuBit field (default: val = data)
 *   fmt="text|date|time|datetime|bytes|count|json|bool"  Display format
 *   tag="span|div|input|img|a|..."  HTML element (default: span)
 *   set="text|html|value|attr:X|prop:X"  Bind target (default: text)
 *   placeholder="–"        Shown when value is null/undefined
 *   prefix="" suffix=""    Text prepended/appended to value
 *   editable               Saves typed value back to DB on change
 *   live                   Saves on every keystroke (vs blur)
 *
 * Special key prefixes handled automatically:
 *   conf/delivery/...  → uses db.delivery.on() instead of db.on()
 *   sys/peers/{pub}    → reads ephemeral peer state from RAM backend
 *
 * @group Custom Elements
 * @since 0.1.0
 *
 * @example
 * <!-- Alias, reactively updated when DB changes -->
 * <qu-bind key="~alice/alias"></qu-bind>
 *
 * @example
 * <!-- QuBit timestamp formatted as HH:MM -->
 * <qu-bind key="@room/msg/001" get="ts" fmt="time"></qu-bind>
 *
 * @example
 * <!-- Online status from PeerMap: 'true' / 'false' / '–' -->
 * <qu-bind key="sys/peers/abc123" get="data.online" fmt="bool"></qu-bind>
 *
 * @example
 * <!-- Two-way input: reads and writes ~pub/alias -->
 * <qu-bind key="~pub/alias" tag="input" set="value" editable></qu-bind>
 *
 * @example
 * <!-- Reactive image src -->
 * <qu-bind key="~pub/avatar" tag="img" set="attr:src"></qu-bind>
 *
 * @example
 * <!-- Nested path with formatted count -->
 * <qu-bind key="@space/~meta" get="data.memberCount" fmt="count" suffix=" Mitglieder"></qu-bind>
 *
 * @example
 * <!-- Room name from meta — reactive, editable if owner -->
 * <qu-bind key="@spaceId/~meta" get="data.name" tag="h2" editable></qu-bind>
 */
class QuBind extends QuElement {
  static get observedAttributes() {
    return [
      'key',
      'get',
      'fmt',
      'format',
      'placeholder',
      'prefix',
      'suffix',
      'set',
      'tag',
      'editable',
      'live',
    ]
  }

  attributeChangedCallback(attributeName, previousValue, nextValue) {
    if (previousValue === nextValue) return
    this._captureTemplateDefinitionFromDom()
    this.replaceChildren()
    this._detachTargetWriteListener()
    this._offFns?.forEach((stopListening) => stopListening?.())
    this._offFns = []
    this._quInit()
  }

  _detachTargetWriteListener() {
    if (!this._targetElement || !this._targetWriteListener || !this._targetWriteEventName) return
    this._targetElement.removeEventListener(this._targetWriteEventName, this._targetWriteListener)
    this._targetWriteEventName = null
    this._targetWriteListener = null
  }

  _ensureTargetElementMounted() {
    const targetTagName = this._targetTagName || 'span'
    const hasReusableTargetElement = this._targetElement && this._targetElement.tagName?.toLowerCase() === targetTagName

    if (!hasReusableTargetElement) {
      this._detachTargetWriteListener()
      this._targetElement = document.createElement(targetTagName)
    }

    if ((targetTagName === 'span' || targetTagName === 'div') && this._targetElement.style.display !== 'contents') {
      this._targetElement.style.display = 'contents'
    }

    if (this._targetElement.parentNode !== this) {
      this.appendChild(this._targetElement)
    }
  }

  _captureTemplateDefinitionFromDom() {
    const inlineTemplateElement = findInlineTemplateElement(this)
    if (inlineTemplateElement) {
      this._templateDefinition = cloneInlineTemplateElement(inlineTemplateElement)
    }
  }

  _quInit() {
    this._captureTemplateDefinitionFromDom()

    this._keyReference = this._attr('key')
    this._resolvedKeyReference = resolveComponentKeyReference(this._keyReference)
    this._valuePath = this._attr('get', 'val')
    this._formatName = this._attr('fmt') || this._attr('format', 'text')
    this._targetTagName = this._attr('tag', 'span')
    this._targetBinding = this._attr('set', 'text')
    this._placeholderText = this._attr('placeholder', '–')
    this._prefixText = this._attr('prefix', '')
    this._suffixText = this._attr('suffix', '')
    this._isEditable = this._boolAttr('editable')
    this._isLiveBinding = this._boolAttr('live')
    this._usesInlineTemplate = Boolean(this._templateDefinition)

    if (!this._resolvedKeyReference) { this._applyTo(null, null); return }

    if (this._usesInlineTemplate) {
      this._detachTargetWriteListener()
      this._templateHostElement = this._templateHostElement ?? document.createElement('span')
      this._templateHostElement.style.display = 'contents'
      if (this._templateHostElement.parentNode !== this) this.appendChild(this._templateHostElement)
    } else {
      this._ensureTargetElementMounted()
      this._detachTargetWriteListener()

      if (this._isEditable && (this._targetTagName === 'input' || this._targetTagName === 'textarea' || this._targetElement.contentEditable)) {
        this._targetWriteEventName = this._isLiveBinding ? 'input' : 'change'
        this._targetWriteListener = () => {
          const nextValue = this._targetElement.value ?? this._targetElement.textContent
          _globalDb?.put(this._resolvedKeyReference, nextValue).catch(() => {})
        }
        this._targetElement.addEventListener(this._targetWriteEventName, this._targetWriteListener)
      }
    }

    if (this._resolvedKeyReference.startsWith('conf/delivery/')) {
      const messageKey = this._resolvedKeyReference.replace(/^conf\/delivery\//, '').replace(/_/g, '/')
      if (_globalDb?.delivery) {
        _globalDb.delivery.get(messageKey).then((entry) => this._applyTo(entry?.state ?? null, entry ?? null))
        const stopListening = _globalDb.delivery.on(messageKey, (entry) => this._applyTo(entry?.state ?? null, entry ?? null))
        if (stopListening) this._offFns.push(stopListening)
      }
    } else {
      _globalDb?.get(this._resolvedKeyReference).then((qubit) => this._applyTo(this._extract(qubit), qubit))
      this._subscribe(this._resolvedKeyReference, (qubit) => this._applyTo(this._extract(qubit), qubit))
    }
  }

  _extract(qubit) {
    if (qubit === null || qubit === undefined) return null
    const valuePath = this._valuePath
    if (valuePath === 'val' || valuePath === 'data') return qubit?.data ?? qubit
    if (valuePath.startsWith('^')) return qubit?.[valuePath.slice(1)]
    if (QUBIT_ROOT_FIELD_NAMES.has(valuePath)) return qubit?.[valuePath]
    return readNestedValue(qubit?.data ?? qubit, valuePath)
  }

  _applyTo(resolvedValue, sourceQuBit = null) {
    if (this._usesInlineTemplate && this._templateDefinition && this._templateHostElement) {
      renderTemplateIntoElement(
        this._templateHostElement,
        this._templateDefinition,
        createTemplateBindingContext(sourceQuBit, resolvedValue, this._resolvedKeyReference),
      )
      return
    }

    if (!this._targetElement) return
    applyTemplateBindingValue(this._targetElement, resolvedValue, {
      targetBinding: this._targetBinding,
      formatName: this._formatName,
      placeholderText: this._placeholderText,
      prefixText: this._prefixText,
      suffixText: this._suffixText,
    })
  }

  _format(rawValue) {
    return formatBindingValue(rawValue, this._formatName, this._placeholderText)
  }

  _quDestroy() {
    this._detachTargetWriteListener()
  }
}

/**
 * Register the QuRay UI Custom Elements. Safe to call multiple times.
 * Must be called after QuRay.init() to wire db/me/peers/net references.
 *
 * @param {QuDB} dbInstance - QuDB instance from QuRay.init()
 * @param {object} [opts]
 * @param {LocalPeer} [opts.me] - Local identity (for avatar, alias)
 * @param {PeerMap} [opts.peers] - Peer registry (for online status)
 * @param {QuNet} [opts.net] - Network layer (for sync state indicators)
 * @group Custom Elements
 * @since 0.1.0
 *
 * @example
 * const qr = await QuRay.init({ ui: false })
 * registerComponents(qr.db, { me: qr.me, peers: qr.peers, net: qr._.net })
 *
 * @example
 * // Or auto-register via init option:
 * const qr = await QuRay.init({ relay: 'wss://...', ui: true })
 */
const registerComponents = (dbInstance, optsOrBlobs = null) => {
  // Accept registerComponents(db) from QuRay.init ui:true
  // or registerComponents(qr.db, { me, peers, net }) for manual setup
  const opts = optsOrBlobs && typeof optsOrBlobs.query === 'function'
    ? { blobs: optsOrBlobs }
    : (optsOrBlobs ?? {})
  setDb(dbInstance, opts)

  // Register low-level binding components such as <qu-context>
  registerBindingComponents()

  if (!customElements.get('qu-media'))    customElements.define('qu-media',    QuMedia)
  if (!customElements.get('qu-list'))     customElements.define('qu-list',     QuList)
  // Atomic components
  if (!customElements.get('qu-dot'))         customElements.define('qu-dot',         QuDot)
  if (!customElements.get('qu-badge'))       customElements.define('qu-badge',       QuBadge)
  if (!customElements.get('qu-counter'))     customElements.define('qu-counter',     QuCounter)
  if (!customElements.get('qu-ts'))          customElements.define('qu-ts',          QuTs)
  if (!customElements.get('qu-tick'))        customElements.define('qu-tick',        QuTick)
  if (!customElements.get('qu-enc-badge'))   customElements.define('qu-enc-badge',   QuEncBadge)
  if (!customElements.get('qu-bind'))         customElements.define('qu-bind',        QuBind)
  if (!customElements.get('qu-sync-state'))   customElements.define('qu-sync-state',  QuSyncState)
  // Blob components
  if (!customElements.get('qu-blob-thumb'))  customElements.define('qu-blob-thumb',  QuBlobThumb)
  if (!customElements.get('qu-blob-progress')) customElements.define('qu-blob-progress', QuBlobProgress)
  if (!customElements.get('qu-blob-card'))   customElements.define('qu-blob-card',   QuBlobCard)
  if (!customElements.get('qu-blob-drop'))   customElements.define('qu-blob-drop',   QuBlobDrop)
  // Peer/Profile components
  if (!customElements.get('qu-user-profile')) customElements.define('qu-user-profile', QuUserProfile)
  if (!customElements.get('qu-peer-list'))   customElements.define('qu-peer-list',   QuPeerList)
  if (!customElements.get('qu-inbox-badge')) customElements.define('qu-inbox-badge', QuInboxBadge)
  // Chat component
  if (!customElements.get('qu-chat-msg'))    customElements.define('qu-chat-msg',    QuChatMsg)
  // Emoji picker
  if (!customElements.get('qu-emoji-picker')) customElements.define('qu-emoji-picker', QuEmojiPicker)
  // Profile components
  if (!customElements.get('qu-profile-card')) customElements.define('qu-profile-card', QuProfileCard)
  if (!customElements.get('qu-profile-edit')) customElements.define('qu-profile-edit', QuProfileEdit)
  // Existing components
  if (!customElements.get('qu-grid'))        customElements.define('qu-grid',        QuGrid)
  if (!customElements.get('qu-peer'))        customElements.define('qu-peer',        QuPeer)
  if (!customElements.get('qu-avatar'))      customElements.define('qu-avatar',      QuAvatar)
  if (!customElements.get('qu-field'))       customElements.define('qu-field',       QuField)
  if (!customElements.get('qu-status'))      customElements.define('qu-status',      QuStatus)
  if (!customElements.get('qu-delivery'))    customElements.define('qu-delivery',    QuDelivery)

  // Start the native qu-* binding runtime: scans the DOM and attaches the global observer
  _globalBindingRuntime?.destroy?.()
  const binding = QuBinding(dbInstance, {
    getCurrentUserPublicKey: () => _globalMe?.pub ?? null,
  })
  binding.init()
  _globalBindingRuntime = binding

  /*DEBUG*/ console.info('[QuRay:Components] registered generic binding, blob, profile and utility UI components')

  return binding
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export {
  registerComponents,
  setDb,
  QuElement,
  QuMedia,
  QuList,
  QuGrid,
  QuPeer,
  QuAvatar,
  QuField,
  QuStatus,
  QuDelivery,
  // New atomic + composite components
  QuDot, QuBadge, QuCounter, QuTs, QuTick, QuEncBadge, QuSyncState,
  QuBlobThumb, QuBlobProgress, QuBlobCard, QuBlobDrop,
  QuUserProfile, QuPeerList, QuInboxBadge, QuChatMsg,
  QuProfileCard, QuProfileEdit, QuEmojiPicker,
  SYNC_CSS_CLASS,
  BLOB_CSS_CLASS,
  // Helper functions for custom application components
  _resolveField  as resolveField,
  _setField      as setField,
  _formatBytes   as formatBytes,
  _getMimeCategory as getMimeCategory,
}

// Re-export the binding API so application code can import from components.js only
export { QuBinding, registerBindingComponents } from './binding.js'
// ═══════════════════════════════ DATA ═══════════════════════════════════════
// Generic data-template rendering helpers used by list-style components

class QuMedia extends QuElement {
  _quInit() {
    const qubitKey   = this._attr('key')
    const autoload   = this._boolAttr('autoload')

    if (!qubitKey) {
      /*DEBUG*/ console.warn('[QuRay:qu-media] missing key attribute')
      return
    }

    this._qubitKey = qubitKey
    this._meta     = null
    this._mediaEl  = null

    // Slot-Templates aus innerHTML parsen
    this._slots = _parseSlots(this)

    // Lade-Indikator und Fortschrittsbalken vorbereiten
    this._progressEl = null

    // Initialen Zustand laden
    _globalDb?.get(qubitKey).then(qubit => {
      if (qubit) this._handleBlobMeta(qubit, autoload)
    })

    // React to blob.meta changes.
    this._subscribe(qubitKey, (qubit, { event }) => {
      if (event === 'del') { this._renderEmpty(); return }
      this._handleBlobMeta(qubit, autoload)
    })

    // React to blob status changes such as progress and ready state.
    if (_globalBlobStore) {
      this._offFns.push(
        _globalDb?.on('blobs/' + _extractHashFromKey(qubitKey), (statusObj, { event }) => {
          if (event === 'blob-status') this._handleBlobStatus(statusObj)
        })
      )
    }

    // Queue-Fortschritt lauschen
    if (_globalDb?.queue) {
      this._offFns.push(
        _globalDb.queue.on('task.progress', (task) => {
          if (task.data?.hash === this._hash) this._updateProgress(task.progress)
        })
      )
      this._offFns.push(
        _globalDb.queue.on('task.failed', (task) => {
          if (task.data?.hash === this._hash) this._renderError('Download failed')
        })
      )
    }

    // Click handlers for data-qu-action buttons.
    this.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-qu-action]')
      if (!actionEl) return
      const action = actionEl.dataset.quAction
      if (action === 'load')     this._triggerLoad()
      if (action === 'download') this._triggerFileDownload()
    })
  }

  _handleBlobMeta(qubit, autoload) {
    const metaData = qubit.data ?? {}
    this._meta     = metaData
    this._hash     = metaData.hash ?? _extractHashFromKey(this._qubitKey)

    this._updateSyncClass(qubit._status)

    if (autoload) {
      _globalDb?.loadBlob(this._hash)
    }

    // Inspect the current blob status.
    const blobRef = _globalDb?.getBlob(this._hash)
    if (blobRef) {
      this._handleBlobStatus(blobRef)
    } else {
      // Noch nichts bekannt → Pending-Zustand
      this._renderPending()
    }

    // onBlob registrieren
    if (_globalDb) {
      const offOnBlob = _globalDb.onBlob(this._hash, ({ url, meta }) => {
        this._renderReady(url, meta ?? this._meta)
        offOnBlob()
      })
      this._offFns.push(offOnBlob)
    }
  }

  _handleBlobStatus({ status, url, meta }) {
    const resolvedMeta = meta ?? this._meta ?? {}

    // CSS-Klassen aktualisieren
    Object.values(BLOB_CSS_CLASS).forEach(cls => this.classList.remove(cls))
    if (BLOB_CSS_CLASS[status]) this.classList.add(BLOB_CSS_CLASS[status])

    if (status === 'ready')          this._renderReady(url, resolvedMeta)
    else if (status === 'pending')   this._renderPending()
    else if (status === 'awaiting-user') this._renderAwaiting(resolvedMeta)
    else if (status === 'error')     this._renderError('File unavailable')
  }

  _renderEmpty() {
    this.innerHTML = ''
    this._mediaEl  = null
  }

  _renderPending() {
    this.innerHTML = ''
    const slotContent = this._slots.pending
    if (slotContent) {
      this.appendChild(slotContent.cloneNode(true))
    } else {
      // Standard-Pending: Fortschrittsbalken
      this._progressEl        = document.createElement('div')
      this._progressEl.className = 'qu-progress'
      const bar               = document.createElement('div')
      bar.className           = 'qu-progress-bar'
      bar.style.width         = '0%'
      this._progressEl.appendChild(bar)
      this.appendChild(this._progressEl)
    }
    /*DEBUG*/ console.debug('[QuRay:qu-media] pending:', this._hash?.slice(0, 16))
  }

  _renderAwaiting(meta) {
    this.innerHTML = ''
    const slotContent = this._slots.awaiting
    if (slotContent) {
      const cloned = slotContent.cloneNode(true)
      // Populate data-qu-size with the formatted byte size.
      const sizeEl = cloned.querySelector('[data-qu-size]')
      if (sizeEl && meta.size) sizeEl.textContent = _formatBytes(meta.size)
      this.appendChild(cloned)
    } else {
      // Standard-Awaiting: Button
      const button = document.createElement('button')
      button.className      = 'qu-load-btn'
      button.dataset.quAction = 'load'
      button.textContent    = meta.size
        ? `${meta.name || 'Datei'} laden (${_formatBytes(meta.size)})`
        : `${meta.name || 'Datei'} laden`
      this.appendChild(button)
    }
  }

  _renderReady(objectUrl, meta) {
    this.innerHTML = ''
    this._progressEl = null

    const mime         = meta.mime ?? this._meta?.mime ?? ''
    const mimeCategory = _getMimeCategory(mime)
    const controls     = this._boolAttr('controls')
    const loop         = this._boolAttr('loop')
    const muted        = this._boolAttr('muted')

    if (mimeCategory === 'image') {
      this._mediaEl = document.createElement('img')
      this._mediaEl.src = objectUrl
      this._mediaEl.alt = meta.name ?? ''
      this._mediaEl.className = 'qu-image'
    } else if (mimeCategory === 'video') {
      this._mediaEl = document.createElement('video')
      this._mediaEl.src      = objectUrl
      this._mediaEl.controls = controls
      this._mediaEl.loop     = loop
      this._mediaEl.muted    = muted
      this._mediaEl.className = 'qu-video'
    } else if (mimeCategory === 'audio') {
      this._mediaEl = document.createElement('audio')
      this._mediaEl.src      = objectUrl
      this._mediaEl.controls = controls !== false   // audio hat default controls
      this._mediaEl.loop     = loop
      this._mediaEl.className = 'qu-audio'
    } else {
      // Generische Datei → Download-Link
      this._mediaEl = document.createElement('a')
      this._mediaEl.href     = objectUrl
      this._mediaEl.download = meta.name ?? 'download'
      this._mediaEl.className = 'qu-file'
      this._mediaEl.innerHTML = `
        <span class="qu-file-icon">${_mimeIcon(mime)}</span>
        <span class="qu-file-name">${meta.name ?? 'Datei'}</span>
        <span class="qu-file-size">${meta.size ? _formatBytes(meta.size) : ''}</span>
      `
    }

    this.appendChild(this._mediaEl)
    this.classList.add(BLOB_CSS_CLASS.ready)
    /*DEBUG*/ console.debug('[QuRay:qu-media] ready:', this._hash?.slice(0, 16), mimeCategory)
  }

  _renderError(messageText) {
    this.innerHTML = ''
    const slotContent = this._slots.error
    if (slotContent) {
      this.appendChild(slotContent.cloneNode(true))
    } else {
      const errorEl  = document.createElement('span')
      errorEl.className = 'qu-error'
      errorEl.textContent = messageText
      this.appendChild(errorEl)
    }
    this.classList.add(BLOB_CSS_CLASS.error)
  }

  _updateProgress(percent) {
    const bar = this._progressEl?.querySelector('.qu-progress-bar')
    if (bar) bar.style.width = `${percent}%`
  }

  _triggerLoad() {
    if (this._hash && _globalDb) _globalDb.loadBlob(this._hash)
  }

  _triggerFileDownload() {
    const url = _globalDb?.getBlob(this._hash)?.url
    if (!url) return
    const anchor  = document.createElement('a')
    anchor.href   = url
    anchor.download = this._meta?.name ?? 'download'
    anchor.click()
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-list> — Reaktive Liste mit optionalen CRUD-Actions
//
// Attribute:
//   prefix="data/me/todos/"   DB-Prefix für alle Items
//   order="data.order"        Sortierfeld (Fractional Indexing)
//   order-dir="asc|desc"      Sortierrichtung, default asc
//   tag="ul|ol|div"           Listen-Element, default ul
//   sortable                  Drag-and-Drop Umsortieren
//   editable                  Edit-Buttons pro Item
//   deletable                 Delete-Buttons pro Item
//   addable                   "Neu hinzufügen"-Button
//   add-placeholder="…"       Placeholder für neues Item
//   limit="50"                Maximale Anzahl Items
//
// Template:
//   <qu-list prefix="data/me/todos/" sortable deletable>
//     <template>
//       <li data-qu-text="data.text" data-qu-key></li>
//     </template>
//   </qu-list>
//
// data-qu-* Attribute im Template (werden beim Rendern befüllt):
//   data-qu-text="field"      textContent aus Feld
//   data-qu-key               wird mit QuBit-Key befüllt (für Referenz)
//   data-qu-field="field"     wird mit Feld-Wert befüllt (für value etc.)
// ─────────────────────────────────────────────────────────────────────────────
class QuList extends QuElement {
  _quInit() {
    this._prefix      = this._attr('prefix')
    this._orderField  = this._attr('order', 'ts')
    this._orderDir    = this._attr('order-dir', 'asc')
    this._listTag     = this._attr('tag', 'ul')
    this._isSortable  = this._boolAttr('sortable')
    this._isEditable  = this._boolAttr('editable')
    this._isDeletable = this._boolAttr('deletable')
    this._isAddable   = this._boolAttr('addable')
    this._limit       = parseInt(this._attr('limit', '200'))
    this._addPlaceholder = this._attr('add-placeholder', 'Neues Element…')

    if (!this._prefix) {
      /*DEBUG*/ console.warn('[QuRay:qu-list] missing required prefix attribute')
      return
    }

    // Native <template> is the preferred lightweight item renderer.
    this._itemTemplate = findInlineTemplateElement(this)

    // Listen-Element erstellen
    this._listEl = document.createElement(this._listTag)
    this._listEl.className = 'qu-list-inner'
    this.innerHTML = ''
    this.appendChild(this._listEl)

    // "Neu"-Button
    if (this._isAddable) this._renderAddButton()

    // Initiale Daten laden
    this._loadAndRender()

    // Reaktiv: auf alle Änderungen unter dem Prefix lauschen
    this._subscribe(this._prefix + '**', (qubit, { event }) => {
      /*DEBUG*/ console.debug('[QuRay:qu-list] change:', event, qubit?.key)
      this._loadAndRender()
    })

    // Drag-and-Drop Sortierung
    if (this._isSortable) this._initDragAndDrop()

    // Klick-Handler für Aktions-Buttons
    this._listEl.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-qu-action]')
      if (!actionEl) return
      const action  = actionEl.dataset.quAction
      const itemEl  = actionEl.closest('[data-qu-key]')
      const itemKey = itemEl?.dataset.quKey
      if (!itemKey) return
      if (action === 'delete') this._handleDelete(itemKey)
      if (action === 'edit')   this._handleEditStart(itemEl, itemKey)
    })
  }

  async _loadAndRender() {
    if (!_globalDb) return

    const orderMode = this._orderField === 'data.order' ? 'data.order'
                    : this._orderDir === 'desc'         ? 'ts-desc'
                    : 'ts'

    const items = await _globalDb.query(this._prefix, {
      limit: this._limit,
      order: orderMode,
    })

    this._renderItems(items)
  }

  _renderItems(qubitArray) {
    const existingItemByKey = new Map()
    this._listEl.querySelectorAll('[data-qu-key]').forEach((itemElement) => {
      existingItemByKey.set(itemElement.dataset.quKey, itemElement)
    })

    const renderedKeys = new Set()

    qubitArray.forEach((qubit, index) => {
      renderedKeys.add(qubit.key)
      const existingItemElement = existingItemByKey.get(qubit.key)
      let nextItemElement = existingItemElement

      if (!existingItemElement || this._itemTemplate) {
        nextItemElement = this._createItemElement(qubit)
        if (existingItemElement) existingItemElement.replaceWith(nextItemElement)
        else this._listEl.appendChild(nextItemElement)
      } else {
        this._updateItemElement(nextItemElement, qubit)
      }

      if (this._listEl.children[index] !== nextItemElement) {
        this._listEl.insertBefore(nextItemElement, this._listEl.children[index] ?? null)
      }
    })

    for (const [itemKey, itemElement] of existingItemByKey) {
      if (!renderedKeys.has(itemKey)) itemElement.remove()
    }
  }

  _createItemElement(qubit) {
    let itemElement

    if (this._itemTemplate) {
      const templateFragment = this._itemTemplate.content.cloneNode(true)
      const hasSingleRootElement = templateFragment.childElementCount === 1 && templateFragment.childNodes.length === 1
      if (hasSingleRootElement) {
        itemElement = templateFragment.firstElementChild
      } else {
        itemElement = document.createElement(this._listTag === 'ol' || this._listTag === 'ul' ? 'li' : 'div')
        itemElement.className = 'qu-list-item'
        itemElement.appendChild(templateFragment)
      }
    } else {
      itemElement = document.createElement(this._listTag === 'ol' || this._listTag === 'ul' ? 'li' : 'div')
      itemElement.className = 'qu-list-item'
    }

    itemElement.dataset.quKey = qubit.key

    if (this._isSortable) {
      itemElement.draggable = true
      itemElement.classList.add('qu-sortable')
    }

    this._updateItemElement(itemElement, qubit)
    if (!this._itemTemplate) this._appendActionButtons(itemElement, qubit)

    return itemElement
  }

  _updateItemElement(itemElement, qubit) {
    if (this._itemTemplate) {
      applyTemplateBindingsToNode(itemElement, createTemplateBindingContext(qubit, qubit?.data ?? qubit, qubit.key))
    }

    itemElement.querySelectorAll('[data-qu-text]').forEach((textElement) => {
      const fieldPath = textElement.dataset.quText
      const resolvedValue = _resolveField(qubit, fieldPath)
      if (resolvedValue != null) textElement.textContent = String(resolvedValue)
    })

    itemElement.querySelectorAll('[data-qu-field]').forEach((fieldElement) => {
      const [fieldPath, targetAttribute = 'textContent'] = fieldElement.dataset.quField.split(':')
      const resolvedValue = _resolveField(qubit, fieldPath)
      if (resolvedValue != null) {
        if (targetAttribute === 'textContent') fieldElement.textContent = String(resolvedValue)
        else fieldElement.setAttribute(targetAttribute, String(resolvedValue))
      }
    })

    if (SYNC_CSS_CLASS[qubit._status]) {
      Object.values(SYNC_CSS_CLASS).forEach((cssClassName) => itemElement.classList.remove(cssClassName))
      itemElement.classList.add(SYNC_CSS_CLASS[qubit._status])
    }
  }

  _appendActionButtons(itemEl, qubit) {
    if (!this._isEditable && !this._isDeletable) return

    const actionsEl = document.createElement('span')
    actionsEl.className = 'qu-item-actions'

    if (this._isEditable) {
      const editBtn = document.createElement('button')
      editBtn.className       = 'qu-btn-edit'
      editBtn.dataset.quAction = 'edit'
      editBtn.textContent     = '✏️'
      editBtn.setAttribute('aria-label', 'Bearbeiten')
      actionsEl.appendChild(editBtn)
    }

    if (this._isDeletable) {
      const deleteBtn = document.createElement('button')
      deleteBtn.className        = 'qu-btn-delete'
      deleteBtn.dataset.quAction = 'delete'
      deleteBtn.textContent      = '🗑️'
      deleteBtn.setAttribute('aria-label', 'Delete')
      actionsEl.appendChild(deleteBtn)
    }

    itemEl.appendChild(actionsEl)
  }

  async _handleDelete(qubitKey) {
    if (!_globalDb) return
    // Custom Event feuern — App kann default verhindern
    const confirmed = this.dispatchEvent(new CustomEvent('qu-before-delete', {
      detail: { key: qubitKey }, bubbles: true, cancelable: true
    }))
    if (!confirmed) return
    await _globalDb.del(qubitKey)
    /*DEBUG*/ console.debug('[QuRay:qu-list] removed item:', qubitKey)
  }

  _handleEditStart(itemEl, qubitKey) {
    // Inline-Edit: erstes [data-qu-text] Element wird editierbar
    const textEl = itemEl.querySelector('[data-qu-text]')
    if (!textEl) return

    const originalText = textEl.textContent
    textEl.contentEditable = 'true'
    textEl.focus()

    const finishEdit = async () => {
      textEl.contentEditable = 'false'
      textEl.removeEventListener('blur', finishEdit)
      textEl.removeEventListener('keydown', keyHandler)

      const newText   = textEl.textContent.trim()
      if (newText === originalText) return

      const fieldPath = textEl.dataset.quText ?? 'data'
      const qubit     = await _globalDb?.get(qubitKey)
      if (!qubit) return

      const updatedData = _setField({ ...qubit.data }, fieldPath.replace(/^data\.?/, ''), newText)
      await _globalDb?.put(qubitKey, updatedData, { type: qubit.type, sync: true })
    }

    const keyHandler = (event) => {
      if (event.key === 'Enter')  { event.preventDefault(); textEl.blur() }
      if (event.key === 'Escape') { textEl.textContent = originalText; textEl.blur() }
    }

    textEl.addEventListener('blur',    finishEdit)
    textEl.addEventListener('keydown', keyHandler)
  }

  _renderAddButton() {
    const addContainer = document.createElement('div')
    addContainer.className = 'qu-add-container'

    const addInput = document.createElement('input')
    addInput.type        = 'text'
    addInput.className   = 'qu-add-input'
    addInput.placeholder = this._addPlaceholder

    const addBtn = document.createElement('button')
    addBtn.className   = 'qu-add-btn'
    addBtn.textContent = '+'
    addBtn.setAttribute('aria-label', 'Add item')

    const submitNew = async () => {
      const text = addInput.value.trim()
      if (!text || !_globalDb) return

      const ts    = Date.now()
      const newId = crypto.randomUUID()
      const key   = this._prefix + ts + '-' + newId

      // Compute the next order value for fractional indexing at the end of the list.
      const existingItems = await _globalDb.query(this._prefix, { order: 'data.order' })
      const lastOrder     = existingItems.length > 0
        ? (existingItems.at(-1).data?.order ?? existingItems.length)
        : 0
      const newOrder = lastOrder + 1.0

      await _globalDb.put(key, { text, order: newOrder }, {
        type:  'item',
        sync:  true,
        order: newOrder,
      })

      addInput.value = ''
      addInput.focus()

      this.dispatchEvent(new CustomEvent('qu-item-added', {
        detail: { key }, bubbles: true
      }))
    }

    addBtn.addEventListener('click', submitNew)
    addInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitNew()
    })

    addContainer.appendChild(addInput)
    addContainer.appendChild(addBtn)
    this.appendChild(addContainer)
  }

  // Drag-and-Drop Sortierung (Fractional Indexing)
  _initDragAndDrop() {
    let _draggedEl = null

    this._listEl.addEventListener('dragstart', (event) => {
      _draggedEl = event.target.closest('[data-qu-key]')
      if (_draggedEl) _draggedEl.classList.add('qu-dragging')
    })

    this._listEl.addEventListener('dragend', () => {
      _draggedEl?.classList.remove('qu-dragging')
      _draggedEl = null
      this._listEl.querySelectorAll('.qu-drag-over').forEach(el => el.classList.remove('qu-drag-over'))
    })

    this._listEl.addEventListener('dragover', (event) => {
      event.preventDefault()
      const targetEl = event.target.closest('[data-qu-key]')
      if (!targetEl || targetEl === _draggedEl) return
      targetEl.classList.add('qu-drag-over')
    })

    this._listEl.addEventListener('dragleave', (event) => {
      event.target.closest('[data-qu-key]')?.classList.remove('qu-drag-over')
    })

    this._listEl.addEventListener('drop', async (event) => {
      event.preventDefault()
      const targetEl = event.target.closest('[data-qu-key]')
      if (!targetEl || !_draggedEl || targetEl === _draggedEl) return
      targetEl.classList.remove('qu-drag-over')

      await this._reorderItems(_draggedEl.dataset.quKey, targetEl.dataset.quKey)
    })
  }

  // Reorder one item before or after another item.
  async _reorderItems(draggedKey, targetKey) {
    if (!_globalDb) return

    const allItems   = await _globalDb.query(this._prefix, { order: 'data.order' })
    const targetItem = allItems.find(q => q.key === targetKey)
    const targetIdx  = allItems.findIndex(q => q.key === targetKey)

    if (!targetItem) return

    // Compute a new order value between the neighbour items.
    const prevItem   = allItems[targetIdx - 1]
    const prevOrder  = prevItem?.data?.order ?? 0
    const targetOrder = targetItem.data?.order ?? targetIdx
    const newOrder   = (prevOrder + targetOrder) / 2

    const draggedItem = allItems.find(q => q.key === draggedKey)
    if (!draggedItem) return

    const updatedData = { ...(draggedItem.data ?? {}), order: newOrder }
    await _globalDb.put(draggedKey, updatedData, { type: draggedItem.type, sync: true, order: newOrder })

    this.dispatchEvent(new CustomEvent('qu-reordered', {
      detail: { key: draggedKey, newOrder }, bubbles: true
    }))

    /*DEBUG*/ console.debug('[QuRay:qu-list] reorder:', draggedKey.slice(-16), '→ order:', newOrder)
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE HILFSFUNKTIONEN
// ─────────────────────────────────────────────────────────────────────────────

// Dot-Notation Feld aus Objekt lesen: 'data.text' → obj.data.text
function _resolveField(objectValue, dotPath) {
  if (!dotPath || !objectValue) return null
  const resolvedValue = readNestedValue(objectValue, dotPath)
  return resolvedValue === undefined ? null : resolvedValue
}

function _setField(objectValue, dotPath, nextValue) {
  if (!dotPath) return objectValue
  return writeNestedValue(objectValue, dotPath, nextValue)
}

// Slot-Templates aus innerHTML parsen
const _parseSlots = (element) => {
  const slots = {}
  element.querySelectorAll('template[slot]').forEach(tmpl => {
    slots[tmpl.getAttribute('slot')] = tmpl.content.cloneNode(true)
  })
  return slots
}

// Hash aus blob.meta-Key extrahieren
const _extractHashFromKey = (key) => {
  const parts = key.split('/')
  return parts.at(-1) ?? key
}

// MIME-Kategorie ermitteln
const _getMimeCategory = (mimeType) => {
  if (!mimeType) return 'file'
  if (mimeType.startsWith('image/'))  return 'image'
  if (mimeType.startsWith('video/'))  return 'video'
  if (mimeType.startsWith('audio/'))  return 'audio'
  return 'file'
}

// MIME icon lookup (Unicode, no external font required).
const _mimeIcon = (mimeType) => {
  const category = _getMimeCategory(mimeType)
  if (category === 'image') return '🖼️'
  if (category === 'video') return '🎬'
  if (category === 'audio') return '🎵'
  if (mimeType === 'application/pdf') return '📄'
  if (mimeType?.includes('zip') || mimeType?.includes('archive')) return '📦'
  return '📎'
}

// Bytes formatieren
const _formatBytes = (bytes) => {
  if (bytes < 1024)                  return `${bytes} B`
  if (bytes < 1024 * 1024)          return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}


// ─────────────────────────────────────────────────────────────────────────────
// REGISTRIERUNG
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// <qu-avatar> — Reaktiver Avatar-Circle
//
// Attribute:
//   pub="MFkw..."     Peer-pub64 — lädt alias + avatar reaktiv
//   size="32"         Breite/Höhe in px, default 32
//   shape="circle|square|round"  default circle
//   me                Boolean — für eigenen User (me.pub)
//
// Beispiel:
//   <qu-avatar pub="MFkw..." size="40"></qu-avatar>
// ─────────────────────────────────────────────────────────────────────────────
// ════════════════════════════════ PEER ══════════════════════════════════════
class QuAvatar extends QuElement {
  _quInit() {
    this._pub  = this._attr('pub')
    this._size = parseInt(this._attr('size', '32'))
    const shape = this._attr('shape', 'circle')
    const r = shape === 'circle' ? '50%' : shape === 'round' ? '8px' : '4px'

    Object.assign(this.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: this._size + 'px', height: this._size + 'px',
      borderRadius: r, overflow: 'hidden', flexShrink: '0',
      background: 'var(--qu-av-bg, #2a2a38)',
      border: '1px solid var(--qu-av-bd, rgba(255,255,255,.1))',
      fontSize: Math.round(this._size * .4) + 'px',
      fontFamily: 'var(--mono, monospace)',
      color: 'var(--qu-av-fg, #8888a8)',
      userSelect: 'none',
    })

    this._render = (alias, avatarB64) => {
      if (avatarB64) {
        this.innerHTML = `<img src="${avatarB64}" alt="" style="width:100%;height:100%;object-fit:cover">`
      } else {
        this.textContent = (alias || this._pub || '?')[0]?.toUpperCase() ?? '?'
        this.style.background = this._pubColor(alias || this._pub || '')
      }
    }

    if (!this._pub) return
    // Load via DB sub-key watch
    this._loadPeer()
    this._subscribe(`~${this._pub}/**`, () => this._loadPeer())
  }

  _pubColor(seed) {
    let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xfffff
    return `hsl(${h % 360}, 35%, 20%)`
  }

  async _loadPeer() {
    const [aliasQ, avatarQ] = await Promise.all([
      _globalDb?.get(`~${this._pub}/alias`),
      _globalDb?.get(`~${this._pub}/avatar`),
    ])
    this._render(aliasQ?.data ?? this._pub?.slice(0, 6), avatarQ?.data ?? null)
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-peer> — Peer-Karte: Avatar + Alias + Online-Dot
//
// Attribute:
//   pub="MFkw..."     Peer-pub64
//   size="avatar-size in px, default 28"
//   compact           Kein Name, nur Avatar + Dot
//   clickable         Cursor pointer + qu-peer-click Event
//
// Beispiel:
//   <qu-peer pub="MFkw..." clickable></qu-peer>
// ─────────────────────────────────────────────────────────────────────────────
class QuPeer extends QuElement {
  _quInit() {
    this._pub     = this._attr('pub')
    const size    = parseInt(this._attr('size', '28'))
    const compact = this._boolAttr('compact')

    this.style.display = 'inline-flex'
    this.style.alignItems = 'center'
    this.style.gap = '7px'
    if (this._boolAttr('clickable')) {
      this.style.cursor = 'pointer'
      this.addEventListener('click', () =>
        this.dispatchEvent(new CustomEvent('qu-peer-click', { detail: { pub: this._pub }, bubbles: true }))
      )
    }

    const av = document.createElement('qu-avatar')
    av.setAttribute('pub', this._pub)
    av.setAttribute('size', String(size))
    av.style.position = 'relative'
    this._av = av

    // Online dot
    this._dot = Object.assign(document.createElement('span'), {
      style: `width:8px;height:8px;border-radius:50%;background:var(--sub,#555);
              position:absolute;bottom:-1px;right:-1px;border:2px solid var(--bg,#0a0a0f)`,
    })
    av.appendChild(this._dot)

    this.appendChild(av)

    if (!compact) {
      this._label = Object.assign(document.createElement('span'), {
        style: 'font:13px var(--sans,system-ui);color:var(--tx,#e8e8f0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
      })
      this.appendChild(this._label)
    }

    if (!this._pub) return
    this._subscribe(`~${this._pub}/**`, () => this._update())
    this._subscribe(`sys/peers/${this._pub}`, (v) => {
      this._dot.style.background = v ? 'var(--green,#4ade80)' : 'var(--sub,#555)'
    })
    this._update()
  }

  async _update() {
    const q = await _globalDb?.get(`~${this._pub}/alias`)
    const alias = q?.data ?? this._pub?.slice(0, 10) + '…'
    if (this._label) this._label.textContent = alias
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-field> — Inline-editierbares Feld mit DB-Anbindung
//
// Attribute:
//   key="~pub/alias"    Vollständiger DB-Key
//   field="alias"       Zusammen mit pub= für KEY.user(pub).field(field)
//   pub="MFkw..."       Peer-pub64 (kombiniert mit field=)
//   type="text|number|email|url|textarea"  default text
//   placeholder="..."
//   readonly            Kein Editieren
//   label="Alias"       Optional: Label davor
//
// Beispiel:
//   <qu-field pub="MFkw..." field="alias" placeholder="Kein Alias"></qu-field>
//   <qu-field key="@room/~meta:name" type="text"></qu-field>
//
// Events:
//   qu-field-save  { detail: { key, value } }
// ─────────────────────────────────────────────────────────────────────────────
class QuField extends QuElement {
  _quInit() {
    this._key      = this._attr('key')
    const pub      = this._attr('pub')
    const field    = this._attr('field')
    if (!this._key && pub && field) this._key = `~${pub}/${field}`
    if (!this._key) return

    const type    = this._attr('type', 'text')
    const ro      = this._boolAttr('readonly')
    const ph      = this._attr('placeholder', '')
    const label   = this._attr('label')

    this.style.display = 'inline-flex'
    this.style.alignItems = 'center'
    this.style.gap = '6px'

    if (label) {
      const lbl = Object.assign(document.createElement('span'), {
        textContent: label,
        style: 'font:11px var(--mono,monospace);color:var(--sub,#555);flex-shrink:0',
      })
      this.appendChild(lbl)
    }

    const isArea = type === 'textarea'
    this._input = document.createElement(isArea ? 'textarea' : 'input')
    if (!isArea) this._input.type = type
    this._input.placeholder = ph
    this._input.readOnly = ro
    Object.assign(this._input.style, {
      background: 'var(--qu-field-bg, transparent)',
      border: 'none',
      borderBottom: '1px solid var(--qu-field-bd, transparent)',
      outline: 'none',
      color: 'var(--tx, #e8e8f0)',
      font: '13px inherit',
      padding: '2px 4px',
      width: '100%',
      transition: 'border-color .15s',
    })
    this._input.addEventListener('focus', () =>
      this._input.style.borderBottomColor = 'var(--amber, #f5a623)')
    this._input.addEventListener('blur',  () => {
      this._input.style.borderBottomColor = 'transparent'
      this._save()
    })
    this._input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !isArea) { e.preventDefault(); this._save(); this._input.blur() }
      if (e.key === 'Escape') { this._load(); this._input.blur() }
    })
    this.appendChild(this._input)

    // Load + reactive
    this._load()
    this._subscribe(this._key, () => this._load())
  }

  async _load() {
    const q = await _globalDb?.get(this._key)
    const v = q?.data ?? q
    this._input.value = v != null ? String(v) : ''
    this._savedValue = this._input.value
  }

  async _save() {
    const val = this._input.value.trim()
    if (val === this._savedValue) return  // no change
    this._savedValue = val
    if (_globalDb) {
      await _globalDb.put(this._key, val || null)
      this.dispatchEvent(new CustomEvent('qu-field-save', {
        detail: { key: this._key, value: val }, bubbles: true
      }))
      // Flash saved indicator
      this._input.style.borderBottomColor = 'var(--green, #4ade80)'
      setTimeout(() => { this._input.style.borderBottomColor = 'transparent' }, 1000)
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-status> — Relay/Peer Online-Status-Anzeige
//
// Attribute:
//   pub="MFkw..."    Peer-Online-Status (optional, leer = Relay-Status)
//   show-label       Boolean — Text neben Dot anzeigen
//   online-label="Online"   default "Online"
//   offline-label="Offline" default "Offline"
//   size="8"         Dot-Größe in px
//
// Beispiel:
//   <qu-status show-label></qu-status>                  ← Relay-Status
//   <qu-status pub="MFkw..." show-label></qu-status>    ← Peer-Status
// ─────────────────────────────────────────────────────────────────────────────
class QuStatus extends QuElement {
  _quInit() {
    this._pub       = this._attr('pub')     // null = relay status
    const showLabel = this._boolAttr('show-label')
    const onLbl     = this._attr('online-label', 'Online')
    const offLbl    = this._attr('offline-label', 'Offline')
    const dotSize   = parseInt(this._attr('size', '8'))

    this.style.display = 'inline-flex'
    this.style.alignItems = 'center'
    this.style.gap = '5px'

    this._dot = Object.assign(document.createElement('span'), {
      style: `display:inline-block;width:${dotSize}px;height:${dotSize}px;border-radius:50%;
              background:var(--sub,#555);transition:background .3s,box-shadow .3s`,
    })
    this.appendChild(this._dot)

    if (showLabel) {
      this._lbl = Object.assign(document.createElement('span'), {
        style: 'font:11px var(--sans,system-ui);color:var(--mu,#8888a8)',
        textContent: offLbl,
      })
      this.appendChild(this._lbl)
    }

    this._setOnline = (online) => {
      this._dot.style.background = online ? 'var(--green,#4ade80)' : 'var(--sub,#555)'
      this._dot.style.boxShadow  = online ? '0 0 5px rgba(74,222,128,.5)' : 'none'
      if (this._lbl) this._lbl.textContent = online ? onLbl : offLbl
    }

    if (this._pub) {
      // Subscribe to sys/peers/{pub} — fires on peer.hello (put) and peer.bye (del)
      // v is the full QuBit object on put, null on del
      this._subscribe(`sys/peers/${this._pub}`, (v) => {
        // v = QuBit on put (data contains peer info), null on del
        this._setOnline(v !== null && v !== undefined)
      })
      // Initial load: check if peer is currently online
      _globalDb?.get(`sys/peers/${this._pub}`).then(q => this._setOnline(q !== null))
    } else {
      // Relay status — use _globalNet if available, else try _qurayInstance
      const net = _globalNet ?? window._qurayInstance?._.net
      if (net?.state$) {
        this._watch(net.state$, states => {
          this._setOnline(Object.values(states || {}).some(s => s === 'connected'))
        })
        // callNow: check immediately
        const cur = net.state$.get?.()
        if (cur) this._setOnline(Object.values(cur).some(s => s === 'connected'))
      }
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-delivery> — Nachrichten-Zustellstatus als Tick-Anzeige
//
// Attribute:
//   msg-key="@space/chat/ts-id"   QuBit-Key dessen Delivery-Status angezeigt wird
//
// Tick-Mapping:
//   local     → ○     queued → ⏳     relay_in → ✓
//   peer_sent → ✓✓   peer_recv → ✓✓  peer_read → ✓✓✓  failed → ✗
//
// Beispiel:
//   <qu-delivery msg-key="@room1/chat/0000001-abc"></qu-delivery>
// ─────────────────────────────────────────────────────────────────────────────
// ════════════════════════════════ CHAT ══════════════════════════════════════
class QuDelivery extends QuElement {
  _quInit() {
    this._msgKey = this._attr('msg-key')
    if (!this._msgKey) return

    Object.assign(this.style, {
      display: 'inline-block', fontSize: '11px',
      color: 'var(--sub,#555)', transition: 'color .3s',
      fontFamily: 'var(--sans,system-ui)',
    })

    const TICKS = {
      local: '○', queued: '⏳', relay_in: '✓',
      peer_sent: '✓✓', peer_recv: '✓✓', peer_read: '✓✓✓',
      blob_local: '📱', blob_relay: '☁', failed: '✗',
    }

    this._render = (state) => {
      this.textContent = TICKS[state] ?? '○'
      this.title = state ?? 'unbekannt'
      this.style.color = state === 'peer_read' ? 'var(--blue,#60a5fa)'
                       : state === 'failed'    ? 'var(--red,#f87171)'
                       : state === 'relay_in'  ? 'var(--green,#4ade80)'
                       : 'var(--sub,#555)'
    }

    this._render(null)

    // Reactive via db.delivery.on() — rawWrite bypasses EventBus, must use delivery API
    if (_globalDb?.delivery) {
      const off = _globalDb.delivery.on(this._msgKey, entry => this._render(entry?.state ?? null))
      this._offFns.push(off)
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-grid> — Reaktives Daten-Grid/Tabelle mit Sort, Filter, Live-Updates
//
// Attribute:
//   prefix="@space/todos/"       DB-Prefix — alle QuBits darunter
//   columns="key,type,ts,data"   Sichtbare Spalten, kommasepariert
//   sortable                     Spalten-Header klickbar zum Sortieren
//   filterable                   Suchfeld oberhalb
//   editable                     Inline-Edit via Doppelklick
//   deletable                    Löschen-Button in Zeile
//   limit="100"                  Max. angezeigte Zeilen
//   flash-duration="600"         Flash-Dauer bei Änderung in ms
//
// Events:
//   qu-grid-select  { detail: { qubit } }   Zeile angeklickt
//   qu-grid-edit    { detail: { key, data } }  Wert editiert
//   qu-grid-delete  { detail: { key } }     Gelöscht
//
// Beispiel:
//   <qu-grid prefix="@room/todos/" sortable filterable deletable columns="key,data,ts">
//   </qu-grid>
// ─────────────────────────────────────────────────────────────────────────────
class QuGrid extends QuElement {
  _quInit() {
    this._prefix    = this._attr('prefix', '')
    this._columns   = this._attr('columns', 'key,data,type,ts').split(',').map(s => s.trim())
    this._sortable  = this._boolAttr('sortable')
    this._filterable= this._boolAttr('filterable')
    this._editable  = this._boolAttr('editable')
    this._deletable = this._boolAttr('deletable')
    this._limit     = parseInt(this._attr('limit', '200'))
    this._flashMs   = parseInt(this._attr('flash-duration', '600'))

    this._sortCol = 'ts'; this._sortDir = -1   // desc by default
    this._filterQ = ''
    this._rows    = []

    this._build()
    this._load()

    if (this._prefix) {
      this._subscribe(this._prefix + '**', (qubit, ctx) => {
        this._onDbChange(qubit, ctx)
      })
    }
  }

  _build() {
    // Inject minimal CSS once
    if (!document.getElementById('qu-grid-css')) {
      const s = document.createElement('style')
      s.id = 'qu-grid-css'
      s.textContent = `
        qu-grid { display: flex; flex-direction: column; overflow: hidden }
        .qu-grid-filter { display: flex; gap: 6px; padding: 6px 0; flex-shrink: 0 }
        .qu-grid-filter input { flex: 1; background: var(--qu-grid-bg, var(--s2,#18181f));
          border: 1px solid var(--qu-grid-bd, var(--bd,#2a2a38)); border-radius: 6px;
          padding: 5px 10px; color: var(--tx,#e8e8f0); font: 12px var(--mono,monospace); outline: none }
        .qu-grid-filter input:focus { border-color: var(--amber,#f5a623) }
        .qu-grid-wrap { flex: 1; overflow-y: auto }
        .qu-grid-table { width: 100%; border-collapse: collapse; font: 11px var(--mono,monospace) }
        .qu-grid-table th { padding: 6px 10px; text-align: left;
          background: var(--qu-grid-hd-bg, var(--s1,#111118));
          color: var(--sub,#555); font: 10px var(--mono,monospace); font-weight: 700;
          letter-spacing: .08em; text-transform: uppercase;
          border-bottom: 1px solid var(--qu-grid-bd, var(--bd,#2a2a38));
          position: sticky; top: 0; z-index: 1 }
        .qu-grid-table th.sortable { cursor: pointer; user-select: none }
        .qu-grid-table th.sortable:hover { color: var(--tx,#e8e8f0) }
        .qu-grid-table th.sorted { color: var(--amber,#f5a623) }
        .qu-grid-table td { padding: 5px 10px; border-bottom: 1px solid var(--qu-grid-row-bd, var(--bd2,#222230));
          max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer }
        .qu-grid-table tr:hover td { background: var(--qu-grid-hover, var(--s2,#18181f)) }
        .qu-grid-table tr.qu-grid-sel td { background: rgba(245,166,35,.06) }
        .qu-grid-table tr.qu-grid-flash td { animation: qu-grid-flash var(--qu-grid-flash-ms,600ms) ease-out }
        .qu-grid-table tr.qu-grid-del td { animation: qu-grid-del 400ms ease-out forwards }
        @keyframes qu-grid-flash { 0%{background:rgba(74,222,128,.15)} 100%{background:transparent} }
        @keyframes qu-grid-del   { 0%{background:rgba(248,113,113,.15);opacity:1} 100%{opacity:0} }
        .qu-grid-col-key { color: var(--blue,#60a5fa) }
        .qu-grid-col-data { color: var(--tx,#e8e8f0); opacity: .8 }
        .qu-grid-col-type { color: var(--sub,#555) }
        .qu-grid-col-ts { color: var(--sub,#555) }
        .qu-grid-del-btn { padding: 2px 6px; background: none; border: none;
          color: var(--sub,#555); cursor: pointer; border-radius: 4px; font: 11px inherit }
        .qu-grid-del-btn:hover { color: var(--red,#f87171); background: rgba(248,113,113,.1) }
        .qu-grid-count { font: 10px var(--mono,monospace); color: var(--sub,#555); padding: 4px 0; flex-shrink: 0 }
      `
      document.head.appendChild(s)
    }

    this.style.cssText += '; display: flex; flex-direction: column; overflow: hidden'
    this.innerHTML = ''

    if (this._filterable) {
      const bar = document.createElement('div')
      bar.className = 'qu-grid-filter'
      this._filterInput = Object.assign(document.createElement('input'), {
        placeholder: 'Suche…', type: 'text',
      })
      this._filterInput.addEventListener('input', e => {
        this._filterQ = e.target.value.toLowerCase()
        this._render()
      })
      bar.appendChild(this._filterInput)
      this.appendChild(bar)
    }

    this._countEl = Object.assign(document.createElement('div'), { className: 'qu-grid-count' })
    this.appendChild(this._countEl)

    this._wrap = Object.assign(document.createElement('div'), { className: 'qu-grid-wrap' })
    this._table = Object.assign(document.createElement('table'), { className: 'qu-grid-table' })
    this._thead = document.createElement('thead')
    this._tbody = document.createElement('tbody')
    this._table.append(this._thead, this._tbody)
    this._wrap.appendChild(this._table)
    this.appendChild(this._wrap)

    this._buildHeader()
  }

  _buildHeader() {
    this._thead.innerHTML = ''
    const tr = document.createElement('tr')
    for (const col of this._columns) {
      const th = document.createElement('th')
      th.textContent = col
      if (this._sortable) {
        th.className = 'sortable' + (col === this._sortCol ? ' sorted' : '')
        th.addEventListener('click', () => {
          if (this._sortCol === col) this._sortDir *= -1
          else { this._sortCol = col; this._sortDir = -1 }
          this._buildHeader()
          this._render()
        })
      }
      tr.appendChild(th)
    }
    if (this._deletable) {
      const th = document.createElement('th'); th.style.width = '30px'; tr.appendChild(th)
    }
    this._thead.appendChild(tr)
  }

  async _load() {
    this._rows = await _globalDb?.query(this._prefix).catch(() => []) ?? []
    this._render()
  }

  _getColVal(q, col) {
    if (col === 'key')  return q.key ?? ''
    if (col === 'type') return q.type ?? 'data'
    if (col === 'ts')   return q.ts   ? new Date(q.ts).toLocaleTimeString('de-DE', {hour12:false}) : '–'
    if (col === 'id')   return q.id?.slice(0, 8) ?? ''
    if (col === 'from') return q.from?.slice(0, 12) + '…' ?? ''
    if (col === 'data') {
      const d = q.data
      if (d === null) return 'null'
      if (d?.ct)  return '🔒 enc'
      return typeof d === 'object' ? JSON.stringify(d).slice(0, 80) : String(d ?? '').slice(0, 80)
    }
    return String(q.data?.[col] ?? q[col] ?? '').slice(0, 80)
  }

  _filtered() {
    let rows = [...this._rows]
    if (this._filterQ) {
      rows = rows.filter(q =>
        (q.key ?? '').toLowerCase().includes(this._filterQ) ||
        JSON.stringify(q.data).toLowerCase().includes(this._filterQ)
      )
    }
    rows.sort((a, b) => {
      const av = this._getColVal(a, this._sortCol)
      const bv = this._getColVal(b, this._sortCol)
      return av < bv ? this._sortDir : av > bv ? -this._sortDir : 0
    })
    return rows.slice(0, this._limit)
  }

  _render(flashKey) {
    const rows = this._filtered()
    this._countEl.textContent = `${rows.length} entries${this._filterQ ? ' (filtered)' : ''}`

    const tbody = this._tbody
    tbody.innerHTML = ''
    for (const q of rows) {
      const tr = document.createElement('tr')
      tr.dataset.key = q.key
      if (this._selKey === q.key) tr.classList.add('qu-grid-sel')
      if (flashKey === q.key) {
        tr.classList.add('qu-grid-flash')
        tr.style.setProperty('--qu-grid-flash-ms', this._flashMs + 'ms')
      }
      for (const col of this._columns) {
        const td = document.createElement('td')
        td.className = `qu-grid-col-${col}`
        td.textContent = this._getColVal(q, col)
        td.title = this._getColVal(q, col)
        if (this._editable && col === 'data') {
          td.addEventListener('dblclick', () => this._startEdit(td, q))
        }
        tr.appendChild(td)
      }
      if (this._deletable) {
        const td = document.createElement('td')
        const btn = Object.assign(document.createElement('button'), {
          className: 'qu-grid-del-btn', textContent: '✕', title: 'Delete',
        })
        btn.addEventListener('click', e => { e.stopPropagation(); this._delete(q.key, tr) })
        td.appendChild(btn); tr.appendChild(td)
      }
      tr.addEventListener('click', () => {
        this._tbody.querySelectorAll('tr').forEach(r => r.classList.remove('qu-grid-sel'))
        tr.classList.add('qu-grid-sel')
        this._selKey = q.key
        this.dispatchEvent(new CustomEvent('qu-grid-select', { detail: { qubit: q }, bubbles: true }))
      })
      tbody.appendChild(tr)
    }
  }

  _startEdit(td, q) {
    const orig = td.textContent
    const input = Object.assign(document.createElement('input'), {
      value: typeof q.data === 'string' ? q.data : JSON.stringify(q.data),
      style: 'width:100%;background:var(--s3,#1e1e28);border:1px solid var(--amber,#f5a623);border-radius:3px;color:var(--tx,#e8e8f0);font:11px var(--mono,monospace);padding:2px 4px;outline:none',
    })
    td.textContent = ''
    td.appendChild(input)
    input.focus(); input.select()
    const commit = async () => {
      let val = input.value.trim()
      try { val = JSON.parse(val) } catch {}
      if (_globalDb && val !== q.data) {
        await _globalDb.put(q.key, val)
        this.dispatchEvent(new CustomEvent('qu-grid-edit', { detail: { key: q.key, data: val }, bubbles: true }))
      }
    }
    input.addEventListener('blur',    () => commit())
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur() }
      if (e.key === 'Escape') { td.textContent = orig }
    })
  }

  async _delete(key, tr) {
    tr.classList.add('qu-grid-del')
    await new Promise(r => setTimeout(r, 350))
    await _globalDb?.del(key)
    this.dispatchEvent(new CustomEvent('qu-grid-delete', { detail: { key }, bubbles: true }))
  }

  _onDbChange(qubit, ctx) {
    const key   = ctx?.key ?? qubit?.key
    const event = ctx?.event ?? 'put'
    if (!key?.startsWith(this._prefix)) return

    if (event === 'del') {
      this._rows = this._rows.filter(r => r.key !== key)
    } else {
      const i = this._rows.findIndex(r => r.key === key)
      if (i >= 0) this._rows[i] = qubit; else this._rows.unshift(qubit)
    }
    this._render(event !== 'del' ? key : null)
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// ATOMIC COMPONENTS — kleinste, wiederverwendbare Bausteine
// Jede Komponente macht genau eine Sache.
// Zusammensetzen → komplexere Komponenten wie qu-chat-msg, qu-user-profile usw.
// ═════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// <qu-dot> — Farbiger Status-Punkt
// Attribute: color="green|amber|red|blue|sub"  size="8"  pulse (boolean)
// ─────────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════ ATOMS ══════════════════════════════════════
class QuDot extends HTMLElement {
  connectedCallback() {
    const c = this.getAttribute('color') || 'sub'
    const s = parseInt(this.getAttribute('size') || '8')
    const p = this.hasAttribute('pulse')
    Object.assign(this.style, {
      display:'inline-block', width:s+'px', height:s+'px', borderRadius:'50%', flexShrink:'0',
      background: `var(--${c},var(--sub,#555))`,
      boxShadow: c !== 'sub' ? `0 0 ${s}px var(--${c},#555)` : 'none',
      animation: p ? 'qu-dot-pulse 1.5s ease-in-out infinite' : 'none',
    })
    if (p && !document.getElementById('qu-dot-style')) {
      const s2 = document.createElement('style')
      s2.id = 'qu-dot-style'
      s2.textContent = '@keyframes qu-dot-pulse{0%,100%{opacity:1}50%{opacity:.3}}'
      document.head.appendChild(s2)
    }
  }
  setColor(c) { this.style.background = `var(--${c},var(--sub,#555))` }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-badge> — Kleines Label / Zähler-Badge
// Attribute: value="5"  max="99"  color="amber|red|green|blue"  pill (bool)
// Beispiel: <qu-badge value="3" color="red"></qu-badge>
// ─────────────────────────────────────────────────────────────────────────────
class QuBadge extends HTMLElement {
  static get observedAttributes() { return ['value'] }
  connectedCallback() { this._render() }
  attributeChangedCallback() { this._render() }
  _render() {
    const raw = parseInt(this.getAttribute('value') || '0')
    const max = parseInt(this.getAttribute('max') || '99')
    const val = raw > max ? max + '+' : String(raw)
    const c   = this.getAttribute('color') || 'amber'
    const pill = this.hasAttribute('pill')
    Object.assign(this.style, {
      display: raw === 0 ? 'none' : 'inline-flex',
      alignItems: 'center', justifyContent: 'center',
      minWidth: pill ? 'auto' : '18px', height: '18px',
      padding: '0 5px', borderRadius: pill ? '100px' : '9px',
      font: 'bold 10px var(--mono,monospace)',
      background: `rgba(var(--${c}-rgb,245,166,35),.15)`,
      color: `var(--${c},#f5a623)`,
      border: `1px solid rgba(var(--${c}-rgb,245,166,35),.3)`,
    })
    this.textContent = val
  }
  set value(v) { this.setAttribute('value', String(v)) }
  get value()  { return parseInt(this.getAttribute('value') || '0') }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-counter> — Reaktiver Zähler: zählt QuBits unter einem Prefix
// Attribute: prefix="@space/todos/"  filter-field="done"  filter-value="false"
// Beispiel: <qu-counter prefix="@room/chat/"></qu-counter>
// ─────────────────────────────────────────────────────────────────────────────
class QuCounter extends QuElement {
  _quInit() {
    this._prefix  = this._attr('prefix', '')
    this._field   = this._attr('filter-field')
    this._fval    = this._attr('filter-value')
    Object.assign(this.style, { fontVariantNumeric: 'tabular-nums' })
    this._update()
    this._subscribe(this._prefix + '**', () => this._update())
  }
  async _update() {
    const rows = await _globalDb?.query(this._prefix).catch(() => []) ?? []
    const n = this._field
      ? rows.filter(q => String(q.data?.[this._field]) === this._fval).length
      : rows.length
    this.textContent = String(n)
    this.dispatchEvent(new CustomEvent('qu-count', { detail: { count: n }, bubbles: true }))
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-ts> — Formatierter Timestamp aus DB-Key
// Attribute: key="@space/msg/ts-id"  field="ts"  format="time|date|datetime|relative"
// Beispiel: <qu-ts key="@room/chat/001" format="time"></qu-ts>
// ─────────────────────────────────────────────────────────────────────────────
class QuTs extends QuElement {
  _quInit() {
    this._key    = this._attr('key')
    this._field  = this._attr('field', 'ts')
    this._fmt    = this._attr('format', 'time')
    this.style.fontVariantNumeric = 'tabular-nums'
    if (!this._key) return
    this._load()
    this._subscribe(this._key, q => this._render(q?.ts ?? q?.data?.ts))
  }
  async _load() {
    const q = await _globalDb?.get(this._key)
    this._render(q?.[this._field] ?? q?.data?.[this._field] ?? q?.ts)
  }
  _render(ts) {
    if (!ts) { this.textContent = '–'; return }
    const d = new Date(ts)
    this.title = d.toLocaleString('de')
    if (this._fmt === 'time')     this.textContent = d.toLocaleTimeString('de-DE',{hour12:false,hour:'2-digit',minute:'2-digit'})
    else if (this._fmt === 'date') this.textContent = d.toLocaleDateString('de-DE')
    else if (this._fmt === 'relative') this.textContent = _relTime(ts)
    else this.textContent = d.toLocaleString('de-DE',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
    if (this._fmt === 'relative') {
      clearInterval(this._interval)
      this._interval = setInterval(() => this._render(ts), 30_000)
    }
  }
  _quDestroy() { clearInterval(this._interval) }
}
function _relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60)    return 'gerade eben'
  if (s < 3600)  return Math.round(s/60) + 'm'
  if (s < 86400) return Math.round(s/3600) + 'h'
  return Math.round(s/86400) + 'd'
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-tick> — Zustellstatus-Tick (standalone, für Messaging)
// Attribute: state="local|queued|relay_in|peer_sent|peer_recv|peer_read|failed"
//   OR       msg-key="@space/chat/ts-id"  (reaktiv via delivery)
// ─────────────────────────────────────────────────────────────────────────────
class QuTick extends QuElement {
  static get observedAttributes() { return ['state'] }
  _quInit() {
    this._msgKey = this._attr('msg-key')
    this.style.cssText = 'display:inline-block;font:11px var(--sans,system-ui);transition:color .3s'
    if (this._msgKey) {
      // Use db.delivery.on() — delivery uses rawWrite, not EventBus
      if (_globalDb?.delivery) {
        const off = _globalDb.delivery.on(this._msgKey, entry => this._set(entry?.state))
        this._offFns.push(off)
      }
    } else {
      this._set(this.getAttribute('state'))
    }
  }
  attributeChangedCallback(_,__,val) { this._set(val) }
  _set(state) {
    // SVG tick icon helper
    const _tick = (n, col) => {
      // n=1 single check, n=2 double check, n=3 double-blue (read)
      const w = n >= 2 ? 18 : 10
      const svg = `<svg width="${w}" height="10" viewBox="0 0 ${w} 10" fill="none">
        ${n>=2?`<path d="M1 5l3 3L9 2" stroke="${col}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`:''}
        <path d="${n>=2?'M6 5l3 3 5-6':'M2 5l3 3 5-6'}" stroke="${col}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`
      return svg
    }
    const muted = 'var(--t3,#555)'
    const green = 'var(--grn,#4ade80)'
    const blue  = 'var(--blue,#60a5fa)'
    const red   = 'var(--red,#f87171)'
    const amber = 'var(--amber,#f5a623)'

    const SVG_MAP = {
      local:      `<span style="color:${muted}">○</span>`,
      queued:     `<span style="color:${muted}">⏳</span>`,
      relay_in:   _tick(1, green),
      peer_sent:  _tick(2, muted),
      peer_recv:  _tick(2, green),
      peer_read:  _tick(2, blue),
      blob_local: `<span style="color:${amber}" title="Saved locally">📱</span>`,
      blob_relay: `<span style="color:${green}" title="Synced to relay">☁</span>`,
      failed:     `<span style="color:${red}">✗</span>`,
    }
    this.innerHTML = SVG_MAP[state] ?? `<span style="color:${muted}">○</span>`
    this.title = {
      local:'Saved locally', queued:'Queued for send',
      relay_in:'Delivered to relay', peer_sent:'Delivered to device',
      peer_recv:'Received', peer_read:'Read',
      blob_local:'File saved locally', blob_relay:'File uploaded',
      failed:'Send failed'
    }[state] ?? (state ?? '')
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-enc-badge> — Verschlüsselungs-Indikator
// Attribute: encrypted (bool)  key="db-key" (reaktiv aus DB)
// ─────────────────────────────────────────────────────────────────────────────
class QuEncBadge extends QuElement {
  _quInit() {
    this._dbKey = this._attr('key')
    Object.assign(this.style, { display:'inline-block', fontSize:'12px', title:'Ende-zu-Ende verschlüsselt' })
    if (this._dbKey) {
      this._subscribe(this._dbKey, q => this._set(!!q?.data?.ct || !!q?.enc))
      _globalDb?.get(this._dbKey).then(q => this._set(!!q?.data?.ct || !!q?.enc))
    } else {
      this._set(this.hasAttribute('encrypted'))
    }
  }
  _set(enc) { this.textContent = enc ? '🔒' : ''; this.style.display = enc ? '' : 'none' }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-sync-state> — Sync-Status eines QuBits (lokal / relay / peer)
// Attribute: msg-key="@space/msg/id"  show-label  compact
// Zeigt: 📱 Lokal  ☁ Relay  ✓ Empfangen  👁 Gelesen
// ─────────────────────────────────────────────────────────────────────────────
class QuSyncState extends QuElement {
  _quInit() {
    this._key   = this._attr('msg-key')
    const show  = this._boolAttr('show-label')
    const cpt   = this._boolAttr('compact')
    this.style.display = 'inline-flex'
    this.style.alignItems = 'center'
    this.style.gap = '4px'

    this._dot = document.createElement('qu-dot')
    this._dot.setAttribute('size', cpt ? '6' : '8')
    this.appendChild(this._dot)

    if (show) {
      this._lbl = Object.assign(document.createElement('span'), {
        style: 'font:11px var(--sans,system-ui);color:var(--mu,#8888a8)',
      })
      this.appendChild(this._lbl)
    }

    const STATES = {
      local:     { color:'sub',   label:'Lokal' },
      queued:    { color:'amber', label:'Warteschlange' },
      relay_in:  { color:'green', label:'Relay' },
      peer_sent: { color:'blue',  label:'Gesendet' },
      peer_recv: { color:'blue',  label:'Empfangen' },
      peer_read: { color:'blue',  label:'Gelesen' },
      blob_local:{ color:'sub',   label:'Lokal (Blob)' },
      blob_relay:{ color:'green', label:'Relay (Blob)' },
      failed:    { color:'red',   label:'Fehler' },
    }

    this._set = (state) => {
      const s = STATES[state] ?? { color:'sub', label:'?' }
      this._dot.setAttribute('color', s.color)
      this._dot.setColor?.(s.color)
      if (this._lbl) this._lbl.textContent = s.label
      this.title = state ?? ''
    }

    if (this._key && _globalDb?.delivery) {
      const off = _globalDb.delivery.on(this._key, entry => this._set(entry?.state))
      this._offFns.push(off)
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-blob-thumb> — Blob Vorschau-Thumbnail (Bild, Video, Icon)
// Attribute: hash="abc123..."  mime="image/jpeg"  size="48"
// ─────────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════ BLOBS ══════════════════════════════════════
class QuBlobThumb extends QuElement {
  _quInit() {
    this._hash = this._attr('hash')
    this._mime = this._attr('mime', '')
    const s    = parseInt(this._attr('size', '48'))

    Object.assign(this.style, {
      display:'inline-flex', alignItems:'center', justifyContent:'center',
      width:s+'px', height:s+'px', borderRadius:'8px', overflow:'hidden',
      background:'var(--s3,#1e1e28)', border:'1px solid var(--bd,#2a2a38)',
      fontSize: Math.round(s*.4)+'px', flexShrink:'0', cursor:'pointer',
    })
    this.addEventListener('click', () => {
      const st = _globalDb?.blobs?.status(this._hash)
      if (st?.url) QuBlobThumb._openLightbox(st.url, mime, name)
      else _globalDb?.blobs?.load(this._hash)
    })

    this._showIcon()
    if (this._hash) {
      const existing = _globalDb?.blobs?.status(this._hash)
      if (existing?.url) {
        this._showMedia(existing.url)
      } else {
        // Show loading indicator
        this._showLoading()
        // Subscribe to status changes — fires when download completes
        const off = _globalDb?.blobs?.on(this._hash, state => {
          if (state?.url) { off?.(); this._showMedia(state.url) }
          else if (state?.status === 'error') { off?.(); this._showIcon() }
        })
        if (off) this._offFns.push(off)
        // Trigger download if not already in progress
        if (!existing || existing.status === 'pending') {
          _globalDb?.blobs?.load(this._hash)
        }
      }
    }
  }
  _showLoading() {
    this.innerHTML = ''
    const spinner = Object.assign(document.createElement('div'), {
      style: 'width:16px;height:16px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--amber,#f5a623);border-radius:50%;animation:qu-spin .8s linear infinite',
    })
    if (!document.getElementById('qu-spin-css')) {
      const s = document.createElement('style')
      s.id = 'qu-spin-css'
      s.textContent = '@keyframes qu-spin{to{transform:rotate(360deg)}}'
      document.head.appendChild(s)
    }
    this.appendChild(spinner)
  }

  _showIcon() {
    const m = this._mime
    this.textContent = m.startsWith('image/') ? '🖼'
                     : m.startsWith('video/') ? '🎬'
                     : m.startsWith('audio/') ? '🎵'
                     : m.includes('pdf')      ? '📄' : '📎'
  }
  _showMedia(url) {
    const m = this._mime
    const name = this._attr('name', '')
    this.innerHTML = ''
    if (m.startsWith('image/')) {
      const img = Object.assign(document.createElement('img'), { src: url })
      Object.assign(img.style, {
        width:'100%', height:'100%', objectFit:'cover', cursor:'zoom-in', display:'block',
      })
      img.addEventListener('click', e => { e.stopPropagation(); QuBlobThumb._openLightbox(url, m, name) })
      this.appendChild(img)
    } else if (m.startsWith('video/')) {
      // Thumbnail with play button overlay — click to open full player
      Object.assign(this.style, { cursor:'pointer', position:'relative' })
      const playBtn = Object.assign(document.createElement('div'), {
        style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);border-radius:inherit',
      })
      playBtn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg>'
      // Create a static poster via video element
      const v = Object.assign(document.createElement('video'), { src: url, muted: true, preload: 'metadata' })
      Object.assign(v.style, { width:'100%', height:'100%', objectFit:'cover', display:'block' })
      v.addEventListener('loadedmetadata', () => { v.currentTime = 0.5 })
      this.appendChild(v); this.appendChild(playBtn)
      this.addEventListener('click', () => QuBlobThumb._openLightbox(url, m, name))
    } else if (m.startsWith('audio/')) {
      Object.assign(this.style, { cursor:'pointer', position:'relative' })
      const iconEl = Object.assign(document.createElement('div'), {
        style: 'font-size:' + Math.round(this._size * .45) + 'px', textContent: '🎵',
      })
      const waveEl = Object.assign(document.createElement('div'), {
        style: 'position:absolute;bottom:4px;left:0;right:0;height:3px;display:flex;gap:1px;align-items:flex-end;padding:0 6px',
      })
      // Fake waveform bars for aesthetic
      for (let i = 0; i < 8; i++) {
        const bar = Object.assign(document.createElement('div'), {
          style: `flex:1;background:var(--amber,#f5a623);opacity:.6;border-radius:1px;height:${Math.round(2 + Math.random()*8)}px`,
        })
        waveEl.appendChild(bar)
      }
      this.appendChild(iconEl); this.appendChild(waveEl)
      this.addEventListener('click', () => QuBlobThumb._openLightbox(url, m, name))
    } else {
      this._showIcon()
    }
  }

  static _openLightbox(url, mime, name) {
    document.getElementById('qu-lightbox')?.remove()

    const lb = document.createElement('div')
    lb.id = 'qu-lightbox'
    lb.style.cssText = [
      'position:fixed;inset:0;z-index:9999',
      'background:rgba(0,0,0,.92)',
      'display:flex;flex-direction:column',
      'align-items:stretch',
      'animation:qu-lb-in .18s ease-out',
    ].join(';')

    // Inject lightbox CSS once
    if (!document.getElementById('qu-lightbox-css')) {
      const s = document.createElement('style')
      s.id = 'qu-lightbox-css'
      s.textContent = `
        @keyframes qu-lb-in { from{opacity:0;transform:scale(.96)} to{opacity:1;transform:scale(1)} }
        #qu-lightbox { font-family:var(--sans,'system-ui') }
        .qu-lb-bar { display:flex;align-items:center;gap:8px;padding:10px 16px;
          background:rgba(0,0,0,.6);backdrop-filter:blur(8px);flex-shrink:0;z-index:1 }
        .qu-lb-title { flex:1;color:rgba(255,255,255,.7);font:12px var(--mono,monospace);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
        .qu-lb-btn { background:none;border:1px solid rgba(255,255,255,.2);border-radius:7px;
          color:#fff;padding:4px 10px;font:12px inherit;cursor:pointer;transition:border-color .15s }
        .qu-lb-btn:hover { border-color:var(--amber,#f5a623);color:var(--amber,#f5a623) }
        .qu-lb-body { flex:1;display:flex;align-items:center;justify-content:center;
          overflow:hidden;padding:16px;min-height:0 }
        .qu-lb-close { background:none;border:none;color:rgba(255,255,255,.7);
          font:20px inherit;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0 }
        .qu-lb-close:hover { color:#fff }
        .qu-lb-img { max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;
          cursor:default;box-shadow:0 8px 40px rgba(0,0,0,.5) }
        .qu-lb-video { max-width:100%;max-height:100%;border-radius:8px;
          box-shadow:0 8px 40px rgba(0,0,0,.5);background:#000 }
        .qu-lb-audio-wrap { display:flex;flex-direction:column;align-items:center;
          gap:20px;padding:40px;background:rgba(255,255,255,.04);border-radius:16px;
          border:1px solid rgba(255,255,255,.08);min-width:280px }
        .qu-lb-audio-icon { font-size:72px;line-height:1 }
        .qu-lb-audio-name { color:rgba(255,255,255,.6);font:13px inherit;text-align:center;
          max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
        .qu-lb-audio { width:260px;accent-color:var(--amber,#f5a623) }
        .qu-lb-fs-btn { padding:4px 10px;gap:6px;display:flex;align-items:center }
      `
      document.head.appendChild(s)
    }

    // Bar
    const bar = document.createElement('div')
    bar.className = 'qu-lb-bar'
    const title = Object.assign(document.createElement('div'), { className: 'qu-lb-title', textContent: name || mime })
    bar.appendChild(title)

    // Fullscreen button (for images/video)
    if (mime.startsWith('image/') || mime.startsWith('video/')) {
      const fsBtn = document.createElement('button')
      fsBtn.className = 'qu-lb-btn qu-lb-fs-btn'
      fsBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg> Vollbild'
      fsBtn.addEventListener('click', e => {
        e.stopPropagation()
        const el = lb.querySelector('.qu-lb-video, .qu-lb-img')
        if (el?.requestFullscreen) el.requestFullscreen()
        else if (lb.requestFullscreen) lb.requestFullscreen()
      })
      bar.appendChild(fsBtn)
    }

    // Download
    const dl = Object.assign(document.createElement('a'), {
      href: url, download: name || 'download', className: 'qu-lb-btn', textContent: '⬇'
    })
    dl.title = 'Herunterladen'
    dl.addEventListener('click', e => e.stopPropagation())
    bar.appendChild(dl)

    const closeBtn = Object.assign(document.createElement('button'), { className: 'qu-lb-close', textContent: '✕' })
    closeBtn.addEventListener('click', () => lb.remove())
    bar.appendChild(closeBtn)
    lb.appendChild(bar)

    // Body
    const body = document.createElement('div')
    body.className = 'qu-lb-body'

    let mainEl
    if (mime.startsWith('image/')) {
      mainEl = Object.assign(document.createElement('img'), { src: url, className: 'qu-lb-img' })
      mainEl.addEventListener('click', e => e.stopPropagation())
    } else if (mime.startsWith('video/')) {
      mainEl = Object.assign(document.createElement('video'), {
        src: url, controls: true, autoplay: true, className: 'qu-lb-video',
      })
      mainEl.addEventListener('click', e => e.stopPropagation())
    } else if (mime.startsWith('audio/')) {
      mainEl = document.createElement('div')
      mainEl.className = 'qu-lb-audio-wrap'
      mainEl.innerHTML = `<div class="qu-lb-audio-icon">🎵</div>
        <div class="qu-lb-audio-name">${name || 'Audio'}</div>`
      const audio = Object.assign(document.createElement('audio'), {
        src: url, controls: true, autoplay: true, className: 'qu-lb-audio',
      })
      audio.addEventListener('click', e => e.stopPropagation())
      mainEl.appendChild(audio)
      mainEl.addEventListener('click', e => e.stopPropagation())
    }

    if (mainEl) body.appendChild(mainEl)
    lb.appendChild(body)

    // Close on background click or Escape
    lb.addEventListener('click', e => { if (e.target === lb || e.target === body) lb.remove() })
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc) }
    })

    document.body.appendChild(lb)
    // Focus video/audio for keyboard control
    setTimeout(() => mainEl?.focus?.(), 100)
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-blob-progress> — Upload/Download Fortschrittsbalken
// Attribute: hash="abc123..."
// ─────────────────────────────────────────────────────────────────────────────
class QuBlobProgress extends QuElement {
  _quInit() {
    this._hash = this._attr('hash')
    this.style.cssText = 'display:block;height:3px;background:var(--bd,#2a2a38);border-radius:2px;overflow:hidden'
    this._bar = Object.assign(document.createElement('div'), {
      style: 'height:100%;width:0%;background:var(--amber,#f5a623);transition:width .3s,background .3s',
    })
    this.appendChild(this._bar)
    this.style.display = 'none'

    if (!this._hash || !_globalDb?.queue) return
    const off1 = _globalDb.queue.on('task.progress', t => {
      if (t.data?.hash !== this._hash) return
      this.style.display = 'block'
      this._bar.style.width = (t.progress ?? 0) + '%'
    })
    const off2 = _globalDb.queue.on('task.done', t => {
      if (t.data?.hash !== this._hash) return
      this._bar.style.width = '100%'
      this._bar.style.background = 'var(--green,#4ade80)'
      setTimeout(() => { this.style.display = 'none' }, 1200)
    })
    const off3 = _globalDb.queue.on('task.failed', t => {
      if (t.data?.hash !== this._hash) return
      this._bar.style.background = 'var(--red,#f87171)'
    })
    this._offFns = [off1, off2, off3]
  }
  _quDestroy() { this._offFns?.forEach(f => f?.()) }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-blob-card> — Blob-Karte: Thumbnail + Name + Größe + Fortschritt
// Attribute: hash="..."  mime="image/jpeg"  name="foto.jpg"  size="12345"
//            compact (bool)
// ─────────────────────────────────────────────────────────────────────────────
class QuBlobCard extends QuElement {
  _quInit() {
    this._hash = this._attr('hash')
    const mime = this._attr('mime', '')
    const name = this._attr('name', this._hash?.slice(0,12) + '…')
    const size = parseInt(this._attr('size', '0'))
    const cpt  = this._boolAttr('compact')

    this.style.cssText = `display:flex;align-items:center;gap:8px;padding:${cpt?4:8}px;
      border-radius:8px;background:var(--s2,#18181f);border:1px solid var(--bd,#2a2a38)`

    // Thumbnail
    const thumb = document.createElement('qu-blob-thumb')
    thumb.setAttribute('hash', this._hash)
    thumb.setAttribute('mime', mime)
    thumb.setAttribute('size', String(cpt ? 32 : 48))
    this.appendChild(thumb)

    // Info
    const info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px'

    const nameEl = Object.assign(document.createElement('div'), {
      textContent: name,
      style: 'font:12px var(--sans,system-ui);color:var(--tx,#e8e8f0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
    })
    info.appendChild(nameEl)

    if (size && !cpt) {
      const sizeEl = Object.assign(document.createElement('div'), {
        textContent: size > 1048576 ? (size/1048576).toFixed(1)+' MB' : Math.round(size/1024)+' KB',
        style: 'font:10px var(--mono,monospace);color:var(--sub,#555)',
      })
      info.appendChild(sizeEl)
    }

    // Progress bar
    if (this._hash) {
      const prog = document.createElement('qu-blob-progress')
      prog.setAttribute('hash', this._hash)
      info.appendChild(prog)
    }

    this.appendChild(info)

    // Add expand/play button for media
    if (this._hash && (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/'))) {
      this.style.cursor = 'pointer'
      this.addEventListener('click', () => {
        const st = _globalDb?.blobs?.status(this._hash)
        if (st?.url) QuBlobThumb._openLightbox(st.url, mime, name)
        else _globalDb?.blobs?.load(this._hash)
      })
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-blob-drop> — Drag-Drop Upload Zone
// Attribute: accept="image/*,video/*"  multiple (bool)
//            label="Datei ablegen oder klicken"
// Events: qu-blob-staged { detail: { hash, buf, meta } }
//         qu-blob-ready  { detail: { hash, url } }
// ─────────────────────────────────────────────────────────────────────────────
class QuBlobDrop extends QuElement {
  _quInit() {
    this._accept   = this._attr('accept', '*/*')
    this._multiple = this._boolAttr('multiple')
    const label    = this._attr('label', '📎 Ablegen oder klicken')

    this.style.cssText = `display:flex;align-items:center;justify-content:center;
      gap:8px;padding:20px;border-radius:10px;cursor:pointer;transition:all .15s;
      border:2px dashed var(--bd,#2a2a38);color:var(--sub,#555);font:13px var(--sans,system-ui);
      text-align:center;`
    this.textContent = label

    this._fileInput = Object.assign(document.createElement('input'), {
      type: 'file', accept: this._accept, multiple: this._multiple,
      style: 'display:none',
    })
    this.appendChild(this._fileInput)

    this.addEventListener('click', () => this._fileInput.click())
    this.addEventListener('dragover', e => { e.preventDefault(); this.style.borderColor='var(--amber,#f5a623)'; this.style.color='var(--amber,#f5a623)' })
    this.addEventListener('dragleave', () => { this.style.borderColor='var(--bd,#2a2a38)'; this.style.color='var(--sub,#555)' })
    this.addEventListener('drop', e => {
      e.preventDefault(); this.style.borderColor='var(--bd,#2a2a38)'; this.style.color='var(--sub,#555)'
      this._handleFiles(e.dataTransfer.files)
    })
    this._fileInput.addEventListener('change', () => this._handleFiles(this._fileInput.files))
  }

  async _handleFiles(fileList) {
    for (const file of fileList) {
      const buf  = await file.arrayBuffer()
      const hash = await computeBlobHashBase64Url(buf)
      const meta = { mime: file.type || 'application/octet-stream', name: file.name, size: buf.byteLength }
      // Stage locally (no upload yet — caller decides when to upload)
      if (_globalDb) await _globalDb.blobs.stage(hash, buf, meta)
      this.dispatchEvent(new CustomEvent('qu-blob-staged', {
        detail: { hash, buf, meta }, bubbles: true
      }))
      // Notify when ready
      let _blobOff = null
      _blobOff = _globalDb?.blobs?.on(hash, state => {
        if (state?.url) {
          _blobOff?.()
          this.dispatchEvent(new CustomEvent('qu-blob-ready', {
            detail: { hash, url: state.url, meta }, bubbles: true
          }))
        }
      })
      if (_blobOff) this._offFns.push(_blobOff)
    }
  }
}
// Canonical blob hash helper used by file upload components.
// Imported explicitly to avoid hidden global dependencies during module loading.
const computeBlobHashBase64Url = sha256b64url


// ─────────────────────────────────────────────────────────────────────────────
// <qu-user-profile> — Vollständige Profilkarte eines Peers
// Attribute: pub="MFkw..."  compact (bool)  editable (eigenes Profil)
// ─────────────────────────────────────────────────────────────────────────────
class QuUserProfile extends QuElement {
  static get observedAttributes() { return ['pub'] }
  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'pub' && newVal && newVal !== oldVal) {
      this.innerHTML = ''
      this._offFns?.forEach(f => f?.())
      this._offFns = []
      this._quInit()
    }
  }
  _quInit() {
    this._pub      = this._attr('pub') || _globalMe?.pub
    const compact  = this._boolAttr('compact')
    const editable = this._boolAttr('editable')
    if (!this._pub) {
      if (_globalMe === null) { this._needsInit = true; return }
      return
    }

    this.style.cssText = `display:flex;flex-direction:${compact?'row':'column'};align-items:${compact?'center':'flex-start'};gap:${compact?8:12}px`

    // Avatar
    const av = document.createElement('qu-avatar')
    av.setAttribute('pub', this._pub)
    av.setAttribute('size', String(compact ? 36 : 64))
    this.appendChild(av)

    // Info block
    const info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px'

    // Alias (editable if own profile)
    if (editable && this._pub === _globalMe?.pub) {
      const field = document.createElement('qu-field')
      field.setAttribute('pub', this._pub)
      field.setAttribute('field', 'alias')
      field.setAttribute('placeholder', 'Alias setzen…')
      field.style.cssText = 'font:600 14px var(--sans,system-ui);color:var(--tx,#e8e8f0)'
      info.appendChild(field)
    } else {
      const aliasBindingElement = createBindingElement({
        keyReference: KEY.user(this._pub).alias,
        placeholderText: this._pub.slice(0, 12) + '…',
        explicitPublicKey: this._pub,
      })
      aliasBindingElement.style.cssText = 'font:600 14px var(--sans,system-ui);color:var(--tx,#e8e8f0)'
      info.appendChild(aliasBindingElement)
    }

    // Short pub key
    if (!compact) {
      const pubEl = Object.assign(document.createElement('div'), {
        title: this._pub,
        style: 'font:10px var(--mono,monospace);color:var(--sub,#555)',
      })
      pubEl.textContent = this._pub.slice(0, 20) + '…'
      info.appendChild(pubEl)
    }

    // Custom fields (non-standard sub-keys)
    if (!compact) {
      this._fieldsEl = document.createElement('div')
      this._fieldsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px'
      info.appendChild(this._fieldsEl)
      this._loadFields()
      this._subscribe(`~${this._pub}/**`, () => this._loadFields())
    }

    // Online status dot
    if (compact) {
      const st = document.createElement('qu-status')
      st.setAttribute('pub', this._pub)
      info.appendChild(st)
    }

    this.appendChild(info)

    // Online status row (non-compact)
    if (!compact) {
      const stRow = document.createElement('qu-status')
      stRow.setAttribute('pub', this._pub)
      stRow.setAttribute('show-label', '')
      this.appendChild(stRow)
    }
  }

  async _loadFields() {
    const STANDARD = new Set(['alias','avatar','backup','status','pub','epub'])
    const rows = await _globalDb?.query(`~${this._pub}/`).catch(() => []) ?? []
    const extras = rows.filter(q => {
      const f = q.key.replace(`~${this._pub}/`, '').split('/')[0]
      return f && !STANDARD.has(f) && !f.startsWith('blob')
    })
    if (!this._fieldsEl) return
    this._fieldsEl.innerHTML = extras.map(q => {
      const f = q.key.replace(`~${this._pub}/`, '')
      const v = typeof q.data === 'object' ? JSON.stringify(q.data) : String(q.data ?? '')
      return `<span style="font:10px var(--mono,monospace);padding:2px 7px;border-radius:6px;
        background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.2);color:var(--amber2,#ffcc66)"
        title="${f}">${f}: ${v.slice(0, 20)}</span>`
    }).join('')
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-peer-list> — Reaktive Peer-Liste
// Attribute: mode="all|online"  limit="20"  clickable  search (bool)
// Events: qu-peer-click { detail: { pub } }
// ─────────────────────────────────────────────────────────────────────────────
class QuPeerList extends QuElement {
  _quInit() {
    this._mode    = this._attr('mode', 'all')
    this._limit   = parseInt(this._attr('limit', '50'))
    const search  = this._boolAttr('search')
    this.style.cssText = 'display:flex;flex-direction:column;gap:2px;overflow-y:auto'

    if (search) {
      this._searchEl = Object.assign(document.createElement('input'), {
        placeholder: 'Peer suchen…', type: 'text',
        style: 'background:var(--s2,#18181f);border:1px solid var(--bd,#2a2a38);border-radius:6px;padding:5px 10px;color:var(--tx,#e8e8f0);font:12px var(--sans,system-ui);outline:none;margin-bottom:6px;flex-shrink:0',
      })
      this._searchEl.addEventListener('input', () => this._render())
      this.appendChild(this._searchEl)
    }

    this._list = document.createElement('div')
    this._list.style.cssText = 'display:flex;flex-direction:column;gap:2px;overflow-y:auto;flex:1'
    this.appendChild(this._list)

    if (!_globalPeers) {
      // Fallback: load from DB. Use '**' with prefix filter — '~**' does NOT match user-space keys
      // because '~pub64' is one path segment, making '~**' a literal single-segment glob.
      this._render()
      this._subscribe('**', (q, { key }) => { if (key?.startsWith('~') || key?.startsWith('sys/peers/')) this._render() })
      return
    }

    this._render()
    this._peerOff = _globalPeers.onChange(() => this._render())
  }

  _quDestroy() { this._peerOff?.() }

  _render() {
    const q = (this._searchEl?.value || '').toLowerCase()
    let peers = _globalPeers
      ? (this._mode === 'online' ? _globalPeers.online : _globalPeers.all)
      : []

    if (q) {
      peers = peers.filter(p => {
        const alias = (p.alias || '').toLowerCase()
        const pub   = (p.pub   || '').toLowerCase()
        // Also search custom profile props stored in PeerMap
        const props = Object.values(p.props || {}).map(v => String(v || '').toLowerCase()).join(' ')
        return alias.includes(q) || pub.startsWith(q) || props.includes(q)
      })
    }
    peers = peers.slice(0, this._limit)

    this._list.innerHTML = ''
    for (const p of peers) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;transition:background .1s'
      row.addEventListener('mouseenter', () => row.style.background = 'var(--s2,#18181f)')
      row.addEventListener('mouseleave', () => row.style.background = '')
      row.addEventListener('click', () =>
        this.dispatchEvent(new CustomEvent('qu-peer-click', { detail: { pub: p.pub }, bubbles: true }))
      )

      const peerEl = document.createElement('qu-peer')
      peerEl.setAttribute('pub', p.pub)
      peerEl.style.flex = '1'
      row.appendChild(peerEl)

      // Use qu-status for reactive online indicator (subscribes sys/peers/{pub})
      const statusDot = document.createElement('qu-status')
      statusDot.setAttribute('pub', p.pub)
      statusDot.setAttribute('size', '8')
      row.appendChild(statusDot)

      this._list.appendChild(row)
    }

    if (!peers.length) {
      this._list.innerHTML = `<div style="padding:12px;font:12px var(--sans,system-ui);color:var(--sub,#555);text-align:center">Keine Peers</div>`
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-inbox-badge> — Reaktiver Ungelesen-Zähler für Inbox
// Attribute: pub="me.pub"  color="red"
// ─────────────────────────────────────────────────────────────────────────────
class QuInboxBadge extends QuElement {
  // Two modes:
  // 1. pub= only → counts >pub/* inbox items (DM invites)
  // 2. pub= + space= → counts unread messages in @space/chat/
  //    Reads conf/read/{space} as last-read timestamp
  //    Unread = messages with ts > lastRead AND from !== me.pub
  _quInit() {
    this._pub   = this._attr('pub')   || _globalMe?.pub
    this._space = this._attr('space') || null
    if (!this._pub) return

    const badge = document.createElement('qu-badge')
    badge.setAttribute('color', this._attr('color', 'red'))
    badge.setAttribute('value', '0')
    this.appendChild(badge)

    if (this._space) {
      // Per-space unread count
      const msgPrefix  = `@${this._space}/chat/`
      const readKey    = `conf/read/${this._space}`
      const update = async () => {
        const [rows, lastReadQ] = await Promise.all([
          _globalDb?.query(msgPrefix).catch(() => []) ?? [],
          _globalDb?.get(readKey).catch(() => null),
        ])
        const lastRead = lastReadQ?.data ?? 0
        const unread = rows.filter(q => {
          const from = q.from ?? q.data?.from
          const ts   = q.ts ?? 0
          return from !== this._pub && ts > lastRead && !q.data?.deleted
        }).length
        badge.setAttribute('value', String(unread))
        badge.style.display = unread ? '' : 'none'
      }
      update()
      this._subscribe(msgPrefix + '**', update)
      this._subscribe(readKey, update)
    } else {
      // Global inbox (invites)
      const prefix = `>${this._pub}/`
      const update = async () => {
        const rows = await _globalDb?.query(prefix).catch(() => []) ?? []
        badge.setAttribute('value', String(rows.length))
      }
      update()
      this._subscribe(prefix + '**', update)
    }
  }
}

// Helper: mark a space as read (call when user opens chat)
const markSpaceRead = (spaceId) => {
  if (!spaceId || !_globalDb) return
  _globalDb.put(`conf/read/${spaceId}`, Date.now()).catch(() => {})
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-chat-msg> — Einzelne Chat-Nachricht
// Attribute:
//   msg-key="@space/chat/ts-id"    DB-Key der Nachricht
//   mine (bool)                    Eigene Nachricht (rechts)
//   show-sender (bool)             Absender-Avatar anzeigen
// ─────────────────────────────────────────────────────────────────────────────
class QuChatMsg extends QuElement {
  _quInit() {
    this._msgKey  = this._attr('msg-key')
    const mine    = this._boolAttr('mine')
    const showSnd = this._boolAttr('show-sender')
    if (!this._msgKey) return

    this.style.cssText = `display:flex;flex-direction:${mine?'row-reverse':'row'};
      align-items:flex-end;gap:8px;padding:2px 0`

    // Sender avatar (for group chats)
    if (showSnd && !mine) {
      this._av = document.createElement('qu-avatar')
      this._av.setAttribute('size', '28')
      this.appendChild(this._av)
    }

    // Bubble
    this._bubble = document.createElement('div')
    this._bubble.style.cssText = `max-width:72%;min-width:40px;padding:8px 12px;border-radius:${mine?'16px 16px 4px 16px':'16px 16px 16px 4px'};
      background:${mine?'var(--qu-msg-mine-bg,rgba(88,166,255,.15))':'var(--qu-msg-bg,var(--s2,#18181f))'};
      border:1px solid ${mine?'rgba(88,166,255,.25)':'var(--bd,#2a2a38)'};
      display:flex;flex-direction:column;gap:4px`

    this._textEl = Object.assign(document.createElement('div'), {
      style: 'font:13px var(--sans,system-ui);color:var(--tx,#e8e8f0);word-break:break-word;line-height:1.5',
    })
    this._bubble.appendChild(this._textEl)

    this._attachments = document.createElement('div')
    this._attachments.style.cssText = 'display:flex;flex-direction:column;gap:4px'
    this._bubble.appendChild(this._attachments)

    // Meta row
    this._meta = document.createElement('div')
    this._meta.style.cssText = `display:flex;align-items:center;gap:4px;justify-content:${mine?'flex-end':'flex-start'}`

    const tsEl = document.createElement('qu-ts')
    tsEl.setAttribute('key', this._msgKey)
    tsEl.setAttribute('format', 'time')
    tsEl.style.cssText = 'font:10px var(--mono,monospace);color:var(--sub,#555)'
    this._meta.appendChild(tsEl)

    if (mine) {
      const tick = document.createElement('qu-tick')
      tick.setAttribute('msg-key', this._msgKey)
      this._meta.appendChild(tick)
    }

    this._bubble.appendChild(this._meta)
    this.appendChild(this._bubble)

    // Load content
    this._load()
    this._subscribe(this._msgKey, q => this._render(q))
  }

  async _load() {
    const q = await _globalDb?.get(this._msgKey)
    if (q) this._render(q)
  }

  async _render(q) {
    if (!q) return
    const raw = q.data

    // Try to decrypt if encrypted
    let payload = raw
    if (raw?.ct && _globalMe) {
      try { payload = JSON.parse(await _globalMe.decrypt(raw)) } catch { payload = { text: '🔒' } }
    }

    // Set sender avatar
    if (this._av && q.from) this._av.setAttribute('pub', q.from)

    // Text
    const text = payload?.text ?? (typeof payload === 'string' ? payload : '')
    this._textEl.textContent = text
    this._textEl.style.display = text ? '' : 'none'

    // Attachments
    this._attachments.innerHTML = ''
    for (const att of payload?.attachments ?? []) {
      const mime = att.mime ?? ''
      const hash = att.hash ?? ''
      const name = att.name ?? ''

      if (mime.startsWith('image/')) {
        // Images: inline full-width with lightbox on click
        const wrap = Object.assign(document.createElement('div'), {
          style: 'border-radius:10px;overflow:hidden;max-width:280px;cursor:zoom-in;margin:2px 0',
        })
        const img = Object.assign(document.createElement('img'), {
          alt: name, style: 'width:100%;display:block;max-height:240px;object-fit:cover',
        })
        img.addEventListener('click', () => QuBlobThumb._openLightbox(img.src, mime, name))
        // Load blob URL when available
        const st = _globalDb?.blobs?.status(hash)
        if (st?.url) {
          img.src = st.url
        } else {
          // Placeholder while loading
          img.style.cssText += 'min-height:80px;background:rgba(255,255,255,.04)'
          const loadingDiv = Object.assign(document.createElement('div'), {
            style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:6px;font:11px system-ui;color:rgba(255,255,255,.4)',
            textContent: '⟳ Loading…',
          })
          wrap.style.position = 'relative'
          wrap.appendChild(loadingDiv)
          let _offImg = null
          _offImg = _globalDb?.blobs?.on(hash, s => {
            if (s?.url) {
              _offImg?.(); img.src = s.url
              img.style.minHeight = ''; img.style.background = ''
              loadingDiv.remove()
            } else if (s?.status === 'pending') {
              loadingDiv.textContent = '⟳ Downloading…'
            } else if (s?.status === 'error') {
              loadingDiv.textContent = '✗ Failed'
              loadingDiv.style.color = 'rgba(248,113,113,.8)'
            }
          })
          _globalDb?.blobs?.load(hash)
        }
        wrap.appendChild(img)
        this._attachments.appendChild(wrap)
      } else if (mime.startsWith('video/')) {
        // Videos: native HTML5 player
        const wrap = Object.assign(document.createElement('div'), {
          style: 'border-radius:10px;overflow:hidden;max-width:min(300px,100%);background:#000;margin:2px 0;position:relative',
        })
        const video = Object.assign(document.createElement('video'), {
          controls: true, preload: 'metadata', playsinline: true,
          style: 'width:100%;max-height:240px;display:block;-webkit-playsinline:1;display:none',
        })
        // Spinner shown while blob is loading
        const spinner = Object.assign(document.createElement('div'), {
          style: 'height:120px;display:flex;align-items:center;justify-content:center;gap:8px;color:rgba(255,255,255,.5);font:12px system-ui',
          textContent: '⟳ Loading video…',
        })
        wrap.appendChild(spinner)
        const st = _globalDb?.blobs?.status(hash)
        const _showVideo = (url) => {
          video.src = url; video.style.display = 'block'
          if (spinner.parentNode) spinner.remove()
        }
        if (st?.url) { _showVideo(st.url) }
        else {
          let _offVid = null
          _offVid = _globalDb?.blobs?.on(hash, s => {
            if (s?.url) { _offVid?.(); _showVideo(s.url) }
            else if (s?.status === 'pending') {
              spinner.textContent = '⟳ Downloading video…'
            } else if (s?.status === 'awaiting-user') {
              spinner.textContent = '⬇ Tap to download'
              spinner.style.cursor = 'pointer'
              spinner.onclick = () => { _globalDb?.blobs?.load(hash); spinner.onclick = null }
            } else if (s?.status === 'error') {
              spinner.textContent = '✗ Download failed'
              spinner.style.color = 'rgba(248,113,113,.7)'
            }
          })
          _globalDb?.blobs?.load(hash)
        }
        video.addEventListener('dblclick', () => {
          if (video.requestFullscreen) video.requestFullscreen()
        })
        wrap.appendChild(video)
        this._attachments.appendChild(wrap)
      } else if (mime.startsWith('audio/')) {
        // Audio: compact player
        const wrap = Object.assign(document.createElement('div'), {
          style: 'display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:12px;background:rgba(255,255,255,.06);max-width:min(280px,100%);margin:2px 0;border:1px solid rgba(255,255,255,.06)',
        })
        const icon = Object.assign(document.createElement('div'), { textContent: '🎵', style: 'font-size:20px;flex-shrink:0' })
        const audio = Object.assign(document.createElement('audio'), {
          controls: true, preload: 'metadata', style: 'flex:1;min-width:0;height:36px;accent-color:var(--amber,#f5a623)',
        })
        const stA = _globalDb?.blobs?.status(hash)
        if (stA?.url) { audio.src = stA.url }
        else {
          let _offAud = null
          _offAud = _globalDb?.blobs?.on(hash, state => {
            if (state?.url) { _offAud?.(); audio.src = state.url }
          })
          _globalDb?.blobs?.load(hash)
        }
        wrap.appendChild(icon); wrap.appendChild(audio)
        this._attachments.appendChild(wrap)
      } else {
        // Other files: compact card
        const card = document.createElement('qu-blob-card')
        card.setAttribute('hash', hash)
        card.setAttribute('mime', mime)
        card.setAttribute('name', name)
        card.setAttribute('size', String(att.size ?? 0))
        card.setAttribute('compact', '')
        this._attachments.appendChild(card)
      }
    }
  }
}




// ─────────────────────────────────────────────────────────────────────────────
// <qu-profile-card> — Kompakte oder vollständige Profilkarte (read-only)
//
// Attribute:
//   pub="MFkw..."     Peer-pub64 (default: eigener User)
//   size="compact|full"  default full
//   show-fields        Zeigt Custom-Fields (town, age, …)
//
// Beispiel:
//   <qu-profile-card pub="MFkw..." show-fields></qu-profile-card>
// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════ PROFILE ═════════════════════════════════════
class QuProfileCard extends QuElement {
  static get observedAttributes() { return ['pub'] }
  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'pub' && newVal && newVal !== oldVal) {
      this.innerHTML = ''
      this._offFns?.forEach(f => f?.())
      this._offFns = []
      this._quInit()
    }
  }
  _quInit() {
    this._pub       = this._attr('pub') || _globalMe?.pub
    const compact   = this._attr('size') === 'compact'
    const showFields = this._boolAttr('show-fields')
    if (!this._pub) return

    this.style.cssText = `display:flex;flex-direction:${compact?'row':'column'};align-items:${compact?'center':'flex-start'};gap:${compact?8:12}px`

    // Avatar
    const av = document.createElement('qu-avatar')
    av.setAttribute('pub', this._pub)
    av.setAttribute('size', String(compact ? 36 : 64))
    this.appendChild(av)

    const info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px'

    // Alias
    const aliasBindingElement = createBindingElement({
        keyReference: KEY.user(this._pub).alias,
        placeholderText: this._pub.slice(0, 12) + '…',
        explicitPublicKey: this._pub,
      })
    aliasBindingElement.style.cssText = 'font:600 14px var(--sans,system-ui);color:var(--tx,#e8e8f0)'
    info.appendChild(aliasBindingElement)

    // Short pub
    if (!compact) {
      const pubEl = Object.assign(document.createElement('div'), {
        title: this._pub,
        textContent: this._pub.slice(0, 20) + '…',
        style: 'font:10px var(--mono,monospace);color:var(--sub,#555)',
      })
      info.appendChild(pubEl)
    }

    // Online status
    const st = document.createElement('qu-status')
    st.setAttribute('pub', this._pub)
    if (!compact) st.setAttribute('show-label', '')
    info.appendChild(st)

    // Custom fields
    if (showFields && !compact) {
      this._fieldsEl = document.createElement('div')
      this._fieldsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px'
      info.appendChild(this._fieldsEl)
      this._loadFields()
      this._subscribe(`~${this._pub}/**`, () => this._loadFields())
    }

    this.appendChild(info)
  }

  async _loadFields() {
    if (!this._fieldsEl) return
    const STANDARD = new Set(['alias','avatar','backup','status','pub','epub'])
    const rows = await _globalDb?.query(`~${this._pub}/`).catch(() => []) ?? []
    const extras = rows.filter(q => {
      const f = q.key.replace(`~${this._pub}/`, '').split('/')[0]
      return f && !STANDARD.has(f) && !f.startsWith('blob')
    })
    this._fieldsEl.innerHTML = extras.map(q => {
      const f = q.key.replace(`~${this._pub}/`, '')
      const v = q.data?.ct ? '🔒' : typeof q.data === 'object' ? JSON.stringify(q.data) : String(q.data ?? '')
      return `<span style="font:10px var(--mono,monospace);padding:2px 7px;border-radius:6px;
        background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.2);color:var(--amber2,#ffcc66)"
        title="${f}">${f}: ${v.slice(0,24)}</span>`
    }).join('')
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-profile-edit> — Interaktives Profil-Bearbeiten
//
// Attribute:
//   pub="MFkw..."    Peer-pub64 (immer eigener User — andere sind read-only)
//
// Events:
//   qu-profile-saved   { detail: { alias, avatar, props } }
//   qu-profile-cancel
//
// Beispiel:
//   <qu-profile-edit></qu-profile-edit>
//   <qu-profile-edit @qu-profile-saved="onSaved(event.detail)"></qu-profile-edit>
// ─────────────────────────────────────────────────────────────────────────────
class QuProfileEdit extends QuElement {
  _quInit() {
    if (!_globalMe || !_globalDb) {
      // Not ready yet — will be re-initialized when setDb() is called
      this._needsInit = true
      return
    }
    this._doInit()
  }

  static _reinitPending() {
    // Called from setDb() after globals are set — rebuild any pending instances
    document.querySelectorAll('qu-profile-edit,qu-user-profile,qu-peer-list,qu-inbox-badge').forEach(el => {
      if (el._needsInit) { el._needsInit = false; el._quInit?.() }
    })
  }

  _doInit() {
    if (!_globalMe || !_globalDb) return
    this._pub = _globalMe.pub

    this.style.cssText = 'display:flex;flex-direction:column;gap:14px'
    this._pendingAvatar = null

    this._injectCSS()
    this._build()
    this._load()
    this._subscribe(`~${this._pub}/**`, () => this._load())
  }

  _injectCSS() {
    if (document.getElementById('qu-profile-edit-css')) return
    const s = document.createElement('style')
    s.id = 'qu-profile-edit-css'
    s.textContent = `
      .qpe-section { display:flex;flex-direction:column;gap:6px }
      .qpe-label { font:10px var(--mono,monospace);color:var(--sub,#555);font-weight:700;letter-spacing:.08em;text-transform:uppercase }
      .qpe-input { background:var(--s2,#18181f);border:1px solid var(--bd,#2a2a38);border-radius:8px;padding:8px 12px;color:var(--tx,#e8e8f0);font:14px inherit;outline:none;width:100%;box-sizing:border-box;transition:border-color .15s }
      .qpe-input:focus { border-color:var(--amber,#f5a623) }
      .qpe-av-row { display:flex;align-items:center;gap:10px }
      .qpe-av-wrap { position:relative;cursor:pointer }
      .qpe-av-wrap:hover::after { content:'✏';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);border-radius:50%;font-size:18px }
      .qpe-prop-row { display:flex;gap:6px;align-items:center }
      .qpe-prop-row input { flex:1;min-width:0 }
      .qpe-prop-del { background:none;border:none;color:var(--sub,#555);cursor:pointer;font:16px inherit;padding:0 4px;flex-shrink:0 }
      .qpe-prop-del:hover { color:var(--red,#f87171) }
      .qpe-enc-lbl { display:flex;align-items:center;gap:3px;font:11px var(--sans,system-ui);color:var(--sub,#555);cursor:pointer;white-space:nowrap;flex-shrink:0 }
      .qpe-btn { padding:8px 16px;border-radius:8px;border:none;cursor:pointer;font:13px inherit;transition:all .15s }
      .qpe-btn-save { background:var(--amber,#f5a623);color:#000;font-weight:600 }
      .qpe-btn-save:hover { opacity:.9 }
      .qpe-btn-add { background:none;border:1px solid var(--bd,#2a2a38);color:var(--mu,#8888a8) }
      .qpe-btn-add:hover { border-color:var(--amber,#f5a623);color:var(--amber,#f5a623) }
      .qpe-btn-cancel { background:none;border:1px solid var(--bd,#2a2a38);color:var(--sub,#555) }
      .qpe-actions { display:flex;gap:8px;justify-content:flex-end }
    `
    document.head.appendChild(s)
  }

  _build() {
    this.innerHTML = ''

    // Avatar section
    const avSec = document.createElement('div')
    avSec.className = 'qpe-section qpe-av-row'
    this._avWrap = document.createElement('div')
    this._avWrap.className = 'qpe-av-wrap'
    this._avEl = document.createElement('qu-avatar')
    this._avEl.setAttribute('pub', this._pub)
    this._avEl.setAttribute('size', '64')
    this._avWrap.appendChild(this._avEl)
    this._avInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', style: 'display:none' })
    this._avWrap.appendChild(this._avInput)
    this._avWrap.addEventListener('click', () => this._avInput.click())
    this._avInput.addEventListener('change', () => this._onAvatarFile(this._avInput.files[0]))
    avSec.appendChild(this._avWrap)
    const avActions = document.createElement('div')
    avActions.style.cssText = 'display:flex;flex-direction:column;gap:6px'
    const avLabel = Object.assign(document.createElement('label'), { className: 'qpe-label', textContent: 'AVATAR' })
    avActions.appendChild(avLabel)
    const avDelBtn = document.createElement('button')
    avDelBtn.className = 'qpe-btn-add qpe-btn'
    avDelBtn.style.padding = '4px 10px'
    avDelBtn.textContent = '🗑 Entfernen'
    avDelBtn.addEventListener('click', () => { this._pendingAvatar = null; this._avEl.setAttribute('pub', this._pub) })
    avActions.appendChild(avDelBtn)
    avSec.appendChild(avActions)
    this.appendChild(avSec)

    // Alias
    const alSec = document.createElement('div')
    alSec.className = 'qpe-section'
    alSec.innerHTML = '<label class="qpe-label">ANZEIGENAME</label>'
    this._aliasInput = Object.assign(document.createElement('input'), { className: 'qpe-input', type: 'text', placeholder: 'Alias…' })
    alSec.appendChild(this._aliasInput)
    this.appendChild(alSec)

    // Custom fields
    const fSec = document.createElement('div')
    fSec.className = 'qpe-section'
    fSec.innerHTML = '<label class="qpe-label">WEITERE FELDER</label>'
    this._propsContainer = document.createElement('div')
    this._propsContainer.style.cssText = 'display:flex;flex-direction:column;gap:6px'
    fSec.appendChild(this._propsContainer)
    const addBtn = document.createElement('button')
    addBtn.className = 'qpe-btn qpe-btn-add'
    addBtn.textContent = '+ Feld hinzufügen'
    addBtn.addEventListener('click', () => { this._props.push({ key: '', value: '', encrypted: false }); this._renderProps() })
    fSec.appendChild(addBtn)
    this.appendChild(fSec)

    // Actions
    const acts = document.createElement('div')
    acts.className = 'qpe-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'qpe-btn qpe-btn-cancel'
    cancelBtn.textContent = 'Abbrechen'
    cancelBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('qu-profile-cancel', { bubbles: true }))
      this._load() // reset
    })
    acts.appendChild(cancelBtn)
    const saveBtn = document.createElement('button')
    saveBtn.className = 'qpe-btn qpe-btn-save'
    saveBtn.textContent = '💾 Speichern'
    saveBtn.addEventListener('click', () => this._save())
    acts.appendChild(saveBtn)
    this.appendChild(acts)
  }

  async _load() {
    if (this._saving) return   // don't reload while save is in progress
    if (!_globalDb || !_globalMe) return
    const STANDARD = new Set(['alias','avatar','backup','status','pub','epub'])

    this._aliasInput.value = _globalMe.alias || ''

    const rows = await _globalDb.query(`~${this._pub}/`).catch(() => [])
    this._props = rows
      .filter(q => {
        const f = q.key.replace(`~${this._pub}/`, '').split('/')[0]
        return f && !STANDARD.has(f) && !f.startsWith('blob')
      })
      .map(q => {
        const field = q.key.replace(`~${this._pub}/`, '')
        const d = q.data
        if (d?.encrypted && d?.enc) return { key: field, value: '', encrypted: true, enc: d.enc }
        return { key: field, value: typeof d === 'object' ? JSON.stringify(d) : String(d ?? ''), encrypted: false }
      })
    this._renderProps()
  }

  _renderProps() {
    this._propsContainer.innerHTML = ''
    this._props.forEach((p, i) => {
      const row = document.createElement('div')
      row.className = 'qpe-prop-row'
      const kInput = Object.assign(document.createElement('input'), { className: 'qpe-input', type: 'text', placeholder: 'Feld', value: p.key || '' })
      const vInput = Object.assign(document.createElement('input'), { className: 'qpe-input', type: 'text', placeholder: 'Wert', value: p.value || '' })
      kInput.addEventListener('input', e => { this._props[i].key = e.target.value })
      vInput.addEventListener('input', e => { this._props[i].value = e.target.value })
      const encLabel = document.createElement('label')
      encLabel.className = 'qpe-enc-lbl'
      const encCb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!p.encrypted })
      encCb.addEventListener('change', e => { this._props[i].encrypted = e.target.checked })
      encLabel.append(encCb, '🔒')
      const delBtn = document.createElement('button')
      delBtn.className = 'qpe-prop-del'
      delBtn.textContent = '×'
      delBtn.addEventListener('click', () => { this._props.splice(i, 1); this._renderProps() })
      row.append(kInput, vInput, encLabel, delBtn)
      this._propsContainer.appendChild(row)
    })
  }

  async _onAvatarFile(file) {
    if (!file) return
    const maxPx = 128
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width*scale), height: Math.round(img.height*scale) })
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      this._pendingAvatar = canvas.toDataURL('image/jpeg', 0.82)
      // Preview
      this._avEl.style.backgroundImage = `url(${this._pendingAvatar})`
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  async _save() {
    this._saving = true
    const alias = this._aliasInput.value.trim()
    if (alias) await _globalMe.setAlias(alias)
    if (this._pendingAvatar !== null) {
      await _globalDb?.put(`~${this._pub}/avatar`, this._pendingAvatar || null)
    }

    // Save/delete custom fields via diff
    const STANDARD = new Set(['alias','avatar','backup','status','pub','epub'])
    const currentRows = await _globalDb?.query(`~${this._pub}/`).catch(() => []) ?? []
    const currentKeys = new Set(
      currentRows.map(q => q.key.replace(`~${this._pub}/`, '').split('/')[0]).filter(f => f && !STANDARD.has(f))
    )
    const incomingKeys = new Set(this._props.map(p => p.key).filter(Boolean))

    for (const key of currentKeys) {
      if (!incomingKeys.has(key)) await _globalDb?.del(`~${this._pub}/${key}`)
    }
    for (const p of this._props) {
      if (!p.key) continue
      if (p.encrypted && _globalMe) {
        const enc = await _globalMe.encrypt(JSON.stringify({ field: p.key, value: p.value }))
        await _globalDb?.put(`~${this._pub}/${p.key}`, { encrypted: true, field: p.key, enc })
      } else {
        await _globalDb?.put(`~${this._pub}/${p.key}`, p.value || null)
      }
    }

    this._pendingAvatar = null
    this._saving = false
    this.dispatchEvent(new CustomEvent('qu-profile-saved', {
      detail: { alias, props: this._props }, bubbles: true
    }))
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// <qu-emoji-picker> — Emoji Picker
//
// Attribute:
//   target="msg-in"       ID des Textarea/Input wo Emoji eingefügt wird
//   trigger="btn-emoji"   ID des Buttons der den Picker öffnet/schließt
//
// Verhalten:
//   Desktop: Zeigt eigenen Picker-Popup mit kategorisierten Emojis
//   Mobile (Touch): Öffnet natives Emoji-Keyboard via contenteditable-Trick
//
// Events:
//   qu-emoji-pick  { detail: { emoji } }   bubbles
//
// Emojis werden als native Unicode-Zeichen eingefügt — font-family:
//   'Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji', emoji
// sorgt auf allen Plattformen für korrekte farbige Darstellung.
//
// Auf Android zeigt der Browser kein contenteditable-Emoji-Keyboard.
// Stattdessen wird die native Emoji-Taste des Keyboards verwendet —
// die on-screen keyboard des Geräts hat einen Emoji-Button (😊).
// ─────────────────────────────────────────────────────────────────────────────

const EMOJI_DATA = {
  "😀": ["Smileys","😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","🥲","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😔","😪","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","🥸","😎","🤓","🧐","😕","😟","🙁","☹","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","☠","💩","🤡","👹","👺","👻","👽","👾","🤖"],
  "👋": ["People","👋","🤚","🖐","✋","🖖","👌","🤌","🤏","✌","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍","💅","🤳","💪","🦾","🦿","🦵","🦶","👂","🦻","👃","❤","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","💕","💞","💓","💗","💖","💘","💝","💟","👶","🧒","👧","👦","🧑","👩","👨","🧓","👵","👴"],
  "🐶": ["Animals","🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐽","🐸","🐵","🙈","🙉","🙊","🐒","🦆","🐔","🐧","🐦","🐤","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🦟","🦗","🦂","🐢","🐍","🦎","🦕","🦖","🐊","🦓","🦍","🦧","🦣","🐘","🦛","🦏","🐪","🐫","🦒","🦘","🦬","🐃","🐂","🐄","🐎","🐖","🐏","🐑","🦙","🐐","🦌","🐕","🐩","🦮","🐈","🐓","🦃","🦤","🦚","🦜","🦢","🦩","🕊","🐇","🦝","🦨","🦡","🦫","🦦","🦥","🐁","🐀","🐿","🦔","🐾","🐉","🐲"],
  "🍏": ["Food","🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🍆","🥑","🥦","🥬","🥒","🌶","🧄","🧅","🥔","🍠","🌽","🥕","🍞","🥐","🥖","🥨","🥯","🧀","🥚","🍳","🧈","🥞","🧇","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕","🌮","🌯","🥙","🥗","🥘","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🦪","🍤","🍙","🍚","🍘","🍥","🥮","🍢","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪","🥜","🍯","🧃","🥤","🧋","☕","🍵","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🍾","🍴","🥢","🧂"],
  "🚗": ["Travel","🚗","🚕","🚙","🚌","🚎","🏎","🚓","🚑","🚒","🚐","🛻","🚚","🚛","🚜","🛵","🏍","🚲","🛴","🛹","🛼","⛽","🚨","🚥","🚦","🛑","🚧","⚓","🛟","⛵","🚤","🛳","⛴","🛥","🚢","✈","🛩","🛫","🛬","🪂","💺","🚁","🛰","🚀","🛸","🌍","🌎","🌏","⛰","🏔","🌋","🗻","🏕","🏖","🏜","🏝","🏟","🏛","🏗","🏠","🏡","🏢","🏥","🏦","🏨","🏩","🏪","🏫","🏬","🏭","🏯","🏰","💒","🗼","🗽","⛪","🕌","🛕","🕍","⛩","🕋","⛲","⛺","🌁","🌃","🌄","🌅","🌆","🌇","🌉"],
  "⌚": ["Objects","⌚","📱","💻","⌨","🖥","🖨","🖱","💾","💿","📀","🧮","📷","📸","📹","🎥","📽","🎞","📞","☎","📟","📠","📺","📻","🧭","⏱","⏲","⏰","🕰","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯","🧲","💰","💳","💎","⚖","🔧","🪛","🔨","⚒","🛠","⛏","⚙","🗜","🔩","🪤","🧰","🔮","📿","🧿","⚗","🔭","🔬","🩺","💊","🩹","🚽","🚿","🛁","💊","🧴","🧷","🧹","🧺","🧻","🧼","🫧","🧯","🛒","🚪","🛋","🛏","📦","📫","📬","📭","📮","📰","🗞","📌","📍","🗂","📁","📂","🗃","🗄","📊","📈","📉","📃","📑","📄","📜","📋"],
  "❤": ["Symbols","❤","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💋","💯","💢","💥","💫","💦","💨","🕳","💬","💭","🗯","💤","🔔","🔕","🎵","🎶","✅","❎","⭐","🌟","💫","✨","⚡","🔥","💧","🌊","🎯","🏆","🥇","🥈","🥉","🎖","🎗","🎫","🎟","🎪","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🎸","🎺","🎻","🥁","🎷","🎮","🕹","🃏","🀄","🎴","🧩","🎲","🎭","🎨","🎰","🚩","🎌","🏴","🏳","🏁","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔶","🔷","🔸","🔹","➡","⬅","⬆","⬇","↩","↪","🔁","🔂","🔀","⁉","❓","❔","❕","❗","⚠","🚫","⛔","🔞","📵","🔇","🔈","🔉","🔊"]
}

const CATEGORIES = Object.keys(EMOJI_DATA)
const CATEGORY_ICONS = { "😀":"😀", "👋":"👋", "🐶":"🐶", "🍏":"🍏", "🚗":"🚗", "⌚":"⌚", "❤":"❤" }

const _isMobile = () => /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || 
  ('ontouchstart' in window && window.innerWidth < 768)

// ═══════════════════════════════ EMOJI ══════════════════════════════════════
class QuEmojiPicker extends HTMLElement {
  connectedCallback() {
    this._targetId  = this.getAttribute('target')
    this._triggerId = this.getAttribute('trigger')
    this._open = false
    this._activeCategory = CATEGORIES[0]
    this._query = ''

    this._injectCSS()
    this._buildPicker()

    // Wire trigger button
    const triggerEl = document.getElementById(this._triggerId)
    if (triggerEl) {
      triggerEl.addEventListener('click', (e) => {
        e.stopPropagation()
        if (_isMobile()) {
          // On mobile: focus the target textarea — native emoji keyboard accessible via keyboard button
          document.getElementById(this._targetId)?.focus()
        } else {
          this._toggle()
        }
      })
    }

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (this._open && !this.contains(e.target) && e.target?.id !== this._triggerId) {
        this._close()
      }
    })
  }

  _injectCSS() {
    if (document.getElementById('qu-emoji-css')) return
    const s = document.createElement('style')
    s.id = 'qu-emoji-css'
    s.textContent = `
      .qu-ep { position:absolute; bottom:calc(100% + 6px); left:0;
        font-family:'Apple Color Emoji','Noto Color Emoji','Segoe UI Emoji','Twemoji Mozilla',emoji,sans-serif;
        width:320px; max-height:360px; background:var(--s2,#18181f);
        border:1px solid var(--bd,#2a2a38); border-radius:12px;
        box-shadow:0 8px 32px rgba(0,0,0,.4); display:none;
        flex-direction:column; z-index:1000; overflow:hidden;
        font-family:'Apple Color Emoji','Noto Color Emoji','Segoe UI Emoji',emoji,sans-serif }
      .qu-ep.open { display:flex }
      .qu-ep-search { padding:8px; border-bottom:1px solid var(--bd,#2a2a38); flex-shrink:0 }
      .qu-ep-search input { width:100%; background:var(--s1,#111118);
        border:1px solid var(--bd,#2a2a38); border-radius:7px;
        padding:6px 10px; color:var(--tx,#e8e8f0); font:13px inherit; outline:none; box-sizing:border-box }
      .qu-ep-search input:focus { border-color:var(--amber,#f5a623) }
      .qu-ep-cats { display:flex; padding:4px 6px; gap:2px; border-bottom:1px solid var(--bd,#2a2a38);
        flex-shrink:0; overflow-x:auto; scrollbar-width:none }
      .qu-ep-cats::-webkit-scrollbar { display:none }
      .qu-ep-cat { padding:4px 6px; border-radius:6px; cursor:pointer; font-size:18px;
        opacity:.5; transition:opacity .1s,background .1s; flex-shrink:0 }
      .qu-ep-cat:hover, .qu-ep-cat.active { opacity:1; background:rgba(255,255,255,.08) }
      .qu-ep-body { flex:1; overflow-y:auto; padding:4px; scrollbar-width:thin;
        scrollbar-color:var(--bd,#2a2a38) transparent }
      .qu-ep-grid { display:grid; grid-template-columns:repeat(8,1fr); gap:0 }
      .qu-ep-cell { font-size:22px; padding:4px; border-radius:6px; cursor:pointer;
        font-family:'Apple Color Emoji','Noto Color Emoji','Segoe UI Emoji','Twemoji Mozilla',emoji,sans-serif;
        text-align:center; line-height:1.2; transition:background .1s; user-select:none }
      .qu-ep-cell:hover { background:rgba(255,255,255,.12) }
      .qu-ep-cell:active { background:rgba(255,255,255,.2) }
      .qu-ep-empty { padding:20px; text-align:center; color:var(--sub,#555);
        font:12px var(--sans,system-ui) }
    `
    document.head.appendChild(s)
  }

  _buildPicker() {
    this.style.cssText = 'position:relative;display:inline-block'

    this._picker = document.createElement('div')
    this._picker.className = 'qu-ep'

    // Search
    const searchRow = document.createElement('div')
    searchRow.className = 'qu-ep-search'
    this._searchInput = Object.assign(document.createElement('input'), {
      type: 'text', placeholder: '🔍 Suchen…'
    })
    this._searchInput.addEventListener('input', e => {
      this._query = e.target.value.toLowerCase()
      this._renderGrid()
    })
    searchRow.appendChild(this._searchInput)
    this._picker.appendChild(searchRow)

    // Category tabs
    this._catsEl = document.createElement('div')
    this._catsEl.className = 'qu-ep-cats'
    Object.entries(CATEGORY_ICONS).forEach(([key, icon]) => {
      const btn = Object.assign(document.createElement('div'), {
        className: 'qu-ep-cat' + (key === CATEGORIES[0] ? ' active' : ''),
        textContent: icon, title: EMOJI_DATA[key][0],
      })
      btn.dataset.cat = key
      btn.addEventListener('click', () => {
        this._activeCategory = key
        this._query = ''
        this._searchInput.value = ''
        this._catsEl.querySelectorAll('.qu-ep-cat').forEach(c => c.classList.toggle('active', c.dataset.cat === key))
        this._renderGrid()
      })
      this._catsEl.appendChild(btn)
    })
    this._picker.appendChild(this._catsEl)

    // Grid
    this._body = document.createElement('div')
    this._body.className = 'qu-ep-body'
    this._grid = document.createElement('div')
    this._grid.className = 'qu-ep-grid'
    this._body.appendChild(this._grid)
    this._picker.appendChild(this._body)

    this.appendChild(this._picker)
    this._renderGrid()
  }

  _renderGrid() {
    this._grid.innerHTML = ''
    let emojis = []
    if (this._query) {
      // Search across all categories
      Object.values(EMOJI_DATA).forEach(list => {
        list.slice(1).forEach(e => { if (e.length <= 8) emojis.push(e) })
      })
    } else {
      emojis = EMOJI_DATA[this._activeCategory]?.slice(1) ?? []
    }
    if (!emojis.length) {
      this._grid.innerHTML = `<div class="qu-ep-empty">Keine Emojis gefunden</div>`
      return
    }
    const frag = document.createDocumentFragment()
    emojis.forEach(emoji => {
      const cell = document.createElement('div')
      cell.className = 'qu-ep-cell'
      cell.textContent = emoji
      cell.title = emoji
      cell.addEventListener('click', () => this._pick(emoji))
      frag.appendChild(cell)
    })
    this._grid.appendChild(frag)
  }

  _pick(emoji) {
    const target = document.getElementById(this._targetId)
    if (target) {
      const start = target.selectionStart ?? target.value.length
      const end   = target.selectionEnd   ?? target.value.length
      target.value = target.value.slice(0, start) + emoji + target.value.slice(end)
      target.selectionStart = target.selectionEnd = start + emoji.length
      target.focus()
      target.dispatchEvent(new Event('input', { bubbles: true }))
    }
    this.dispatchEvent(new CustomEvent('qu-emoji-pick', { detail: { emoji }, bubbles: true }))
    this._close()
  }

  _toggle() { this._open ? this._close() : this._show() }
  _show() {
    this._open = true
    this._picker.classList.add('open')
    this._searchInput.value = ''
    this._query = ''
    this._renderGrid()
    setTimeout(() => this._searchInput.focus(), 50)
  }
  _close() {
    this._open = false
    this._picker.classList.remove('open')
  }
}



