import { KEY } from '../../../src/core/qubit.js'
import { createReadyIdentity, createReadyMemoryDatabase } from '../shared-fixtures.js'
import { registerComponents } from '../../../src/ui/components.js'

function registerIntegrationBrowserSuite(registerSuite) {
  registerSuite('Browser integration', 'Framework parts working together', ({ test }) => {
    test('blob status changes are visible through the unified db.on API', async ({ assertDeepEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      const blobHash = 'integration-blob-hash'
      const seenStatuses = []

      const stopListening = database.on(blobHash, (entry, meta) => {
        seenStatuses.push({
          status: entry?.status ?? null,
          event: meta.event,
          scope: meta.scope,
        })
      }, { scope: 'blob', immediate: false })

      await database.sync.setBlobStatus(blobHash, 'pending', null, { mime: 'image/png' })
      await database.sync.setBlobStatus(blobHash, 'ready', 'blob:integration', { mime: 'image/png' })

      await waitFor(() => {
        assertDeepEqual(seenStatuses, [
          { status: 'pending', event: 'blob-status', scope: 'blob' },
          { status: 'ready', event: 'blob-status', scope: 'blob' },
        ], 'blob status sequence')
      })

      stopListening()
    })

    test('database writes update a registered UI component reactively', async ({ assertEqual, sleep }) => {
      const identity = await createReadyIdentity('Browser Integration Alice')
      const database = await createReadyMemoryDatabase(identity)
      registerComponents(database, { me: { pub: identity.pub }, peers: null, net: null })

      const badgeElement = document.createElement('qu-badge')
      const aliasElement = document.createElement('qu-bind')
      aliasElement.setAttribute('key', '~/alias')
      document.body.appendChild(badgeElement)
      document.body.appendChild(aliasElement)

      await database.put(KEY.user(identity.pub).alias, 'Combined Alice')
      badgeElement.setAttribute('value', '3')
      await sleep(0)

      assertEqual(aliasElement.textContent.trim(), 'Combined Alice', 'alias text in combined test')
      assertEqual(badgeElement.textContent, '3', 'badge value in combined test')

      badgeElement.remove()
      aliasElement.remove()
    })
  })
}

export { registerIntegrationBrowserSuite }
