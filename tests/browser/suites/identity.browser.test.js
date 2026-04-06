import { createReadyIdentity, createReadyMemoryDatabase } from '../shared-fixtures.js'

function registerIdentityBrowserSuite(registerSuite) {
  registerSuite('Identity and signed writes', 'Browser crypto pipeline', ({ test }) => {
    test('signed writes keep the author public key', async ({ assert }) => {
      const identity = await createReadyIdentity('Browser Alice')
      const database = await createReadyMemoryDatabase(identity)
      const recordKey = `~${identity.pub}/alias`

      await database.put(recordKey, 'Browser Alice')
      const storedQuBit = await database.get(recordKey)

      assert(storedQuBit?.from === identity.pub, 'signed author public key should match identity')
      assert(!!storedQuBit?.sig, 'signature should be present')
    })
  })
}

export { registerIdentityBrowserSuite }
