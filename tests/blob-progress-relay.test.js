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
import { KEY } from '../src/core/qubit.js'
import { createRelayPeer } from '../src/relay/peer.js'
import { NodeRelayTransport } from '../src/transports/node-relay.js'

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

function waitFor(expectationFunction, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = async () => {
      try {
        await expectationFunction()
        resolve()
      } catch (error) {
        if (Date.now() >= deadline) reject(error)
        else setTimeout(tick, 25)
      }
    }
    tick()
  })
}

async function createRelayConnectedPeer(alias, relayPeer) {
  const identity = await Identity({ alias })
  const confBackend = MemoryBackend()
  const queue = QuQueue(confBackend, {
    storageKey: `conf/tasks/${alias}`,
    concurrentMax: 2,
    retryDelays: [0, 0, 1],
  })

  const database = QuDB({
    backends: {
      '~': MemoryBackend(),
      '@': MemoryBackend(),
      '>': MemoryBackend(),
      'sys/': MemoryBackend(),
      'conf/': confBackend,
      'blobs/': MemoryBackend(),
    },
    identity,
    queue,
  })

  database.use(SignPlugin(identity))
  database.use(VerifyPlugin(identity))
  database.use(StoreOutPlugin())
  database.use(StoreInPlugin())
  database.use(DispatchPlugin())
  await database.init()

  const network = QuNet()
  const sync = QuSync({ db: database, net: network, queue, identity, config: { syncOnConnect: true } })
  sync.init()
  await queue.init()

  const relayTransport = NodeRelayTransport({ relay: relayPeer, label: identity.pub })
  network.use(relayTransport, 'relay')
  sync.addPeer({
    label: 'relay',
    type: 'relay',
    transportName: 'relay',
    uploadBlob: relayPeer.uploadBlob,
    downloadBlob: relayPeer.downloadBlob,
  })

  await network.connect('relay')
  await relayTransport.send({
    payload: {
      type: 'peer.hello',
      from: identity.pub,
      ts: Date.now(),
      data: { alias, epub: identity.epub },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  return { identity, db: database, queue, net: network, sync }
}

console.log('\n── Blob progress and relay delivery')

await runTest('local blob storage and relay sync expose upload and download progress states', async () => {
  const relayPeer = await createRelayPeer()
  const alicePeer = await createRelayConnectedPeer('Progress Alice', relayPeer)
  const bobPeer = await createRelayConnectedPeer('Progress Bob', relayPeer)

  const uploadProgressValues = []
  const downloadProgressValues = []
  const deliveryStateValues = []

  alicePeer.queue.on('task.progress', (task) => {
    if (task.action === 'blob.upload') uploadProgressValues.push(task.progress)
  })
  bobPeer.queue.on('task.progress', (task) => {
    if (task.action === 'blob.download') downloadProgressValues.push(task.progress)
  })

  const blobBytes = new TextEncoder().encode('Blob progress across relay').buffer
  const blobHash = await KEY.sha256url(blobBytes)
  const blobMetaKey = KEY.user(alicePeer.identity.pub).blob(blobHash)

  alicePeer.db.delivery.on(blobMetaKey, (entry) => {
    if (entry?.state) deliveryStateValues.push(entry.state)
  })

  await bobPeer.sync.subscribe(`~${alicePeer.identity.pub}/blob/**`, { live: true, snapshot: true })
  await alicePeer.db.blobs.put(blobHash, blobBytes, {
    mime: 'text/plain',
    name: 'progress.txt',
  })

  await waitFor(async () => {
    const localBlobStatus = alicePeer.db.blobs.status(blobHash)
    assertEqual(localBlobStatus?.status, 'ready', 'local blob stored immediately')
    assert(uploadProgressValues.includes(20), 'upload progress reached 20')
    assert(uploadProgressValues.includes(60), 'upload progress reached 60')
    assert(uploadProgressValues.includes(100), 'upload progress reached 100')
    assert(downloadProgressValues.includes(80), 'download progress reached 80')
    assert(downloadProgressValues.includes(100), 'download progress reached 100')
    assert(deliveryStateValues.includes('local'), 'delivery state includes local')
    assert(deliveryStateValues.includes('queued'), 'delivery state includes queued')
    assert(deliveryStateValues.includes('blob_relay'), 'delivery state includes relay storage confirmation')

    const bobBlobMeta = await bobPeer.db.get(blobMetaKey)
    assertEqual(bobBlobMeta?.data?.name, 'progress.txt', 'remote peer received blob metadata')

    const bobBlobStatus = bobPeer.db.blobs.status(blobHash)
    assertEqual(bobBlobStatus?.status, 'ready', 'remote blob download completed')
  })
})

console.log('\n──────────────────────────────────────────────────')
console.log(`  ${passedCount} passed, ${failedCount} failed`)
process.exit(failedCount > 0 ? 1 : 0)
