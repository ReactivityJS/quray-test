// ════════════════════════════════════════════════════════════════════════════
// QuRay demos — demo-runtime.js  (v2 — parallel init + timing)
// ════════════════════════════════════════════════════════════════════════════

import { QuDB }               from '../../src/core/db.js'
import { QuQueue }            from '../../src/core/queue.js'
import { QuNet }              from '../../src/core/net.js'
import { QuSync }             from '../../src/core/sync.js'
import { MemoryBackend }      from '../../src/backends/memory.js'
import { Identity }           from '../../src/core/identity.js'
import { KEY }                from '../../src/core/qubit.js'
import { StoreOutPlugin, StoreInPlugin } from '../../src/plugins/store.js'
import { SignPlugin }         from '../../src/plugins/sign.js'
import { VerifyPlugin }       from '../../src/plugins/verify.js'
import { DispatchPlugin }     from '../../src/plugins/dispatch.js'
import { AccessControlPlugin } from '../../src/plugins/access.js'
import { createBrowserDemoRelay } from './browser-relay.js'

export { KEY }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Step timer ───────────────────────────────────────────────────────────────
export function createTimer(logFn = console.info) {
  const t0 = performance.now()
  let tLast = t0
  const fmt = ms => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(2)}s`
  const step = label => {
    const now = performance.now()
    const msg = `[T+${fmt(now-t0)} | +${fmt(now-tLast)}] ${label}`
    tLast = now
    logFn(msg)
    return msg
  }
  const done = (label='Done') => step(`✓ ${label}`)
  return { step, done, elapsed: () => performance.now() - t0 }
}

// ── In-browser relay ─────────────────────────────────────────────────────────
export async function createDemoRelay(options = {}) {
  return createBrowserDemoRelay(options)
}

// ── Single demo peer ─────────────────────────────────────────────────────────
export async function createDemoPeer(options = {}) {
  const { alias='Demo peer', relay=null, debug=false,
          storagePrefix=alias.toLowerCase().replace(/\s+/gu,'-'), timer=null } = options

  const identity = await Identity({ alias })
  timer?.step(`Identity "${alias}"`)

  const confStore = MemoryBackend()
  const taskQueue = QuQueue(confStore, {
    storageKey: `conf/tasks/${storagePrefix}`, concurrentMax: 2, retryDelays: [0,25,50,100],
  })
  const database = QuDB({
    identity, queue: taskQueue,
    backends: {
      '~': MemoryBackend(), '@': MemoryBackend(), '>': MemoryBackend(),
      'sys/': MemoryBackend(), 'conf/': confStore, 'blobs/': MemoryBackend(),
    },
  })
  database.use(SignPlugin(identity))
  database.use(VerifyPlugin(identity))
  database.use(StoreOutPlugin())
  database.use(StoreInPlugin())
  database.use(DispatchPlugin())
  database.use(AccessControlPlugin())
  await database.init()

  const network = QuNet()
  const sync = QuSync({ db: database, net: network, queue: taskQueue, identity,
    config: { debug, syncOnConnect: true } })
  sync.init()
  await taskQueue.init()
  timer?.step(`DB+Queue "${alias}"`)

  let relayTransport = null
  if (relay) {
    const relayPeer = relay.addPeer(identity.pub)
    relayTransport = relayPeer.transport
    network.use(relayTransport, 'relay')
    sync.addPeer({ label:'relay', type:'relay', transportName:'relay',
      features:['sync','router','replica'],
      uploadBlob: relay.uploadBlob?.bind(relay),
      downloadBlob: relay.downloadBlob?.bind(relay) })
    await network.connect('relay')
    await relayTransport.send({
      payload: { type:'peer.hello', from:identity.pub, ts:Date.now(),
        data:{ alias, epub:identity.epub } } })
    await sleep(20)
    timer?.step(`Relay "${alias}"`)
  }

  return {
    alias, pub: identity.pub, identity, db: database, sync, queue: taskQueue, net: network,
    relayTransport,
    async destroy() {
      try { await network.disconnectAll() } catch {}
      try { taskQueue.stop?.() } catch {}
    },
  }
}

// ── Peer pair — PARALLEL init (was sequential ~22s, now ~4s) ─────────────────
export async function createDemoPair(options = {}) {
  const timer = options.timer ?? null
  const relay = await createDemoRelay(options.relayOptions)
  timer?.step('Relay')
  const [alice, bob] = await Promise.all([
    createDemoPeer({ alias: options.aliceAlias ?? 'Alice', relay, debug: options.debug, timer }),
    createDemoPeer({ alias: options.bobAlias   ?? 'Bob',   relay, debug: options.debug, timer }),
  ])
  timer?.step('Alice+Bob ready')
  return { relay, alice, bob }
}

// ── Log writer ───────────────────────────────────────────────────────────────
export function createLogWriter(el) {
  return function writeLog(msg, level='info') {
    if (!el) return
    const line = document.createElement('div')
    line.className = `log-line log-${level}`
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
    el.appendChild(line)
    el.scrollTop = el.scrollHeight
  }
}

// ── Polling assertion ────────────────────────────────────────────────────────
export async function waitForAssertion(fn, opts = {}) {
  const timeout = opts.timeoutMilliseconds ?? 2500
  const interval = opts.intervalMilliseconds ?? 25
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try   { return await fn() }
    catch (e) { if (Date.now()+interval >= deadline) throw e; await sleep(interval) }
  }
  throw new Error('waitForAssertion timed out')
}

export function formatPublicKeyShort(pub) {
  if (!pub) return '—'
  return pub.length <= 16 ? pub : pub.slice(0,12)+'…'
}
export const arrayBufferFromText = text => new TextEncoder().encode(text).buffer
export async function readTextFromBlobStatus(db, hash) {
  const buf = await db._internal.readBlobBuffer(hash)
  return buf ? new TextDecoder().decode(buf) : null
}
