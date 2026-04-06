// ════════════════════════════════════════════════════════════════════════════
// QuRay — transports/node-relay.js
//
// In-process relay transport for Node.js tests.
// Connects a normal QuNet client transport to a RelayPeer instance.
// ════════════════════════════════════════════════════════════════════════════

import { LocalBridge } from './local.js'

const NodeRelayTransport = ({ relay, label = null, debug = false } = {}) => {
  if (!relay?.acceptTransport) {
    throw new Error('NodeRelayTransport requires a relay created by createRelayPeer()')
  }

  const [clientTransport, relayTransport] = LocalBridge({ debug })
  relay.acceptTransport(relayTransport, { label })

  return {
    ...clientTransport,
    name: 'node-relay',
    capabilities: {
      realtime: true,
      background: false,
      p2p: false,
      streaming: false,
      subscribe: true,
      sync: true,
      replica: true,
    },
  }
}

export { NodeRelayTransport }
