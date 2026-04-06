// ════════════════════════════════════════════════════════════════════════════
// QuRay — relay/peer.js
//
// RelayPeer is a peer-shaped relay runtime for Node.js tests and local setups.
// It composes:
//   - ReplicaDB for persistent snapshots / restore
//   - RelayRouter for live packet routing
//   - transport adapters attached from the outside
//
// The relay stays modular: persistence, routing and transport attachment are
// separate concerns.
// ════════════════════════════════════════════════════════════════════════════

import { NO_STORE_TYPES, QUBIT_TYPE } from '../core/qubit.js'
import { createReplicaDb } from './replica-db.js'
import { RelayRouter } from './router.js'

const createRelayPeer = async (options = {}) => {
  const debug = options.debug ?? false
  const _log = (...args) => { if (debug) console.log('[RelayPeer]', ...args) }

  const replica = options.replica ?? await createReplicaDb(options)
  const router = RelayRouter({ debug })

  const _sessionsByTransport = new Map()

  const _sessionInfo = (transport) => {
    if (!_sessionsByTransport.has(transport)) {
      _sessionsByTransport.set(transport, { peerId: null })
    }
    return _sessionsByTransport.get(transport)
  }

  const _sendSnapshot = async (transport, prefix, requestId = null) => {
    const rows = (await replica.query(prefix)).map(val => ({ key: val.key, val }))
    await transport.send({
      payload: {
        type: QUBIT_TYPE.DB_RES,
        id: requestId,
        data: { requestId, rows },
      }
    })
  }

  const _broadcastBlobReady = async ({ hash, mime = '', name = '', size = 0, from = null } = {}) => {
    await router.broadcastPacket({
      payload: {
        type: QUBIT_TYPE.BLOB_READY,
        hash,
        mime,
        name,
        size,
        from,
      },
    })
  }

  const uploadBlob = async ({ hash, buffer, mime = '', name = '', from = null } = {}) => {
    if (!hash || !buffer) throw new Error('uploadBlob requires hash and buffer')
    await replica.putBlob(hash, buffer)
    await _broadcastBlobReady({
      hash,
      mime,
      name,
      size: buffer.byteLength ?? buffer.length ?? 0,
      from,
    })
    return { ok: true, hash }
  }

  const downloadBlob = async ({ hash } = {}) => {
    const buffer = await replica.getBlob(hash)
    if (!buffer) return null
    return { hash, buffer }
  }

  const _attachTransport = (transport, options = {}) => {
    const label = options.label ?? 'peer'
    const session = _sessionInfo(transport)

    const _peerId = () => session.peerId ?? label

    transport.on('message', async (packet) => {
      const qubit = packet?.payload ?? packet
      if (!qubit?.type && !qubit?.key) return

      if (qubit?.type === QUBIT_TYPE.PEER_HELLO) {
        session.peerId = qubit.from ?? label
        router.registerSession(session.peerId, async (outPacket) => transport.send(outPacket))
        await transport.send({ payload: { type: QUBIT_TYPE.PEERS_LIST, data: router.listPeers(session.peerId) } })
        await router.broadcastPacket({ payload: qubit }, { skipPeerId: session.peerId })
        _log('hello', session.peerId)
        return
      }

      if (qubit?.type === QUBIT_TYPE.PEER_BYE) {
        const peerId = _peerId()
        router.unregisterSession(peerId)
        await router.broadcastPacket({ payload: { type: QUBIT_TYPE.PEER_BYE, from: peerId } }, { skipPeerId: peerId })
        return
      }

      if (qubit?.type === QUBIT_TYPE.DB_SUB) {
        const prefix = qubit.data?.prefix ?? qubit.prefix
        if (!prefix) return
        if (qubit.data?.live !== false) router.subscribe(_peerId(), prefix)
        if (qubit.data?.snapshot !== false) await _sendSnapshot(transport, prefix, qubit.data?.requestId ?? qubit.id ?? null)
        return
      }

      if (qubit?.type === QUBIT_TYPE.DB_UNSUB) {
        const prefix = qubit.data?.prefix ?? qubit.prefix
        if (prefix) router.unsubscribe(_peerId(), prefix)
        return
      }

      if (qubit?.key && !NO_STORE_TYPES.has(qubit.type)) {
        await replica.store(qubit)
        await router.pushData(qubit, {
          fromPeerId: _peerId(),
          explicitTo: packet?.to ?? null,
        })
        return
      }

      if (packet?.to) {
        await router.pushData({ ...qubit, key: qubit.key ?? `>${packet.to}/ephemeral/${Date.now()}` }, {
          fromPeerId: _peerId(),
          explicitTo: packet.to,
        })
        return
      }

      await router.broadcastPacket(packet, { skipPeerId: _peerId() })
    })

    transport.on('disconnect', async () => {
      const peerId = _peerId()
      if (!peerId) return
      router.unregisterSession(peerId)
      await router.broadcastPacket({ payload: { type: QUBIT_TYPE.PEER_BYE, from: peerId } }, { skipPeerId: peerId })
    })
  }

  return {
    replica,
    router,
    acceptTransport: _attachTransport,
    peers: () => router.listPeers(),
    query: (prefix) => replica.query(prefix),
    get: (key) => replica.get(key),
    getKeys: (prefix) => replica.getKeys(prefix),
    uploadBlob,
    downloadBlob,
  }
}

export { createRelayPeer }
