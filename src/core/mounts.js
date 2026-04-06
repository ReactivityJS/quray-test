// ════════════════════════════════════════════════════════════════════════════
// QuRay — core/mounts.js
// Formal contract for all storage mount prefixes.
//
// Every key in QuDB belongs to exactly one mount. Mounts define:
//   prefix    — the key prefix that routes to this mount
//   sync      — whether this mount is replicated to remote peers
//   local     — whether this mount is device-local only
//   store     — the preferred backend type ('idb' | 'memory' | 'storage' | false)
//   desc      — human-readable description
//
// The longest matching prefix wins (handled by QuDB._resolveBackend).
//
// Mount table:
//   ~{pub64}/   USER  — user-owned, signed, synced across devices
//   @{id}/      SPACE — shared/app space, ACL-governed, synced
//   >{pub64}/   INBOX — relay writes, client reads, synced
//   sys/        SYS   — ephemeral RAM, never persisted, never synced
//   conf/       CONF  — local config, survives reload, never synced
//   blobs/      BLOBS — binary content-addressed blobs, local + relay-assisted
// ════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// MOUNT TABLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical mount descriptor map. Each entry describes a storage namespace.
 *
 * @example
 * import { MOUNT } from './mounts.js'
 * const m = MOUNT.USER  // { prefix: '~', sync: true, local: false, store: 'idb' }
 *
 * @group Core
 */
const MOUNT = {
  USER:  {
    prefix: '~',
    sync:   true,
    local:  false,
    store:  'idb',
    hard:   false,   // soft-delete (tombstone) so deletions sync
    desc:   'User space — ~{pub64}/...',
  },
  SPACE: {
    prefix: '@',
    sync:   true,
    local:  false,
    store:  'idb',
    hard:   false,
    desc:   'App / shared space — @{id}/...',
  },
  INBOX: {
    prefix: '>',
    sync:   true,
    local:  false,
    store:  'idb',
    hard:   false,
    desc:   'Inbox — >{pub64}/...',
  },
  SYS: {
    prefix: 'sys/',
    sync:   false,
    local:  true,
    store:  'memory',
    hard:   true,    // always hard-delete, ephemeral
    desc:   'Ephemeral runtime keys — sys/...',
  },
  CONF: {
    prefix: 'conf/',
    sync:   false,
    local:  true,
    store:  'storage',   // localStorage or equivalent
    hard:   true,
    desc:   'Local configuration — conf/...',
  },
  BLOBS: {
    prefix: 'blobs/',
    sync:   false,       // blob bytes are local; metadata (blob.meta QuBit) syncs via USER/SPACE
    local:  true,
    store:  'idb',
    hard:   true,
    desc:   'Binary blob store — blobs/{hash}',
  },
}


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Internal sorted array for fast prefix resolution (longest first)
const _orderedMounts = Object.values(MOUNT).sort((a, b) => b.prefix.length - a.prefix.length)

/**
 * Return the mount descriptor for the given key, or null if no mount matches.
 * Matches the longest prefix first.
 *
 * @param {string} key
 * @returns {MountDescriptor|null}
 * @group Core
 */
const mountFor = (key) => {
  if (!key) return null
  for (const m of _orderedMounts) {
    if (key.startsWith(m.prefix)) return m
  }
  return null
}

/**
 * True if the key belongs to a mount that replicates to remote peers.
 * @param {string} key
 * @returns {boolean}
 */
const isSyncable = (key) => mountFor(key)?.sync ?? false

/**
 * True if the key belongs to a device-local-only mount (never replicated).
 * @param {string} key
 * @returns {boolean}
 */
const isLocalOnly = (key) => mountFor(key)?.local ?? true

/**
 * True if the key should use hard-delete (no tombstone).
 * @param {string} key
 * @returns {boolean}
 */
const isHardDelete = (key) => mountFor(key)?.hard ?? false

/**
 * The prefix string for the given key's mount, or '' if none matches.
 * @param {string} key
 * @returns {string}
 */
const prefixFor = (key) => mountFor(key)?.prefix ?? ''

/**
 * All mount prefixes that sync to remote peers.
 * Useful for building sync scope lists.
 * @returns {string[]}
 */
const syncPrefixes = () => Object.values(MOUNT).filter(m => m.sync).map(m => m.prefix)

/**
 * All mount prefixes that are local-only (never replicated).
 * @returns {string[]}
 */
const localPrefixes = () => Object.values(MOUNT).filter(m => m.local).map(m => m.prefix)

/**
 * Regex that matches any local-only mount prefix.
 * Pre-compiled for use in hot paths (e.g. sync queue filter).
 *
 * @example
 * if (LOCAL_ONLY_RE.test(key)) return  // skip local-only keys
 */
const LOCAL_ONLY_RE = new RegExp(
  '^(' + localPrefixes().map(p => p.replace('/', '\\/')).join('|') + ')'
)


export {
  MOUNT,
  mountFor,
  isSyncable,
  isLocalOnly,
  isHardDelete,
  prefixFor,
  syncPrefixes,
  localPrefixes,
  LOCAL_ONLY_RE,
}
