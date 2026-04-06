// ════════════════════════════════════════════════════════════════════════════
// QuRay — relay/node-relay-factory.js
//
// Node.js relay factory: composes ReplicaDB + RelayPeer with FS-backed storage.
//
// This is the ONLY file in the relay/ folder that imports node:fs-specific code.
// All other relay modules are environment-agnostic.
//
// Usage (Node.js only):
//   import { createNodeRelay } from './src/relay/node-relay-factory.js'
//   const relay = await createNodeRelay({ dataDir: './data', debug: true })
//   relay.acceptTransport(myWsTransport)
//
// For tests or browser embedded relays, compose manually:
//   import { createReplicaDb } from './src/relay/replica-db.js'
//   import { createRelayPeer } from './src/relay/peer.js'
//   import { MemoryBackend } from './src/backends/memory.js'
//   const replica = await createReplicaDb({ mainBackend: MemoryBackend(), blobBackend: MemoryBackend() })
//   const peer = await createRelayPeer({ replica })
// ════════════════════════════════════════════════════════════════════════════

import { createReplicaDb } from './replica-db.js'
import { createRelayPeer } from './peer.js'
import { FsBackend, BlobFsBackend } from '../backends/fs.js'


/**
 * Create a Node.js relay with filesystem-backed storage.
 *
 * @param {object} options
 * @param {string}  [options.dataDir]  - Directory for QuBit JSON files and blob bytes.
 *                                       Defaults to in-memory if omitted.
 * @param {boolean} [options.pretty]  - Pretty-print JSON files (default: false)
 * @param {boolean} [options.debug]   - Enable debug logging (default: false)
 * @returns {Promise<RelayPeerInstance>}
 *
 * @example
 * import { createNodeRelay } from './src/relay/node-relay-factory.js'
 *
 * const relay = await createNodeRelay({ dataDir: './relay-data', debug: true })
 *
 * // Attach a WebSocket transport (e.g. ws library):
 * wss.on('connection', (ws) => {
 *   const transport = WsServerTransport(ws)
 *   relay.acceptTransport(transport)
 * })
 */
const createNodeRelay = async (options = {}) => {
  const { dataDir = null, pretty = false, debug = false } = options

  const useFs      = typeof dataDir === 'string' && dataDir.length > 0
  const mainBackend = useFs ? FsBackend({ dir: `${dataDir}/msgs`, pretty }) : null
  const blobBackend = useFs ? BlobFsBackend({ dir: `${dataDir}/blobs` }) : null

  const replica = await createReplicaDb({ mainBackend, blobBackend })
  return createRelayPeer({ replica, debug })
}


export { createNodeRelay }
