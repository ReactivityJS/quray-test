import { sha256b64url } from './identity.js'

// ════════════════════════════════════════════════════════════════════════════
// QuRay — qubit.js  (v0.9)
// Datenformat, Kanonisierung und Key-Schema.
//
// ┌─ Key-Schema ───────────────────────────────────────────────────────────┐
// │                                                                        │
// │  ~{pub64}/           User-Space (pub64 = base64url des ECDSA-Pub-Key) │
// │    ~{pub64}/pub      ← Signing-Key  (ECDSA, für Verifikation)         │
// │    ~{pub64}/epub     ← ECDH-Pub-Key (für Envelope-Verschlüsselung)    │
// │    ~{pub64}/alias    ← Anzeigename (String)                            │
// │    ~{pub64}/chat/{ts16}-{id}  ← gesendete Nachrichten                 │
// │    ~{pub64}/blob/{hash}       ← Blob-Metadaten                        │
// │    (beliebige App-Keys zulässig: ~{pub}/status, ~/avatar …)           │
// │                                                                        │
// │  >{pub64}/           Inbox (Relay-internal, nie direkt schreibbar)    │
// │    >{pub64}/{ts16}-{id}  ← eingehende DMs (Relay schreibt hierher)    │
// │                                                                        │
// │  @{uuid}/            App/Raum-Space (uuid = crypto.randomUUID())      │
// │    @{uuid}/~acl      ← writers: ['*'|pub64,…], owner: pub64           │
// │    @{uuid}/~meta     ← name, desc, version, created                   │
// │    @{uuid}/members/{pub64}  ← true (atomare Mitgliedschaft)           │
// │    @{uuid}/chat/{ts16}-{id} ← Nachrichten                             │
// │                                                                        │
// │  sys/                RAM-only, nie persistiert                         │
// │                                                                        │
// ├─ Prinzip: atomare Keys ────────────────────────────────────────────────┤
// │  Jeder Key enthält genau einen Wert (String, Number, Bool, flaches    │
// │  Objekt). Kein verschachteltes Objekt als ~{pub}-Root.                │
// │  → Granularer Diff-Sync, unabhängige Änderungen, kein LWW-Konflikt   │
// │                                                                        │
// ├─ QuBit-Typen ──────────────────────────────────────────────────────────┤
// │  'data'   universeller Daten-QuBit: key → data (atomarer Wert)        │
// │           Relay speichert, broadcastet, prüft Write-Authority          │
// │           Deckt ab: Profile-Props, App-Daten, Space-Metadaten         │
// │  'msg'    Nachricht (enc: 'env-aes-gcm' für E2E)                      │
// │  'blob.*' Blob-Lifecycle (req/chunk/ready/meta)                        │
// │  'peer.*' Peer-Discovery (RAM-only, nicht persistiert)                 │
// │  'webrtc.*' Signaling (RAM-only)                                       │
// │                                                                        │
// ├─ Verschlüsselung ──────────────────────────────────────────────────────┤
// │  enc: 'env-aes-gcm'  Envelope: ein Content-Key, je Empfänger         │
// │       gewickelt (Sender ist immer Empfänger Nr. 1)                    │
// │       data: { ct, iv, epub, keys: { pub→{ct,iv} } }                  │
// │  enc: 'ecdh-aes-gcm' Legacy DM (Abwärtskompatibilität)               │
// │                                                                        │
// ├─ Write-Authority ──────────────────────────────────────────────────────┤
// │  ~{pub64}/  → qubit.from muss pub64 sein (Relay enforced)             │
// │  >{pub64}/  → Relay-intern, nicht von Clients schreibbar               │
// │  @{uuid}/   → writers in @{uuid}/~acl: ['*'] oder [pub64,…]          │
// │  sys/       → nie persistiert                                          │
// │                                                                        │
// ├─ Sync-Scope (pro Client) ──────────────────────────────────────────────┤
// │  ~{meinPub64}/    eigene Daten + Profil                               │
// │  >{meinPub64}/    eigene Inbox                                         │
// │  ~{kontakt}/pub|epub|alias  selektive Kontakt-Profile                  │
// │  @{id}/           beigetretene Räume                                   │
// └────────────────────────────────────────────────────────────────────────┘
//
// WICHTIG: pub64 kommt aus identity.js — dort ist die einzige Implementierung.
// ════════════════════════════════════════════════════════════════════════════

import { pub64 } from './identity.js'


// ─────────────────────────────────────────────────────────────────────────────
// TYPEN
// ─────────────────────────────────────────────────────────────────────────────
const QUBIT_TYPE = {
  DATA:           'data',         // universeller atomarer Daten-QuBit
  MSG:            'msg',
  BLOB_META:      'blob.meta',
  BLOB_READY:     'blob.ready',  // broadcast: blob available at relay
  SPACE_JOIN:     'space.join',  // ephemeral: client joins a space
  TYPING:         'typing',      // ephemeral: typing indicator
  MSG_DELIVERED:  'msg.delivered',// receipt: message delivered to device
  MSG_READ:       'msg.read',    // receipt: message seen by user
  MSG_READPOS:    'msg.readpos', // receipt: read position in conversation
  WEBRTC_HANGUP:  'webrtc.hangup',
  SPACE_ACL:      'space.acl',
  SPACE_META:     'space.meta',
  PEER_HELLO:     'peer.hello',
  PEER_BYE:       'peer.bye',
  PEERS_REQ:      'peers.req',
  PEERS_LIST:     'peers.list',
  BLOB_REQ:       'blob.req',
  BLOB_CHUNK:     'blob.chunk',
  DB_SUB:         'db.sub',
  DB_UNSUB:       'db.unsub',
  DB_PUSH:        'db.push',
  DB_RES:         'db.res',
  WEBRTC_OFFER:   'webrtc.offer',
  WEBRTC_ANSWER:  'webrtc.answer',
  WEBRTC_ICE:     'webrtc.ice',
}


// ─────────────────────────────────────────────────────────────────────────────
// NO_STORE — nie persistiert
// ─────────────────────────────────────────────────────────────────────────────
const NO_STORE_TYPES = new Set([
  QUBIT_TYPE.PEER_HELLO, QUBIT_TYPE.PEER_BYE,
  QUBIT_TYPE.PEERS_REQ,  QUBIT_TYPE.PEERS_LIST,
  QUBIT_TYPE.BLOB_REQ,   QUBIT_TYPE.BLOB_CHUNK,
  QUBIT_TYPE.BLOB_READY,                         // broadcast — no key, never stored
  QUBIT_TYPE.DB_SUB,     QUBIT_TYPE.DB_UNSUB,
  QUBIT_TYPE.DB_PUSH,    QUBIT_TYPE.DB_RES,
  QUBIT_TYPE.WEBRTC_OFFER, QUBIT_TYPE.WEBRTC_ANSWER, QUBIT_TYPE.WEBRTC_ICE,
  QUBIT_TYPE.TYPING,
  'msg.receipt',  // read receipts are ephemeral
])




// ─────────────────────────────────────────────────────────────────────────────
// KANONISIERUNG
// ─────────────────────────────────────────────────────────────────────────────
const QUBIT_SIGN_KEYS = ['id', 'key', 'from', 'ts', 'type', 'data', 'enc', 'refs', 'order', 'deleted']

const canonicalizeQuBit = (qubit) =>
  JSON.stringify(
    QUBIT_SIGN_KEYS.reduce((acc, k) => { acc[k] = qubit[k] ?? null; return acc }, {})
  )


// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────
const createQuBit = ({
  key, from, type = QUBIT_TYPE.MSG,
  data = null, enc = null, refs = [], order = null, hash = null, deleted = false,
} = {}) => ({
  id:    crypto.randomUUID(),
  key,   from,
  ts:    Date.now(),
  type,  data,  enc,
  refs:  refs ?? [],
  order: order ?? null,
  deleted: Boolean(deleted),
  sig:   null,
  hash:  hash ?? null,
  _status:  'local',
  _retries: 0,
  _localTs: Date.now(),
})


// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT-REINIGUNG
// ─────────────────────────────────────────────────────────────────────────────
const QUBIT_TRANSPORT_KEYS = [...QUBIT_SIGN_KEYS, 'sig', 'hash']

const cleanQuBitForTransport = (qubit) =>
  QUBIT_TRANSPORT_KEYS.reduce((clean, k) => {
    if (qubit[k] !== undefined) clean[k] = qubit[k]
    return clean
  }, {})


// ─────────────────────────────────────────────────────────────────────────────
// VALIDIERUNG
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_QUBIT_FIELDS = ['id', 'key', 'from', 'ts', 'type']

const isValidQuBit = (q) => {
  if (!q || typeof q !== 'object') return false
  for (const f of REQUIRED_QUBIT_FIELDS) {
    if (q[f] == null) { /*DEBUG*/ console.debug('[QuRay:qubit] Pflichtfeld fehlt:', f); return false }
  }
  if (typeof q.ts !== 'number' || q.ts <= 0 || !isFinite(q.ts)) return false
  return true
}


// ─────────────────────────────────────────────────────────────────────────────
// VERSCHLÜSSELUNGS-ERKENNUNG
// ─────────────────────────────────────────────────────────────────────────────
const isEncryptedData = (d) => d !== null && typeof d === 'object' && typeof d.ct === 'string' && typeof d.iv === 'string'
const isEnvelopeData  = (d) => isEncryptedData(d) && typeof d.keys === 'object'
const isDirectData    = (d) => isEncryptedData(d) && !d.keys

const isDeletedQuBit = (qubit) => Boolean(qubit?.deleted === true || qubit?.data?.deleted === true)


// ─────────────────────────────────────────────────────────────────────────────
// KEY-SCHEMA
//
// pub64() aus identity.js ist die einzige Quelle der base64url-Konvertierung.
// Alle KEY.*-Helfer akzeptieren raw pub (SPKI base64) und rufen pub64() intern.
// ─────────────────────────────────────────────────────────────────────────────

// Sortierbar: 16-stelliger zero-padded Timestamp (ms)
const ts16 = (ms = Date.now()) => String(ms).padStart(16, '0')


// ── Space-Erkennung ───────────────────────────────────────────────────────────

const SPACE_RE = {
  USER:  /^~([^/]+)\//,    // ~{pub64}/...
  INBOX: /^>([^/]+)\//,    // >{pub64}/...
  APP:   /^@([^/]+)\//,    // @{uuid}/...
  SYS:   /^sys\//,
}

const spaceOf = (key) => {
  if (!key) return null
  if (SPACE_RE.USER.test(key))  return { type: 'user',  id: key.match(SPACE_RE.USER)[1]  }
  if (SPACE_RE.INBOX.test(key)) return { type: 'inbox', id: key.match(SPACE_RE.INBOX)[1] }
  if (SPACE_RE.APP.test(key))   return { type: 'app',   id: key.match(SPACE_RE.APP)[1]   }
  if (SPACE_RE.SYS.test(key))   return { type: 'sys',   id: null }
  return null
}

const isUserSpace  = (key) => SPACE_RE.USER.test(key)
const isInboxSpace = (key) => SPACE_RE.INBOX.test(key)
const isAppSpace   = (key) => SPACE_RE.APP.test(key)
const isSysSpace   = (key) => SPACE_RE.SYS.test(key)


// ── Kanonische Key-Builder ────────────────────────────────────────────────────
//
// Zwei Syntaxvarianten — beide erzeugen identische Keys:
//
//   Chainable (empfohlen):
//     KEY.user(pub).root              → ~{pub64}
//     KEY.user(pub).space             → ~{pub64}/
//     KEY.user(pub).field('alias')    → ~{pub64}/alias
//     KEY.user(pub).entry('posts', id) → ~{pub64}/posts/{ts16}-{id}
//     KEY.user(pub).blob(hash)        → ~{pub64}/blob/{hash}
//     KEY.space(id).meta              → @{uuid}/~meta
//     KEY.space(id).acl               → @{uuid}/~acl
//     KEY.space(id).entry('chat', id) → @{uuid}/chat/{ts16}-{id}
//
//   Flat (Rückwärtskompatibilität, nicht deprecated):
//     KEY.userNode(pub), KEY.userSpace(pub), KEY.spaceMsg(id, ...), etc.
//

// ── User-Space Builder ────────────────────────────────────────────────────────

const createUserKeyBuilder = (publicKey) => {
  const publicKeyBase64Url = pub64(publicKey)
  return {
    get root()  { return `~${publicKeyBase64Url}` },
    get space() { return `~${publicKeyBase64Url}/` },
    get alias() { return `~${publicKeyBase64Url}/alias` },
    get avatar() { return `~${publicKeyBase64Url}/avatar` },
    get pub() { return `~${publicKeyBase64Url}/pub` },
    get epub() { return `~${publicKeyBase64Url}/epub` },
    field: (fieldName) => `~${publicKeyBase64Url}/${fieldName}`,
    entry: (collectionName, entryId, timestampMs = Date.now()) => `~${publicKeyBase64Url}/${collectionName}/${ts16(timestampMs)}-${entryId}`,
    blob: (blobHash) => `~${publicKeyBase64Url}/blob/${blobHash}`,
  }
}

// ── Shared Space Builder ──────────────────────────────────────────────────────

const createSpaceKeyBuilder = (spaceId) => ({
  get root()    { return `@${spaceId}/` },
  get meta()    { return `@${spaceId}/~meta` },
  get acl()     { return `@${spaceId}/~acl` },
  get members() { return `@${spaceId}/members/` },
  field: (name)                          => `@${spaceId}/${name}`,
  entry: (collection, id, tsMs = Date.now()) => `@${spaceId}/${collection}/${ts16(tsMs)}-${id}`,
})

// ── Inbox Builder ─────────────────────────────────────────────────────────────

const createInboxKeyBuilder = (pub) => {
  const p = pub64(pub)
  return {
    get root() { return `>${p}/` },
    entry: (tsMs = Date.now(), id = crypto.randomUUID()) => `>${p}/${ts16(tsMs)}-${id}`,
  }
}

// ── Unified KEY object ────────────────────────────────────────────────────────

/**
 * Chainable key builder and utility functions for all QuRay storage keys.
 *
 * Key schema:
 *   ~{pub}/...    User-space (signed by owner, IDB, synced)
 *   @{id}/...     App-space (ACL-controlled, IDB, synced)
 *   >{pub}/...    Inbox (write-by-anyone, IDB, synced)
 *   sys/...       Ephemeral (RAM only, never persisted)
 *   conf/...      Config (LocalStorage, local only, never synced)
 *   blobs/...     Binary content (IDB, content-addressed by SHA-256)
 *
 * @group Database
 * @since 0.1.0
 *
 * @example
 * // User-space builders
 * KEY.user(me.pub).field('alias')     // '~{pub}/alias'
 * KEY.user(me.pub).field('avatar')    // '~{pub}/avatar'
 * KEY.user(me.pub).root               // '~{pub}'
 * KEY.user(me.pub).space              // '~{pub}/'
 * KEY.user(me.pub).entry('notes', id) // '~{pub}/notes/{ts16}-{id}'
 *
 * @example
 * // Space (room/DM) builders
 * KEY.space(id).meta               // '@{id}/~meta'
 * KEY.space(id).acl                // '@{id}/~acl'
 * KEY.space(id).members            // '@{id}/members/'
 * KEY.space(id).field('chat')      // '@{id}/chat'
 * KEY.space(id).entry('chat', id)  // '@{id}/chat/{ts16}-{id}'
 * KEY.inbox(me.pub).root           // '>{pub}/'
 *
 * @example
 * // Utilities
 * KEY.ts16()                        // '0193abc4d8f00001' (sortable 16-char hex)
 * KEY.pub64(rawPub)                 // base64url-normalised public key
 * await KEY.sha256url(arrayBuffer)  // SHA-256 → base64url (for blob hashing)
 */
const KEY = {
  // ── Chainable builders (primary API) ──────────────────────────────────────
  user:  (pub)     => createUserKeyBuilder(pub),
  space: (spaceId) => createSpaceKeyBuilder(spaceId),
  inbox: (pub)     => createInboxKeyBuilder(pub),

  // ── sys/ (flat, no builder needed) ────────────────────────────────────────
  peer:   (pub)       => `sys/peers/${pub64(pub)}`,
  webrtc: (sessionId) => `sys/webrtc/${sessionId}`,

  // ── Flat helpers for direct key construction ──────────────────────────────
  userNode:    (pub)                               => `~${pub64(pub)}`,
  userSpace:   (pub)                               => `~${pub64(pub)}/`,
  msg:         (pub, type, id, ts = Date.now())    => `~${pub64(pub)}/${type}/${ts16(ts)}-${id}`,
  msgPrefix:   (pub, type)                         => type ? `~${pub64(pub)}/${type}/` : `~${pub64(pub)}/`,
  blobMeta:    (pub, hash)                         => `~${pub64(pub)}/blob/${hash}`,
  spaceMsg:    (id, type, msgId, ts = Date.now())  => `@${id}/${type}/${ts16(ts)}-${msgId}`,
  spaceAcl:    (id)                                => `@${id}/~acl`,
  spaceMeta:   (id)                                => `@${id}/~meta`,
  spacePrefix: (id)                                => `@${id}/`,
  inboxEntry:  (pub, ts = Date.now(), id = crypto.randomUUID()) => `>${pub64(pub)}/${ts16(ts)}-${id}`,
  inboxPrefix: (pub)                               => `>${pub64(pub)}/`,
  // Named config keys
  identity: () => 'conf/identity',

  // ── Utilities ────────────────────────────────────────────────────────────
  resolve: (keyReference, options = {}) => resolveStorageKeyReference(keyReference, options),
  sha256url: sha256b64url,  // async (buf: ArrayBuffer) → string (base64url SHA-256)
  ts16,                     // (ts?: number) → 16-char hex timestamp string
  pub64,                    // (pub: string) → base64url-normalised public key
}


/**
 * Resolve shorthand storage key references into canonical storage keys.
 *
 * Supported shorthand forms:
 *   ~        -> ~<currentUserPublicKey>
 *   ~/       -> ~<currentUserPublicKey>/
 *   ~/alias  -> ~<currentUserPublicKey>/alias
 *
 * If no current user public key is available, the original key reference is returned unchanged.
 * This keeps the helper safe for parser passes that may run before identity bootstrapping.
 */
const resolveStorageKeyReference = (keyReference, { currentUserPublicKey = null } = {}) => {
  if (typeof keyReference !== 'string') return keyReference ?? null

  const trimmedKeyReference = keyReference.trim()
  if (!trimmedKeyReference) return null

  if (!currentUserPublicKey) return trimmedKeyReference

  const resolvedCurrentUserKey = pub64(currentUserPublicKey)
  if (trimmedKeyReference === '~') return `~${resolvedCurrentUserKey}`
  if (trimmedKeyReference === '~/') return `~${resolvedCurrentUserKey}/`
  if (trimmedKeyReference.startsWith('~/')) return `~${resolvedCurrentUserKey}${trimmedKeyReference.slice(1)}`

  return trimmedKeyReference
}


// ── Sync-Scope Ableitung ──────────────────────────────────────────────────────

const syncScopesFor = (pub, joinedSpaces = []) => [
  `~${pub64(pub)}/`,
  `>${pub64(pub)}/`,
  ...joinedSpaces.map(id => `@${id}/`),
]


// ─────────────────────────────────────────────────────────────────────────────
// FRACTIONAL INDEXING
// ─────────────────────────────────────────────────────────────────────────────
const orderBetween = (a, b) => (a + b) / 2
const orderBefore  = (a)    => a / 2
const orderAfter   = (a)    => a + 1.0
const FRACTIONAL_PRECISION_THRESHOLD = 1e-10
const needsRebalancing = (a, b) => Math.abs(b - a) < FRACTIONAL_PRECISION_THRESHOLD
const rebalanceOrders  = (items, start = 0.1, step = 0.1) =>
  items.map((item, i) => ({ item, newOrder: start + i * step }))


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export {
  QUBIT_TYPE, NO_STORE_TYPES,
  QUBIT_SIGN_KEYS, QUBIT_TRANSPORT_KEYS,
  canonicalizeQuBit, createQuBit, cleanQuBitForTransport,
  isValidQuBit,
  isEncryptedData, isEnvelopeData, isDirectData, isDeletedQuBit,
  ts16, pub64, sha256b64url, KEY, resolveStorageKeyReference,
  spaceOf, isUserSpace, isInboxSpace, isAppSpace, isSysSpace,
  syncScopesFor,
  orderBetween, orderBefore, orderAfter,
  needsRebalancing, rebalanceOrders, FRACTIONAL_PRECISION_THRESHOLD,
}
