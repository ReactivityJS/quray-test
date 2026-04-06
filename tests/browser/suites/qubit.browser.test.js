import { KEY, ts16, resolveStorageKeyReference } from '../../../src/core/qubit.js'

function registerQuBitBrowserSuite(registerSuite) {
  registerSuite('QuBit core', 'Timestamp and key helpers', ({ test }) => {
    test('ts16 returns a sortable 16-digit string', async ({ assert, assertMatch }) => {
      const earlierTimestamp = ts16(1_700_000_000_000)
      const middleTimestamp = ts16(1_700_000_001_000)
      const laterTimestamp = ts16(1_800_000_000_000)

      assertMatch(earlierTimestamp, /^\d{16}$/u, 'ts16 format')
      assert(earlierTimestamp < middleTimestamp, 'earlier timestamp should sort before middle timestamp')
      assert(middleTimestamp < laterTimestamp, 'middle timestamp should sort before later timestamp')
    })

    test('KEY helpers create the expected namespaces', async ({ assertEqual }) => {
      const publicKey = 'pub-demo'

      assertEqual(KEY.user(publicKey).root, '~pub-demo', 'user root key')
      assertEqual(KEY.user(publicKey).space, '~pub-demo/', 'user space key')
      assertEqual(KEY.user(publicKey).alias, '~pub-demo/alias', 'user alias key')
      assertEqual(KEY.user(publicKey).avatar, '~pub-demo/avatar', 'user avatar key')
      assertEqual(KEY.user(publicKey).pub, '~pub-demo/pub', 'user pub key')
      assertEqual(KEY.user(publicKey).epub, '~pub-demo/epub', 'user epub key')
      assertEqual(KEY.user(publicKey).blob('hash-demo'), '~pub-demo/blob/hash-demo', 'user blob meta key')
      assertEqual(KEY.inbox(publicKey).root, '>pub-demo/', 'inbox root key')
      assertEqual(KEY.space('room-1').meta, '@room-1/~meta', 'space meta key')
      assertEqual(KEY.space('room-1').acl, '@room-1/~acl', 'space acl key')
      assertEqual(KEY.peer(publicKey), 'sys/peers/pub-demo', 'peer state key')
    })
    test('resolveStorageKeyReference expands current-user shorthand keys', async ({ assertEqual }) => {
      const currentUserPublicKey = 'pub-demo'

      assertEqual(resolveStorageKeyReference('~', { currentUserPublicKey }), '~pub-demo', 'current user root shorthand')
      assertEqual(resolveStorageKeyReference('~/', { currentUserPublicKey }), '~pub-demo/', 'current user space shorthand')
      assertEqual(resolveStorageKeyReference('~/alias', { currentUserPublicKey }), '~pub-demo/alias', 'current user alias shorthand')
      assertEqual(resolveStorageKeyReference('@room/item', { currentUserPublicKey }), '@room/item', 'non-user keys stay unchanged')
    })
  })
}

export { registerQuBitBrowserSuite }
