import { createQuBit } from '../../../src/core/qubit.js'
import { SignPlugin } from '../../../src/plugins/sign.js'
import { VerifyPlugin } from '../../../src/plugins/verify.js'
import { StoreInPlugin, StoreOutPlugin } from '../../../src/plugins/store.js'
import { DispatchPlugin } from '../../../src/plugins/dispatch.js'
import { QuDB } from '../../../src/core/db.js'
import { MemoryBackend } from '../../../src/backends/memory.js'
import { createReadyIdentity } from '../shared-fixtures.js'

async function createVerifyDatabase(identity) {
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
  database.use(StoreOutPlugin())
  database.use(StoreInPlugin())
  database.use(DispatchPlugin())
  await database.init()
  return database
}

function registerVerifyBrowserSuite(registerSuite) {
  registerSuite('Verify Plugin', 'Signature enforcement on incoming QuBits', ({ test }) => {

    test('signed outgoing write has valid sig and from fields', async ({ assert, assertEqual }) => {
      const identity = await createReadyIdentity('Verify Sign Alice')
      const db = await createVerifyDatabase(identity)
      const key = `~${identity.pub}/verify-signed-${Date.now()}`

      await db.put(key, { value: 'signed write' })
      const stored = await db.get(key)

      assert(!!stored?.sig, 'signed QuBit has signature')
      assertEqual(stored?.from, identity.pub, 'from matches author public key')
    })

    test('unsigned persistable QuBit is blocked by processIn', async ({ assertEqual }) => {
      const identity = await createReadyIdentity('Verify Block Alice')
      const db = await createVerifyDatabase(identity)
      const key = `@verify-unsigned/test-${Date.now()}`

      // Unsigned QuBit (no sig, no from) simulating a tampered or corrupt message
      const unsignedQuBit = createQuBit({ key, type: 'data', data: { value: 'tampered' } })
      delete unsignedQuBit.sig
      delete unsignedQuBit.from

      // VerifyPlugin calls stop() — processIn resolves without throwing but does not store
      await db.sync.processIn(unsignedQuBit, 'test-source').catch(() => {})

      const stored = await db.get(key, { includeDeleted: true })
      assertEqual(stored, null, 'unsigned persistable QuBit must not be stored')
    })

    test('QuBit with tampered data fails signature check', async ({ assert, assertEqual }) => {
      const aliceIdentity = await createReadyIdentity('Verify Tamper Alice')
      const aliceDb = await createVerifyDatabase(aliceIdentity)
      const bobIdentity = await createReadyIdentity('Verify Tamper Bob')
      const bobDb = await createVerifyDatabase(bobIdentity)

      // Alice writes and signs a QuBit
      const key = `~${aliceIdentity.pub}/tamper-test-${Date.now()}`
      await aliceDb.put(key, { text: 'original content' })
      const signedQuBit = await aliceDb.get(key)
      assert(!!signedQuBit?.sig, 'original QuBit is signed')

      // Tamper with the data after signing
      const tamperedQuBit = { ...signedQuBit, data: { text: 'tampered content' } }

      // Bob's db should reject the tampered QuBit
      await bobDb.sync.processIn(tamperedQuBit, 'relay-tamper').catch(() => {})
      const stored = await bobDb.get(key, { includeDeleted: true })
      assertEqual(stored, null, 'tampered QuBit not stored by recipient')
    })

    test('signaling-type QuBit without signature passes the pipeline', async ({ assert }) => {
      const identity = await createReadyIdentity('Verify Signaling Alice')
      const db = await createVerifyDatabase(identity)

      // NO_STORE_TYPES (peer.hello etc.) must pass without a signature
      const signalingQuBit = {
        type: 'peer.hello',
        key: `sys/peers/test-${Date.now()}`,
        from: identity.pub,
        ts: Date.now(),
        data: { alias: 'Test Peer', epub: identity.epub },
      }

      let didThrow = false
      try {
        await db.sync.processIn(signalingQuBit, 'test-source')
      } catch {
        didThrow = true
      }

      assert(!didThrow, 'signaling QuBit processIn does not throw')
    })
  })
}

export { registerVerifyBrowserSuite }
