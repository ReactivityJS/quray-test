import { KEY } from '../../../src/core/qubit.js'
import { BLOB_STATUS, createReadyMemoryDatabase } from '../shared-fixtures.js'

function registerBlobStepsBrowserSuite(registerSuite) {
  registerSuite('Blob upload steps', 'Granular in-browser blob storage and status progression', ({ test }) => {

    test('blobs.put stores bytes and status becomes READY immediately', async ({ assertEqual, assert }) => {
      const db = await createReadyMemoryDatabase()
      const blobBytes = new TextEncoder().encode('Hello blob world').buffer
      const blobHash = await KEY.sha256url(blobBytes)

      await db.blobs.put(blobHash, blobBytes, { mime: 'text/plain', name: 'hello.txt' })

      const status = db.blobs.status(blobHash)
      assertEqual(status?.status, BLOB_STATUS.READY, 'blob status is READY after put')
      assert(status?.url?.startsWith('blob:'), 'blob URL is an Object URL')
    })

    test('blob meta (name, mime) is preserved in status entry', async ({ assertEqual }) => {
      const db = await createReadyMemoryDatabase()
      const blobBytes = new TextEncoder().encode('Meta test content').buffer
      const blobHash = await KEY.sha256url(blobBytes)

      await db.blobs.put(blobHash, blobBytes, { mime: 'image/png', name: 'photo.png' })

      const status = db.blobs.status(blobHash)
      assertEqual(status?.meta?.name, 'photo.png', 'blob meta name preserved')
      assertEqual(status?.meta?.mime, 'image/png', 'blob meta mime preserved')
    })

    test('blobs.status returns null for an unknown hash', async ({ assertNull }) => {
      const db = await createReadyMemoryDatabase()
      const status = db.blobs.status(`unknown-hash-${Date.now()}`)
      assertNull(status, 'unknown blob status is null')
    })

    test('blob status transitions: pending → ready fire reactive events', async ({ assertDeepEqual, waitFor }) => {
      const db = await createReadyMemoryDatabase()
      const blobHash = `test-blob-pending-ready-${Date.now()}`
      const events = []

      const off = db.on(blobHash, (entry, meta) => {
        events.push({ status: entry.status, event: meta.event })
      }, { scope: 'blob', immediate: false })

      await db.sync.setBlobStatus(blobHash, BLOB_STATUS.PENDING, null, { mime: 'image/png' })
      await db.sync.setBlobStatus(blobHash, BLOB_STATUS.READY, 'blob:fakeurltest', { mime: 'image/png' })

      await waitFor(() => {
        assertDeepEqual(events, [
          { status: BLOB_STATUS.PENDING, event: 'blob-status' },
          { status: BLOB_STATUS.READY, event: 'blob-status' },
        ], 'blob status transition sequence')
      })

      off()
    })

    test('db.on blob scope with immediate:true replays existing READY status', async ({ assertEqual, waitFor }) => {
      const db = await createReadyMemoryDatabase()
      const blobHash = `immediate-blob-${Date.now()}`

      await db.sync.setBlobStatus(blobHash, BLOB_STATUS.READY, 'blob:immediate', { mime: 'video/mp4' })

      let capturedStatus = null
      const off = db.on(blobHash, (entry) => {
        capturedStatus = entry?.status
      }, { scope: 'blob', immediate: true })

      await waitFor(() => {
        assertEqual(capturedStatus, BLOB_STATUS.READY, 'immediate blob status replay')
      })

      off()
    })

    test('multiple blobs are tracked independently', async ({ assertEqual }) => {
      const db = await createReadyMemoryDatabase()
      const hash1 = `multi-blob-hash-1-${Date.now()}`
      const hash2 = `multi-blob-hash-2-${Date.now()}`

      await db.sync.setBlobStatus(hash1, BLOB_STATUS.READY, 'blob:url1', { mime: 'image/jpeg' })
      await db.sync.setBlobStatus(hash2, BLOB_STATUS.PENDING, null, { mime: 'image/png' })

      const status1 = db.blobs.status(hash1)
      const status2 = db.blobs.status(hash2)

      assertEqual(status1?.status, BLOB_STATUS.READY, 'first blob is READY')
      assertEqual(status2?.status, BLOB_STATUS.PENDING, 'second blob is PENDING')
    })

    test('different blob content produces different hashes', async ({ assert }) => {
      const bytesA = new TextEncoder().encode('Content A').buffer
      const bytesB = new TextEncoder().encode('Content B').buffer

      const hashA = await KEY.sha256url(bytesA)
      const hashB = await KEY.sha256url(bytesB)

      assert(hashA !== hashB, 'different content yields different SHA-256 hashes')
      assert(hashA.length > 0, 'hash A is non-empty')
      assert(hashB.length > 0, 'hash B is non-empty')
    })

    test('same blob content always yields the same hash (content-addressed)', async ({ assertEqual }) => {
      const bytes = new TextEncoder().encode('Deterministic content').buffer

      const hash1 = await KEY.sha256url(bytes)
      const hash2 = await KEY.sha256url(bytes)

      assertEqual(hash1, hash2, 'same content always produces same hash')
    })

    test('blobs.stage stores blob without immediately syncing', async ({ assertEqual, assert }) => {
      const db = await createReadyMemoryDatabase()
      const blobBytes = new TextEncoder().encode('Staged blob content').buffer
      const blobHash = await KEY.sha256url(blobBytes)

      // stage = put with sync:false
      await db.blobs.stage(blobHash, blobBytes, { mime: 'text/plain', name: 'staged.txt' })

      const status = db.blobs.status(blobHash)
      assertEqual(status?.status, BLOB_STATUS.READY, 'staged blob is READY locally')
      assert(!!status?.url, 'staged blob has an Object URL')
    })
  })
}

export { registerBlobStepsBrowserSuite }
