/**
 * @module quray-core
 * @group QuRay
 * @description
 * Minimal QuRay bundle: reactive database, cryptographic identity, and key
 * utilities. No sync, no UI components, no relay dependency. ~15KB gz.
 *
 * Use this when embedding QuRay as a reactive local DB into an existing app.
 *
 * @example
 * import { QuDB, Identity, KEY, MemoryBackend, IdbBackend } from './dist/quray-core.js'
 *
 * const id = await Identity({ alias: 'Alice' })
 * const db = QuDB({ backends: {
 *   '~': IdbBackend({ name: 'quray-' + id.pub.slice(0,12) }),
 *   '@': IdbBackend({ name: 'quray-' + id.pub.slice(0,12) }),
 *   'sys/': MemoryBackend(), 'conf/': MemoryBackend(),
 *   '>': IdbBackend({ name: 'quray-' + id.pub.slice(0,12) }),
 *   'blobs/': IdbBackend({ name: 'quray-blobs' }),
 * }})
 * await db.init()
 *
 * await db.put('~' + id.pub + '/alias', 'Alice')
 * db.on('~' + id.pub + '/alias', q => console.log(q?.data))
 */
// QuRay Core — reactive DB + identity (no sync, no UI)
export { QuDB }              from './core/db.js'
export { Identity,
         sha256b64url }      from './core/identity.js'
export { EventBus }          from './core/events.js'
export { KEY, ts16, pub64,
         createQuBit,
         QUBIT_TYPE }        from './core/qubit.js'
export { DeliveryTracker }   from './core/delivery.js'
export { MemoryBackend,
         LocalStorageBackend } from './backends/memory.js'
export { IdbBackend }        from './backends/idb.js'
export { StoreInPlugin,
         StoreOutPlugin }    from './plugins/store.js'
export { DispatchPlugin }    from './plugins/dispatch.js'
