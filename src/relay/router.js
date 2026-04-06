// ════════════════════════════════════════════════════════════════════════════
// QuRay — relay/router.js
//
// Pure routing layer for relay peers.
// Keeps session and subscription state, but knows nothing about persistence.
// ════════════════════════════════════════════════════════════════════════════

const RelayRouter = (options = {}) => {
  const debug = options.debug ?? false
  const _log = (...args) => { if (debug) console.log('[RelayRouter]', ...args) }

  const _sessions = new Map() // peerId -> { send, subscriptions:Set }

  const registerSession = (peerId, send) => {
    if (!peerId || typeof send !== 'function') return null
    const existing = _sessions.get(peerId)
    if (existing) existing.send = send
    else _sessions.set(peerId, { peerId, send, subscriptions: new Set() })
    _log('register', peerId)
    return _sessions.get(peerId)
  }

  const unregisterSession = (peerId) => {
    _log('unregister', peerId)
    _sessions.delete(peerId)
  }

  const subscribe = (peerId, prefix) => {
    if (!peerId || !prefix) return false
    if (!_sessions.has(peerId)) return false
    _sessions.get(peerId).subscriptions.add(prefix)
    return true
  }

  const unsubscribe = (peerId, prefix) => {
    if (!peerId || !prefix || !_sessions.has(peerId)) return false
    _sessions.get(peerId).subscriptions.delete(prefix)
    return true
  }

  const listPeers = (skipPeerId = null) =>
    [..._sessions.keys()]
      .filter(peerId => peerId !== skipPeerId)
      .map(peerId => ({ pub: peerId }))

  const _sendTo = async (peerId, packet) => {
    const session = _sessions.get(peerId)
    if (!session?.send) return false
    await session.send(packet)
    return true
  }

  const broadcastPacket = async (packet, options = {}) => {
    const { skipPeerId = null } = options
    for (const [peerId, session] of _sessions) {
      if (peerId === skipPeerId) continue
      await session.send(packet)
    }
  }

  const pushData = async (qubit, options = {}) => {
    const { fromPeerId = null, explicitTo = null } = options

    const inferredTarget = qubit?.key?.startsWith('>')
      ? qubit.key.slice(1).split('/')[0]
      : null
    const targetPeerId = explicitTo ?? inferredTarget

    if (targetPeerId) {
      if (targetPeerId !== fromPeerId) {
        await _sendTo(targetPeerId, {
          payload: {
            type: 'db.push',
            data: { rows: [{ key: qubit.key, val: qubit }] },
          }
        })
      }
      return
    }

    for (const [peerId, session] of _sessions) {
      if (peerId === fromPeerId) continue
      const matches = [...session.subscriptions].some(prefix => qubit.key?.startsWith(prefix))
      if (!matches) continue
      await session.send({
        payload: {
          type: 'db.push',
          data: { rows: [{ key: qubit.key, val: qubit }] },
        }
      })
    }
  }

  return {
    registerSession,
    unregisterSession,
    subscribe,
    unsubscribe,
    listPeers,
    broadcastPacket,
    pushData,
    hasSession: (peerId) => _sessions.has(peerId),
    sessionCount: () => _sessions.size,
  }
}

export { RelayRouter }
