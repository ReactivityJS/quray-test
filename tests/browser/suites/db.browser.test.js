import { QuDB } from '../../../src/core/db.js'
import { MemoryBackend } from '../../../src/backends/memory.js'
import { StoreInPlugin, StoreOutPlugin } from '../../../src/plugins/store.js'
import { DispatchPlugin } from '../../../src/plugins/dispatch.js'
import { KEY } from '../../../src/core/qubit.js'
import { createReadyMemoryDatabase, BLOB_STATUS } from '../shared-fixtures.js'

function registerQuDbBrowserSuite(registerSuite) {
  registerSuite('QuDB core', 'CRUD, events, blob and delivery scopes', ({ test }) => {
    test('put and get round-trip plain data', async ({ assertEqual }) => {
      const database = await createReadyMemoryDatabase()
      const recordKey = `@room/chat/${KEY.ts16()}`

      await database.put(recordKey, { text: 'hello browser' })
      const storedQuBit = await database.get(recordKey)

      assertEqual(storedQuBit?.data?.text, 'hello browser', 'stored qubit data')
    })

    test('db.on reports current and previous values for data updates', async ({ assertDeepEqual, assertEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      const recordKey = `@room/state/${KEY.ts16()}`
      const seenEvents = []

      const stopListening = database.on(recordKey, (qubit, meta) => {
        seenEvents.push({
          currentText: qubit?.data?.text ?? null,
          previousText: meta.oldValue?.text ?? null,
          eventName: meta.event,
          scopeName: meta.scope,
        })
      }, { immediate: false })

      await database.put(recordKey, { text: 'first' })
      await database.put(recordKey, { text: 'second' })

      await waitFor(() => {
        assertEqual(seenEvents.length, 2, 'listener event count')
      })

      assertDeepEqual(seenEvents, [
        { currentText: 'first', previousText: null, eventName: 'put', scopeName: 'data' },
        { currentText: 'second', previousText: 'first', eventName: 'put', scopeName: 'data' },
      ], 'data listener history')

      stopListening()
    })

    test('db.on supports blob scope with immediate replay and consistent event names', async ({ assertDeepEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      const blobHash = 'browser-blob-hash'

      await database.sync.setBlobStatus(blobHash, BLOB_STATUS.READY, 'blob:browser', { mime: 'text/plain' })

      let seenStatus = null
      const stopListening = database.on(blobHash, (entry, meta) => {
        seenStatus = {
          status: entry?.status ?? null,
          scope: meta.scope,
          event: meta.event,
          replay: meta.replay === true,
        }
      }, { scope: 'blob', immediate: true, once: true })

      await waitFor(() => {
        assertDeepEqual(seenStatus, {
          status: BLOB_STATUS.READY,
          scope: 'blob',
          event: 'blob-status',
          replay: true,
        }, 'blob scope replay')
      })

      stopListening()
    })

    test('db.on supports delivery scope with immediate replay and consistent event names', async ({ assertDeepEqual, waitFor }) => {
      const database = await createReadyMemoryDatabase()
      const recordKey = `@room/delivery/${KEY.ts16()}`

      await database.sync.setDelivery(recordKey, 'relay-stored')

      let seenState = null
      const stopListening = database.on(recordKey, (entry, meta) => {
        seenState = {
          state: entry?.state ?? null,
          scope: meta.scope,
          event: meta.event,
          replay: meta.replay === true,
        }
      }, { scope: 'delivery', immediate: true, once: true })

      await waitFor(() => {
        assertDeepEqual(seenState, {
          state: 'relay-stored',
          scope: 'delivery',
          event: 'delivery-state',
          replay: true,
        }, 'delivery scope replay')
      })

      stopListening()
    })

    test('init works without a blobs backend mount', async ({ assertNull }) => {
      const database = QuDB({
        backends: {
          '~': MemoryBackend(),
          '@': MemoryBackend(),
          '>': MemoryBackend(),
          'sys/': MemoryBackend(),
          'conf/': MemoryBackend(),
        },
      })
      database.use(StoreOutPlugin())
      database.use(StoreInPlugin())
      database.use(DispatchPlugin())
      await database.init()
      const missingBlobState = database.blobs.status('missing-blob')
      assertNull(missingBlobState, 'missing blob state should be null')
    })
  })
}

export { registerQuDbBrowserSuite }
