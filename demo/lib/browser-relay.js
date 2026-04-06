import { LocalRelay } from '../../src/transports/local.js'

/**
 * Browser-safe in-memory relay used by interactive demos.
 * It wraps LocalRelay for QuBit routing and adds an in-memory blob replica.
 */
export function createBrowserDemoRelay(options = {}) {
  const localRelay = LocalRelay({ debug: options.debug ?? false })
  const blobStoreByHash = new Map()

  return {
    addPeer: localRelay.addPeer,
    api: localRelay.api,
    clear() {
      localRelay.clear()
      blobStoreByHash.clear()
    },
    has(key) {
      return localRelay.has(key)
    },
    inspect(key) {
      return localRelay.inspect(key)
    },
    get size() {
      return localRelay.size
    },
    get peers() {
      return localRelay.peers
    },
    async uploadBlob({ hash, buffer, mime = '', name = '', from = null } = {}) {
      if (!hash || !buffer) throw new Error('uploadBlob requires hash and buffer')
      const storedBuffer = buffer instanceof ArrayBuffer ? buffer.slice(0) : buffer.buffer.slice(0)
      blobStoreByHash.set(hash, {
        hash,
        buffer: storedBuffer,
        mime,
        name,
        from,
      })
      return { ok: true, hash }
    },
    async downloadBlob({ hash } = {}) {
      const storedBlob = blobStoreByHash.get(hash)
      if (!storedBlob) return null
      return {
        hash,
        buffer: storedBlob.buffer.slice(0),
        mime: storedBlob.mime,
        name: storedBlob.name,
        from: storedBlob.from,
      }
    },
    hasBlob(hash) {
      return blobStoreByHash.has(hash)
    },
    inspectBlob(hash) {
      return blobStoreByHash.get(hash) ?? null
    },
  }
}
