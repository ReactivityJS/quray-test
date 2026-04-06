import { QuDB } from '../src/core/db.js'
import { MemoryBackend } from '../src/backends/memory.js'
import { Identity } from '../src/core/identity.js'
import { KEY, createQuBit } from '../src/core/qubit.js'
import { SignPlugin } from '../src/plugins/sign.js'
import { VerifyPlugin } from '../src/plugins/verify.js'
import { StoreInPlugin, StoreOutPlugin } from '../src/plugins/store.js'
import { DispatchPlugin } from '../src/plugins/dispatch.js'
import { AccessControlPlugin } from '../src/plugins/access.js'

let passedCount = 0
let failedCount = 0

async function runTest(testName, runTest) {
  try {
    await runTest()
    passedCount += 1
    console.log(`  ✓ ${testName}`)
  } catch (error) {
    failedCount += 1
    console.error(`  ✗ ${testName}`)
    console.error(`    ${error.message}`)
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function assertEqual(actualValue, expectedValue, message = 'assertEqual') {
  if (actualValue !== expectedValue) {
    throw new Error(`${message}: got ${JSON.stringify(actualValue)}, want ${JSON.stringify(expectedValue)}`)
  }
}

async function createProtectedDatabase(alias) {
  const identity = await Identity({ alias })
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

  return { identity, db: database }
}

async function seedRemoteQuBit(database, keyString, dataValue, fromPublicKey, type = 'data') {
  const qubit = createQuBit({ key: keyString, from: fromPublicKey, type, data: dataValue })
  await database._internal.write(keyString, qubit, 'seed')
}

console.log('\n── Access control')

await runTest('space owner can create ACL and write protected space data', async () => {
  const { identity, db } = await createProtectedDatabase('ACL Owner Alice')
  const spaceId = 'space-owner-ok'

  await db.put(KEY.space(spaceId).acl, {
    owner: identity.pub,
    writers: [identity.pub],
  }, { type: 'space.acl' })

  const allowedEntryKey = KEY.space(spaceId).entry('notes', 'entry-1')
  await db.put(allowedEntryKey, { title: 'Owner write allowed' })
  const storedQuBit = await db.get(allowedEntryKey)
  assertEqual(storedQuBit?.data?.title, 'Owner write allowed', 'owner write persisted')
})

await runTest('non-authorized local writer is rejected for protected space data', async () => {
  const { identity: ownerIdentity } = await createProtectedDatabase('ACL Owner Seed')
  const { identity: intruderIdentity, db: intruderDatabase } = await createProtectedDatabase('ACL Intruder Bob')
  const spaceId = 'space-intruder-denied'

  await seedRemoteQuBit(
    intruderDatabase,
    KEY.space(spaceId).acl,
    { owner: ownerIdentity.pub, writers: [ownerIdentity.pub] },
    ownerIdentity.pub,
    'space.acl',
  )

  const deniedEntryKey = KEY.space(spaceId).entry('notes', 'entry-2')
  let thrownError = null
  try {
    await intruderDatabase.put(deniedEntryKey, { title: 'Should fail' })
  } catch (error) {
    thrownError = error
  }

  assert(thrownError instanceof Error, 'unauthorized write should throw')
  assert(thrownError.message.includes('write denied'), 'error should mention denied write')

  const storedQuBit = await intruderDatabase.get(deniedEntryKey, { includeDeleted: true })
  assertEqual(storedQuBit, null, 'unauthorized write was not persisted locally')
  assert(intruderIdentity.pub !== ownerIdentity.pub, 'test identities must differ')
})

await runTest('incoming unauthorized remote write is rejected before storage', async () => {
  const { identity: ownerIdentity } = await createProtectedDatabase('ACL Remote Owner')
  const { identity: intruderIdentity, db } = await createProtectedDatabase('ACL Remote Relay Guard')
  const spaceId = 'space-remote-denied'

  await seedRemoteQuBit(
    db,
    KEY.space(spaceId).acl,
    { owner: ownerIdentity.pub, writers: [ownerIdentity.pub] },
    ownerIdentity.pub,
    'space.acl',
  )

  const unauthorizedIncomingQuBit = createQuBit({
    key: KEY.space(spaceId).entry('notes', 'entry-3'),
    from: intruderIdentity.pub,
    type: 'data',
    data: { title: 'Remote intruder write' },
  })

  let thrownError = null
  try {
    await db.sync.processIn(unauthorizedIncomingQuBit, 'relay-test')
  } catch (error) {
    thrownError = error
  }

  assert(thrownError instanceof Error, 'incoming unauthorized write should throw')
  const storedQuBit = await db.get(unauthorizedIncomingQuBit.key, { includeDeleted: true })
  assertEqual(storedQuBit, null, 'incoming unauthorized write was rejected')
})

console.log('\n──────────────────────────────────────────────────')
console.log(`  ${passedCount} passed, ${failedCount} failed`)
process.exit(failedCount > 0 ? 1 : 0)
