import { QuDB } from '../src/core/db.js'
import { QuQueue } from '../src/core/queue.js'
import { QuNet } from '../src/core/net.js'
import { QuSync } from '../src/core/sync.js'
import { MemoryBackend } from '../src/backends/memory.js'
import { Identity } from '../src/core/identity.js'
import { StoreOutPlugin, StoreInPlugin } from '../src/plugins/store.js'
import { SignPlugin } from '../src/plugins/sign.js'
import { VerifyPlugin } from '../src/plugins/verify.js'
import { DispatchPlugin } from '../src/plugins/dispatch.js'
import { KEY, resolveStorageKeyReference } from '../src/core/qubit.js'
import { Signal, EventBus } from '../src/core/events.js'
import { createRelayPeer } from '../src/relay/peer.js'
import { NodeRelayTransport } from '../src/transports/node-relay.js'

const createSyncBlobBackend = () => {
  const entries = new Map()
  return {
    name: 'sync-blob-backend',
    get: (key) => entries.get(key) ?? null,
    set: (key, value) => { entries.set(key, value) },
    del: (key) => { entries.delete(key) },
    query: (prefix = '') => [...entries.entries()]
      .filter(([key]) => !prefix || key === prefix || key.startsWith(prefix))
      .map(([key, val]) => ({ key, val })),
  }
}

let pass = 0
let fail = 0

const suite = async (name, fn) => {
  console.log(`\n── ${name}`)
  await fn()
}

const test = async (name, fn) => {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail++
    console.error(`  ✗ ${name}`)
    console.error(`    ${error.message}`)
  }
}

const assert = (condition, message = 'assertion failed') => {
  if (!condition) throw new Error(message)
}

const assertEqual = (actual, expected, message = 'assertEqual') => {
  if (actual !== expected) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
}

const waitFor = (fn, ms = 2000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + ms
  const tick = async () => {
    try {
      await fn()
      resolve()
    } catch (error) {
      if (Date.now() >= deadline) reject(error)
      else setTimeout(tick, 20)
    }
  }
  tick()
})

const createMockTransport = (name) => {
  const state = Signal('disconnected')
  const bus = EventBus({ separator: '.' })
  const sent = []
  const connects = []
  return {
    name,
    capabilities: { realtime: true, sync: true, subscribe: true },
    state,
    sent,
    connects,
    on: (eventName, callbackFn) => bus.on(eventName, callbackFn),
    off: (eventName) => bus.off(eventName),
    connect: async (url, options = {}) => {
      connects.push({ url, options })
      await state.set('connected')
      return true
    },
    disconnect: async () => {
      await state.set('disconnected')
      return true
    },
    send: async (packet) => {
      sent.push(packet)
      return true
    },
    emitMessage: async (packet) => bus.emit('message', packet, { transport: name }),
  }
}

async function createPeer(alias, options = {}) {
  const identity = await Identity({ alias })
  const confStore = MemoryBackend()
  const queue = QuQueue(confStore, {
    storageKey: `conf/tasks/${alias}`,
    concurrentMax: 2,
    retryDelays: [0, 0, 1],
  })

  const db = QuDB({
    backends: {
      '~': MemoryBackend(),
      '@': MemoryBackend(),
      '>': MemoryBackend(),
      'sys/': MemoryBackend(),
      'conf/': confStore,
      'blobs/': MemoryBackend(),
    },
    identity,
    queue,
  })
  db.use(SignPlugin(identity))
  db.use(VerifyPlugin(identity))
  db.use(StoreOutPlugin())
  db.use(StoreInPlugin())
  db.use(DispatchPlugin())
  await db.init()

  const net = QuNet()
  const sync = QuSync({ db, net, queue, identity, config: { syncOnConnect: true } })
  sync.init()
  await queue.init()

  if (options.relay) {
    const transport = NodeRelayTransport({ relay: options.relay, label: identity.pub })
    net.use(transport, 'relay')
    sync.addPeer({ label: 'relay', type: 'relay', transportName: 'relay' })
    await net.connect('relay')
    await transport.send({
      payload: {
        type: 'peer.hello',
        from: identity.pub,
        ts: Date.now(),
        data: { alias, epub: identity.epub },
      }
    })
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  return { identity, db, queue, net, sync, pub: identity.pub }
}

await suite('API contract — key helpers', async () => {
  await test('current-user shorthand keys resolve deterministically', async () => {
    assertEqual(resolveStorageKeyReference('~', { currentUserPublicKey: 'pub-demo' }), '~pub-demo', 'current user root key')
    assertEqual(resolveStorageKeyReference('~/alias', { currentUserPublicKey: 'pub-demo' }), '~pub-demo/alias', 'current user alias key')
    assertEqual(KEY.resolve('~/pub', { currentUserPublicKey: 'pub-demo' }), '~pub-demo/pub', 'KEY.resolve current user pub key')
  })
})

await suite('API contract — QuDB backend compatibility', async () => {
  await test('blob restore accepts synchronous backend query implementations', async () => {
    const db = QuDB({
      backends: {
        '~': MemoryBackend(),
        '@': MemoryBackend(),
        '>': MemoryBackend(),
        'sys/': MemoryBackend(),
        'conf/': MemoryBackend(),
        'blobs/': createSyncBlobBackend(),
      },
    })

    db.use(StoreOutPlugin())
    db.use(StoreInPlugin())
    db.use(DispatchPlugin())

    await db.init()
    await db.sync.setBlobStatus('sync-backend-blob', 'ready', null, { mime: 'text/plain' })

    let seen = null
    const off = db.on('sync-backend-blob', (entry, meta) => {
      seen = { status: entry?.status, scope: meta.scope }
    }, { scope: 'blob', immediate: true, once: true })

    await waitFor(() => {
      assertEqual(seen?.status, 'ready', 'blob status from synchronous backend')
      assertEqual(seen?.scope, 'blob', 'blob scope from synchronous backend')
    })
    off()
  })
})

await suite('API contract — QuDB listener options', async () => {
  const peer = await createPeer('Contract Alice')

  await test('data listeners honor immediate: false', async () => {
    const key = `@contracts/data/${KEY.ts16()}`
    await peer.db.put(key, { text: 'seed' })

    let count = 0
    const off = peer.db.on(key, () => { count++ }, { immediate: false })

    await new Promise(resolve => setTimeout(resolve, 30))
    assertEqual(count, 0, 'listener should not replay current value')

    await peer.db.put(key, { text: 'update' })
    await waitFor(() => assertEqual(count, 1, 'listener should fire on update'))
    off()
  })

  await test('blob listeners can replay the current status immediately', async () => {
    await peer.db.sync.setBlobStatus('contract-blob', 'ready', 'blob:contract', { mime: 'text/plain' })

    let replay = null
    const off = peer.db.on('contract-blob', (entry, meta) => {
      replay = { status: entry?.status, scope: meta.scope, event: meta.event }
    }, { scope: 'blob', immediate: true, once: true })

    await waitFor(() => {
      assertEqual(replay?.status, 'ready', 'blob status')
      assertEqual(replay?.scope, 'blob', 'blob scope')
    })
    off()
  })

  await test('delivery listeners can replay the current status immediately', async () => {
    const key = `@contracts/delivery/${KEY.ts16()}`
    await peer.db.sync.setDelivery(key, 'relay-stored')

    let replay = null
    const off = peer.db.on(key, (entry, meta) => {
      replay = { state: entry?.state, scope: meta.scope, event: meta.event }
    }, { scope: 'delivery', immediate: true, once: true })

    await waitFor(() => {
      assertEqual(replay?.state, 'relay-stored', 'delivery state')
      assertEqual(replay?.scope, 'delivery', 'delivery scope')
    })
    off()
  })
})

await suite('API contract — QuNet endpoints', async () => {
  await test('connectEndpoint resolves the configured transport and URL', async () => {
    const net = QuNet()
    const relayTransport = createMockTransport('relay')
    net.use(relayTransport, 'relay')

    net.addEndpoint({ id: 'relay:primary', transportName: 'relay', url: 'ws://relay.local' })
    await net.connectEndpoint('relay:primary')

    assertEqual(relayTransport.connects.length, 1, 'connect count')
    assertEqual(relayTransport.connects[0].url, 'ws://relay.local', 'endpoint URL')
  })

  await test('sendTo routes packets through the endpoint transport', async () => {
    const net = QuNet()
    const relayTransport = createMockTransport('relay')
    net.use(relayTransport, 'relay')
    await net.connect('relay', 'ws://relay.local')

    net.addEndpoint({ id: 'relay:primary', transportName: 'relay', url: 'ws://relay.local' })
    const ok = await net.sendTo('relay:primary', { payload: { type: 'db.sub', data: { prefix: '@room/' } } })

    assert(ok, 'sendTo should resolve to true')
    assertEqual(relayTransport.sent.length, 1, 'send count')
    assertEqual(relayTransport.sent[0].payload.type, 'db.sub', 'payload type')
  })
})

await suite('API contract — explicit sync and replica restore', async () => {
  const relay = await createRelayPeer()
  const alice = await createPeer('Alice Contract', { relay })
  const bob = await createPeer('Bob Contract', { relay })

  await test('sync.observe returns a cleanup that stops future deliveries', async () => {
    let seen = 0
    const off = await bob.sync.observe('@room/observe/**', () => { seen++ })

    await alice.db.put(`@room/observe/${KEY.ts16()}`, { text: 'first' })
    await waitFor(() => assertEqual(seen, 1, 'first delivery'))

    off()
    await alice.db.put(`@room/observe/${KEY.ts16()}`, { text: 'second' })
    await new Promise(resolve => setTimeout(resolve, 100))
    assertEqual(seen, 1, 'cleanup should stop future deliveries')
  })

  await test('replica pull can restore data after a local delete', async () => {
    const key = `@room/restore-again/${KEY.ts16()}`
    await alice.db.put(key, { text: 'replica copy' })

    const pulled = await bob.sync.pull('@room/restore-again/')
    assert(pulled >= 1, 'expected at least one initial pulled row')
    assertEqual((await bob.db.get(key))?.data?.text, 'replica copy', 'initial restore')

    await bob.db.del(key, { hard: true })
    assertEqual(await bob.db.get(key), null, 'deleted locally')

    const restored = await bob.sync.pull('@room/restore-again/')
    assert(restored >= 1, 'expected restore from replica')
    assertEqual((await bob.db.get(key))?.data?.text, 'replica copy', 'restored after delete')
  })
})

console.log('\n──────────────────────────────────────────────────')
console.log(`  ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
