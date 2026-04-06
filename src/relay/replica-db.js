// ════════════════════════════════════════════════════════════════════════════
// QuRay — relay/replica-db.js
//
// Replica database for relay / router / Node.js peers.
//
// ┌─ Design principle ──────────────────────────────────────────────┐
// │  createReplicaDb accepts QuDB backend adapters from the caller. │
// │  It never imports node:fs or any environment-specific module.   │
// │  The relay runner decides which backends to use:                │
// │    - Node.js relay: FsBackend + BlobFsBackend                   │
// │    - In-memory test relay: MemoryBackend                        │
// │    - Browser embedded relay: IdbBackend                         │
// └────────────────────────────────────────────────────────────────┘
//
// Usage:
//   // Node.js relay (node:fs-based)
//   import { FsBackend, BlobFsBackend } from '../backends/fs.js'
//   const db = await createReplicaDb({
//     mainBackend: FsBackend({ dir: './data/msgs' }),
//     blobBackend: BlobFsBackend({ dir: './data/blobs' }),
//   })
//
//   // In-memory (tests, browser embedded relay)
//   import { MemoryBackend } from '../backends/memory.js'
//   const db = await createReplicaDb({
//     mainBackend: MemoryBackend(),
//     blobBackend: MemoryBackend(),
//   })
//
//   // With dataDir shorthand (Node.js only — caller provides FsBackend):
//   Not supported here. Create backends in the caller and inject them.
// ════════════════════════════════════════════════════════════════════════════

import { QuDB }           from '../core/db.js'
import { MemoryBackend }  from '../backends/memory.js'
import { NO_STORE_TYPES } from '../core/qubit.js'


/**
 * Create a ReplicaDB: a QuDB instance configured for relay/peer use.
 * Backends are injected — no runtime environment assumptions.
 *
 * @param {object} options
 * @param {BackendAdapter} [options.mainBackend]  - backend for all QuBit keys (default: MemoryBackend)
 * @param {BackendAdapter} [options.blobBackend]  - backend for blob bytes (default: MemoryBackend)
 * @returns {Promise<ReplicaDbInstance>}
 *
 * @example
 * // Node.js relay — inject FsBackend
 * import { FsBackend, BlobFsBackend } from '../backends/fs.js'
 * const replica = await createReplicaDb({
 *   mainBackend: FsBackend({ dir: './data/msgs' }),
 *   blobBackend: BlobFsBackend({ dir: './data/blobs' }),
 * })
 *
 * @example
 * // Test or browser embedded relay — pure memory
 * import { MemoryBackend } from '../backends/memory.js'
 * const replica = await createReplicaDb({
 *   mainBackend: MemoryBackend(),
 *   blobBackend: MemoryBackend(),
 * })
 */
const createReplicaDb = async (options = {}) => {
  const mainBackend = options.mainBackend ?? MemoryBackend()
  const blobBackend = options.blobBackend ?? MemoryBackend()

  const db = QuDB({
    backends: {
      '':       mainBackend,
      'blobs/': blobBackend,
    },
  })
  await db.init()

  // store: write a QuBit into the replica and fire the internal EventBus
  // so any db.on() listeners (e.g. subscriptions from other relay clients) fire.
  const store = async (qubit, source = 'remote') => {
    if (!qubit?.key || NO_STORE_TYPES.has(qubit.type)) return false
    await db._internal.write(qubit.key, qubit, source)
    await db._internal.bus.emit(qubit.key, qubit, {
      event:    qubit.deleted ? 'del' : 'put',
      key:      qubit.key,
      source,
      scope:    'data',
      current:  qubit,
      previous: null,
    })
    return true
  }

  const get     = (key)        => db.get(key)
  const query   = (prefix = '') => prefix ? db.query(prefix) : mainBackend.query('').then(rows => rows.map(r => r.val).filter(Boolean))
  const getKeys = async (prefix = '') => (await mainBackend.query(prefix)).map(r => r.key)
  const getMany = async (keys = []) => {
    const rows = []
    for (const key of keys) {
      const val = await db.get(key)
      if (val) rows.push({ key, val })
    }
    return rows
  }

  const putBlob = (hash, buffer) => blobBackend.set(hash, buffer)
  const getBlob = (hash)         => blobBackend.get(hash)

  return { db, store, get, query, getKeys, getMany, putBlob, getBlob }
}


export { createReplicaDb }
