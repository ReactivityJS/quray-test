import { IdbBackend, clearIndexedDbDatabase } from '../shared-fixtures.js'

function registerIndexedDbBrowserSuite(registerSuite) {
  registerSuite('IndexedDB backend', 'Persistent browser backend contract', ({ test }) => {
    test('IdbBackend stores, reads and queries values by prefix', async ({ assertDeepEqual, assertEqual, createUniqueName }) => {
      const databaseName = createUniqueName('quray-idb')
      const indexedDbBackend = IdbBackend({ name: databaseName, openTimeout: 4000, txTimeout: 4000 })

      try {
        await indexedDbBackend.set('alpha/item-1', { value: 1 })
        await indexedDbBackend.set('alpha/item-2', { value: 2 })
        await indexedDbBackend.set('beta/item-1', { value: 3 })

        const firstValue = await indexedDbBackend.get('alpha/item-1')
        const alphaRows = await indexedDbBackend.query('alpha/')

        assertDeepEqual(firstValue, { value: 1 }, 'stored IndexedDB value')
        assertEqual(alphaRows.length, 2, 'IndexedDB prefix row count')
        assertDeepEqual(alphaRows.map((row) => row.key), ['alpha/item-1', 'alpha/item-2'], 'IndexedDB prefix keys')
      } finally {
        indexedDbBackend.close?.()
        await clearIndexedDbDatabase(databaseName)
      }
    })
  })
}

export { registerIndexedDbBrowserSuite }
