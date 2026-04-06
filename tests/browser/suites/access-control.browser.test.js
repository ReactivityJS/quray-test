import { KEY, createQuBit } from '../../../src/core/qubit.js'
import { AccessControlPlugin } from '../../../src/plugins/access.js'
import { SignPlugin } from '../../../src/plugins/sign.js'
import { VerifyPlugin } from '../../../src/plugins/verify.js'
import { StoreInPlugin, StoreOutPlugin } from '../../../src/plugins/store.js'
import { DispatchPlugin } from '../../../src/plugins/dispatch.js'
import { QuDB } from '../../../src/core/db.js'
import { MemoryBackend } from '../../../src/backends/memory.js'
import { createReadyIdentity } from '../shared-fixtures.js'

async function createProtectedDatabase(identity) {
  const database = QuDB({
    backends: {
      '~': MemoryBackend(),
      '@': MemoryBackend(),
      '>': MemoryBackend(),
      'sys/': MemoryBackend(),
      'conf/': MemoryBackend(),
      'blobs/': MemoryBackend(),
    },
    identity,
  })
  database.use(SignPlugin(identity))
  database.use(VerifyPlugin(identity))
  database.use(AccessControlPlugin())
  database.use(StoreOutPlugin())
  database.use(StoreInPlugin())
  database.use(DispatchPlugin())
  await database.init()
  return database
}

function registerAccessControlBrowserSuite(registerSuite) {
  registerSuite('Access Control', 'ACL enforcement for spaces and user namespaces', ({ test }) => {

    test('space owner can create ACL and write to the space', async ({ assert, assertEqual }) => {
      const identity = await createReadyIdentity('ACL Owner Alice')
      const db = await createProtectedDatabase(identity)
      const spaceId = `acl-owner-${Date.now()}`

      await db.put(KEY.space(spaceId).acl, { owner: identity.pub, writers: [identity.pub] })

      const entryKey = KEY.space(spaceId).entry('notes', 'entry-1')
      await db.put(entryKey, { title: 'Owner write allowed' })
      const stored = await db.get(entryKey)
      assertEqual(stored?.data?.title, 'Owner write allowed', 'owner write persisted')
    })

    test('open space (no ACL) allows any authenticated write', async ({ assert }) => {
      const identity = await createReadyIdentity('Open Space Alice')
      const db = await createProtectedDatabase(identity)
      const spaceId = `open-space-${Date.now()}`

      const entryKey = `@${spaceId}/item-1`
      await db.put(entryKey, { note: 'open write' })
      const stored = await db.get(entryKey)
      assert(stored?.data?.note === 'open write', 'open space allows authenticated write')
    })

    test('user namespace rejects writes from other actors', async ({ assert, assertEqual }) => {
      const ownerIdentity = await createReadyIdentity('Namespace Owner')
      const intruderIdentity = await createReadyIdentity('Namespace Intruder')
      const db = await createProtectedDatabase(intruderIdentity)

      const ownerKey = `~${ownerIdentity.pub}/notes/private`
      let thrownError = null
      try {
        await db.put(ownerKey, { data: 'should not be allowed' })
      } catch (error) {
        thrownError = error
      }

      assert(thrownError instanceof Error, 'write to foreign namespace should throw')
      assert(thrownError.message.includes('write denied'), 'error message mentions denied')
      const stored = await db.get(ownerKey, { includeDeleted: true })
      assertEqual(stored, null, 'unauthorized write not persisted')
    })

    test('non-owner write to protected space is rejected', async ({ assert, assertEqual }) => {
      const ownerIdentity = await createReadyIdentity('Protected Space Owner')
      const intruderIdentity = await createReadyIdentity('Protected Space Intruder')
      const intruderDb = await createProtectedDatabase(intruderIdentity)
      const spaceId = `protected-space-${Date.now()}`

      // Seed ACL as if received from owner via relay
      const aclQuBit = createQuBit({
        key: KEY.space(spaceId).acl,
        from: ownerIdentity.pub,
        type: 'space.acl',
        data: { owner: ownerIdentity.pub, writers: [ownerIdentity.pub] },
      })
      await intruderDb._internal.write(KEY.space(spaceId).acl, aclQuBit, 'seed')

      const deniedKey = KEY.space(spaceId).entry('notes', 'entry-2')
      let thrownError = null
      try {
        await intruderDb.put(deniedKey, { title: 'Intruder write' })
      } catch (error) {
        thrownError = error
      }

      assert(thrownError instanceof Error, 'protected space write should throw')
      assert(thrownError.message.includes('write denied'), 'error message mentions denied')
      const stored = await intruderDb.get(deniedKey, { includeDeleted: true })
      assertEqual(stored, null, 'intruder write not persisted')
    })

    test('users listed in writers can write to the space', async ({ assert }) => {
      const ownerIdentity = await createReadyIdentity('Shared Space Owner')
      const writerIdentity = await createReadyIdentity('Shared Space Writer')
      const writerDb = await createProtectedDatabase(writerIdentity)
      const spaceId = `shared-space-${Date.now()}`

      // Seed ACL with writer in list
      const aclQuBit = createQuBit({
        key: KEY.space(spaceId).acl,
        from: ownerIdentity.pub,
        type: 'space.acl',
        data: { owner: ownerIdentity.pub, writers: [ownerIdentity.pub, writerIdentity.pub] },
      })
      await writerDb._internal.write(KEY.space(spaceId).acl, aclQuBit, 'seed')

      const allowedKey = `@${spaceId}/collab-doc`
      await writerDb.put(allowedKey, { text: 'Collaborator write' })
      const stored = await writerDb.get(allowedKey)
      assert(stored?.data?.text === 'Collaborator write', 'listed writer can write')
    })

    test('writers:* allows any authenticated actor', async ({ assert }) => {
      const ownerIdentity = await createReadyIdentity('Wildcard Space Owner')
      const anyoneIdentity = await createReadyIdentity('Wildcard Space Anyone')
      const anyoneDb = await createProtectedDatabase(anyoneIdentity)
      const spaceId = `wildcard-space-${Date.now()}`

      const aclQuBit = createQuBit({
        key: KEY.space(spaceId).acl,
        from: ownerIdentity.pub,
        type: 'space.acl',
        data: { owner: ownerIdentity.pub, writers: '*' },
      })
      await anyoneDb._internal.write(KEY.space(spaceId).acl, aclQuBit, 'seed')

      const openKey = `@${spaceId}/public-item`
      await anyoneDb.put(openKey, { text: 'Anyone can write' })
      const stored = await anyoneDb.get(openKey)
      assert(stored?.data?.text === 'Anyone can write', 'wildcard write allowed')
    })

    test('incoming unauthorized QuBit via processIn is rejected before storage', async ({ assert, assertEqual }) => {
      const ownerIdentity = await createReadyIdentity('Remote Owner')
      const intruderIdentity = await createReadyIdentity('Remote Intruder')
      const guardDb = await createProtectedDatabase(ownerIdentity)
      const spaceId = `remote-denied-${Date.now()}`

      // Seed ACL on guard's db
      const aclQuBit = createQuBit({
        key: KEY.space(spaceId).acl,
        from: ownerIdentity.pub,
        type: 'space.acl',
        data: { owner: ownerIdentity.pub, writers: [ownerIdentity.pub] },
      })
      await guardDb._internal.write(KEY.space(spaceId).acl, aclQuBit, 'seed')

      // Simulate incoming unauthorized write from relay
      const incomingQuBit = createQuBit({
        key: KEY.space(spaceId).entry('notes', 'entry-3'),
        from: intruderIdentity.pub,
        type: 'data',
        data: { title: 'Remote intruder write' },
      })

      let thrownError = null
      try {
        await guardDb.sync.processIn(incomingQuBit, 'relay-test')
      } catch (error) {
        thrownError = error
      }

      assert(thrownError instanceof Error, 'incoming unauthorized write should throw')
      const stored = await guardDb.get(incomingQuBit.key, { includeDeleted: true })
      assertEqual(stored, null, 'incoming unauthorized write was not stored')
    })
  })
}

export { registerAccessControlBrowserSuite }
