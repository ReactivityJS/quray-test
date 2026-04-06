import { KEY } from '../../../src/core/qubit.js'
import { createReadyMemoryDatabase } from '../shared-fixtures.js'

function registerDeliveryStatesBrowserSuite(registerSuite) {
  registerSuite('Delivery States', '6-state funnel: local → queued → relay_in → peer_sent → peer_recv → peer_read', ({ test }) => {

    test('StoreOutPlugin sets initial delivery state to local on write', async ({ assertEqual, waitFor }) => {
      const db = await createReadyMemoryDatabase()
      const key = `@delivery-test/initial/${KEY.ts16()}`

      await db.put(key, { text: 'delivery init' })

      await waitFor(async () => {
        const state = await db.delivery.get(key)
        assertEqual(state?.state, 'local', 'initial delivery state is local')
      })
    })

    test('delivery state advances through all 6 stages', async ({ assertDeepEqual, waitFor }) => {
      const db = await createReadyMemoryDatabase()
      const key = `@delivery-test/funnel/${KEY.ts16()}`
      const states = []

      const off = db.on(key, (entry) => {
        if (entry?.state) states.push(entry.state)
      }, { scope: 'delivery', immediate: false })

      await db.put(key, { text: 'funnel test' })
      await db.delivery.set(key, 'queued')
      await db.delivery.set(key, 'relay_in')
      await db.delivery.set(key, 'peer_sent')
      await db.delivery.set(key, 'peer_recv')
      await db.delivery.set(key, 'peer_read')

      await waitFor(() => {
        assertDeepEqual(states, ['local', 'queued', 'relay_in', 'peer_sent', 'peer_recv', 'peer_read'], 'full delivery funnel')
      })

      off()
    })

    test('delivery.get returns the current state entry', async ({ assertEqual }) => {
      const db = await createReadyMemoryDatabase()
      const key = `@delivery-test/get/${KEY.ts16()}`

      await db.put(key, { text: 'test' })
      await db.delivery.set(key, 'relay_in')

      const state = await db.delivery.get(key)
      assertEqual(state?.state, 'relay_in', 'delivery.get returns set state')
    })

    test('delivery.isAtLeast respects state ordering', async ({ assert }) => {
      const db = await createReadyMemoryDatabase()
      const key = `@delivery-test/isAtLeast/${KEY.ts16()}`

      await db.put(key, { text: 'test' })
      await db.delivery.set(key, 'peer_recv')

      assert(await db.delivery.isAtLeast(key, 'local'), 'local ≤ peer_recv')
      assert(await db.delivery.isAtLeast(key, 'queued'), 'queued ≤ peer_recv')
      assert(await db.delivery.isAtLeast(key, 'relay_in'), 'relay_in ≤ peer_recv')
      assert(await db.delivery.isAtLeast(key, 'peer_sent'), 'peer_sent ≤ peer_recv')
      assert(await db.delivery.isAtLeast(key, 'peer_recv'), 'peer_recv ≤ peer_recv')
      assert(!await db.delivery.isAtLeast(key, 'peer_read'), 'peer_read > peer_recv')
    })

    test('conf/ keys are excluded from delivery tracking (isLocalOnly)', async ({ assertEqual }) => {
      const db = await createReadyMemoryDatabase()
      await db.put('conf/settings/theme', 'dark')

      // conf/ is mount-local — no delivery tracking
      const state = await db.delivery.get('conf/settings/theme')
      assertEqual(state, null, 'conf/ key has no delivery state')
    })

    test('delivery.on with immediate:true replays existing state', async ({ assertEqual, waitFor }) => {
      const db = await createReadyMemoryDatabase()
      const key = `@delivery-test/immediate/${KEY.ts16()}`

      await db.put(key, { text: 'test' })
      await db.delivery.set(key, 'peer_sent')

      let capturedState = null
      const off = db.on(key, (entry) => {
        capturedState = entry?.state
      }, { scope: 'delivery', immediate: true })

      await waitFor(() => {
        assertEqual(capturedState, 'peer_sent', 'immediate delivery state replay')
      })

      off()
    })

    test('delivery listener stops cleanly when off() is called', async ({ assertEqual, sleep }) => {
      const db = await createReadyMemoryDatabase()
      const key = `@delivery-test/off/${KEY.ts16()}`
      let callCount = 0

      await db.put(key, { text: 'test' })
      const off = db.on(key, () => { callCount += 1 }, { scope: 'delivery', immediate: false })

      await db.delivery.set(key, 'queued')
      off()
      await db.delivery.set(key, 'relay_in')

      await sleep(50)
      assertEqual(callCount, 1, 'listener stops after off()')
    })
  })
}

export { registerDeliveryStatesBrowserSuite }
