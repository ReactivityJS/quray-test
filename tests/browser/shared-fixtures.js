import { Identity } from '../../src/core/identity.js'
import { QuDB, BLOB_STATUS } from '../../src/core/db.js'
import { MemoryBackend } from '../../src/backends/memory.js'
import { IdbBackend } from '../../src/backends/idb.js'
import { SignPlugin } from '../../src/plugins/sign.js'
import { VerifyPlugin } from '../../src/plugins/verify.js'
import { StoreInPlugin, StoreOutPlugin } from '../../src/plugins/store.js'
import { DispatchPlugin } from '../../src/plugins/dispatch.js'

function createMemoryDatabase(identity = null, extraBackends = {}) {
  const database = QuDB({
    backends: {
      '~': MemoryBackend(),
      '@': MemoryBackend(),
      '>': MemoryBackend(),
      'sys/': MemoryBackend(),
      'conf/': MemoryBackend(),
      'blobs/': MemoryBackend(),
      ...extraBackends,
    },
    identity,
  })

  database.use(StoreOutPlugin())
  database.use(StoreInPlugin())
  database.use(DispatchPlugin())

  if (identity) {
    database.use(SignPlugin(identity))
    database.use(VerifyPlugin(identity))
  }

  return database
}

async function createReadyMemoryDatabase(identity = null, extraBackends = {}) {
  const database = createMemoryDatabase(identity, extraBackends)
  await database.init()
  return database
}

async function createReadyIdentity(alias = 'Browser Test Identity') {
  return Identity({ alias })
}

async function clearIndexedDbDatabase(databaseName) {
  await new Promise((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(databaseName)
    deleteRequest.onsuccess = () => resolve()
    deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error('IndexedDB delete failed'))
    deleteRequest.onblocked = () => resolve()
  })
}

export {
  BLOB_STATUS,
  IdbBackend,
  clearIndexedDbDatabase,
  createMemoryDatabase,
  createReadyIdentity,
  createReadyMemoryDatabase,
}
