import { KEY } from '../../../src/core/qubit.js'
import { createReadyMemoryDatabase } from '../shared-fixtures.js'

function registerQuDbFlowBrowserSuite(registerSuite) {
  registerSuite('QuDB event flow', 'Write, update, delete and listener semantics', ({ test }) => {
    test('put, update and delete emit a readable event sequence', async ({ assertDeepEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      const recordKey = `@event-flow/items/${KEY.ts16()}`
      const seenEvents = []

      const stopListening = database.on(recordKey, (qubit, meta) => {
        seenEvents.push({
          eventName: meta.event,
          currentValue: qubit?.data?.title ?? null,
          previousValue: meta.oldValue?.title ?? null,
          scopeName: meta.scope,
        })
      }, { immediate: false })

      await database.put(recordKey, { title: 'Draft' })
      await database.put(recordKey, { title: 'Published' })
      await database.del(recordKey)

      await waitFor(() => {
        assertDeepEqual(seenEvents, [
          { eventName: 'put', currentValue: 'Draft', previousValue: null, scopeName: 'data' },
          { eventName: 'put', currentValue: 'Published', previousValue: 'Draft', scopeName: 'data' },
          { eventName: 'del', currentValue: null, previousValue: 'Published', scopeName: 'data' },
        ], 'db event sequence')
      })

      stopListening()
    })

    test('once listeners stop after the first write event', async ({ assertEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      const recordKey = `@event-flow/once/${KEY.ts16()}`
      let invocationCount = 0

      database.on(recordKey, () => {
        invocationCount += 1
      }, { once: true, immediate: false })

      await database.put(recordKey, { value: 1 })
      await database.put(recordKey, { value: 2 })

      await waitFor(() => {
        assertEqual(invocationCount, 1, 'once listener invocation count')
      })
    })
  })
}

export { registerQuDbFlowBrowserSuite }
