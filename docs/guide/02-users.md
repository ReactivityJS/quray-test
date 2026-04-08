# 02 — Users & Identity

Users are the **foundation** of QuRay. Every piece of data is authored by a user,
and every QuBit carries a cryptographic proof of authorship.

---

## What is a User?

A QuRay **user** is a cryptographic identity consisting of two key pairs:

| Key | Algorithm | Purpose |
|-----|-----------|---------|
| `pub` / private key | ECDSA P-256 | **Signing** — prove authorship of QuBits |
| `epub` / private key | ECDH P-256 | **Encryption** — receive E2E encrypted messages |

A user is **created automatically** on first `QuRay.init()`. The identity is stored
in the browser and optionally backed up with a passphrase.

---

## User Space: `~{pub64}/`

Every user owns a **user space** — a namespaced region of the database where only
they can write. The prefix is `~` followed by the user's base64url public key:

```
~{pub64}/alias          Display name (string)
~{pub64}/avatar         Profile picture (base64 or URL)
~{pub64}/epub           ECDH public key (readonly — set by framework)
~{pub64}/pub            ECDSA public key (readonly — set by framework)
~{pub64}/bio            Biography (any JSON)
~{pub64}/status         Visibility ('public' | 'hidden')
~{pub64}/backup         Encrypted keypair backup
~{pub64}/blob/{hash}    Blob metadata owned by this user
~{pub64}/myapp/...      App-specific user data (any subkeys)
```

**Only the owner of that public key can write to `~{pub64}/...`.**
This is enforced cryptographically by the `AccessControlPlugin`.

### The `~/` shorthand

Within the API, `~/` always expands to the **current user's own user space**:

```js
await qr.db.put('~/alias', 'Alice')
// equivalent to:
await qr.db.put(`~${qr.me.pub}/alias`, 'Alice')
```

---

## Creating or Restoring an Identity

### First time — new identity

```js
const qr = await QuRay.init({
  alias: 'Alice',          // stored at ~/alias
  relay: 'wss://...',
})

console.log(qr.me.pub)    // base64url public key (your permanent ID)
console.log(qr.me.epub)   // base64url ECDH encryption key
```

### Save a backup

```js
// Unencrypted backup (store in secure location)
const backup = await qr.me.backup()

// Encrypted backup (recommended)
const encryptedBackup = await qr.me.backup('my-strong-passphrase')

// Save to localStorage or your own storage
localStorage.setItem('quray-backup', JSON.stringify(encryptedBackup))
```

### Restore an existing identity

```js
const savedBackup = JSON.parse(localStorage.getItem('quray-backup'))

const qr = await QuRay.init({
  identity:   savedBackup,              // restore keypair
  passphrase: 'my-strong-passphrase',  // decrypt backup (if encrypted)
  relay:      'wss://...',
})

// Same pub key as before — continuity of identity
console.log(qr.me.pub)
```

---

## The LocalPeer API: `qr.me`

`qr.me` represents **the current user** (the local peer).

### Identity Properties

```js
qr.me.pub       // ECDSA public key (base64url) — your permanent ID
qr.me.epub      // ECDH public key (base64url) — for E2E encryption
qr.me.alias     // Display name (string)
qr.me.avatar    // Profile image data (or null)
```

### Profile Management

```js
// Set display name — writes to ~/alias and syncs
await qr.me.setAlias('Bob')

// Or directly via the database
await qr.db.put('~/alias', 'Bob')

// Watch own profile changes
const off = qr.me.watch(() => {
  console.log('Profile changed:', qr.me.alias)
  updateUI(qr.me.alias, qr.me.avatar)
})
// cleanup:
off()
```

### Cryptographic Operations

```js
// Sign arbitrary data
const signature = await qr.me.sign('hello world')

// Verify a signature from another user
const valid = await qr.me.verify('hello world', signature, otherPub)

// Encrypt a message for one recipient
const envelope = await qr.me.encrypt('secret text', [{ pub: bobPub, epub: bobEpub }])

// Decrypt (your own messages or messages encrypted for you)
const plaintext = await qr.me.decrypt(envelope)

// Create backup
const backup = await qr.me.backup('passphrase')
```

---

## Remote Peers: `qr.peers`

`qr.peers` gives access to **other known users** (remote peers).

### Basic Usage

```js
// Get a specific peer by public key
const alice = qr.peers.get(alicePub)

// All known peers
const everyone = qr.peers.all   // RemotePeer[]

// Only online peers
const online = qr.peers.online  // RemotePeer[]
```

### RemotePeer Properties

```js
const peer = qr.peers.get(alicePub)

peer.pub     // ECDSA public key
peer.epub    // ECDH encryption key (null if not yet synced)
peer.alias   // Display name (null if not yet synced)
peer.avatar  // Profile picture (null if not yet synced)
peer.online  // boolean — true if currently connected
```

### Reacting to Peer Changes

```js
// Watch a specific peer
const off = peer.on((updatedPeer) => {
  renderPeerRow(updatedPeer.alias, updatedPeer.online)
})

// Watch all peer changes
const off = qr.peers.onChange((peerMap) => {
  for (const p of peerMap.all) renderPeerRow(p)
})
```

### Watching Peer Online State via QuDB

Peer presence is also stored in `sys/peers/` and can be watched reactively:

```js
qr.db.on(`sys/peers/${alicePub}`, (q) => {
  const isOnline = q?.data?.online ?? false
  showOnlineIndicator(isOnline)
})
```

---

## Profile Patterns

### Example 1 — Simple: Display your own profile

```js
// Write your profile
await qr.db.put('~/alias', 'Alice')
await qr.db.put('~/bio', { text: 'P2P enthusiast' })

// React to changes
qr.db.on('~/alias', (q) => {
  document.getElementById('my-name').textContent = q?.data ?? 'Unknown'
})
```

```html
<!-- Or use native qu-* binding (zero JS needed) -->
<span qu-key="~/alias"></span>
<p qu-key="~/bio"></p>

<!-- Editable name field (two-way binding) -->
<input qu-key="~/alias" qu-bind="value" qu-mode="two-way">
```

### Example 2 — Complex: Multi-field profile with avatar upload

```js
// Upload avatar
const file   = avatarInput.files[0]
const buffer = await file.arrayBuffer()
const hash   = await KEY.sha256url(buffer)

await qr.db.blobs.put(hash, buffer, { mime: file.type, name: file.name })
await qr.db.put('~/avatar', hash)  // store hash reference

// Write complete profile at once
await Promise.all([
  qr.db.put('~/alias',  profileForm.name.value),
  qr.db.put('~/bio',    { text: profileForm.bio.value }),
  qr.db.put('~/status', 'public'),
  qr.db.put('~/myapp/prefs', {
    theme:         'dark',
    notifications: true,
    language:      'en',
  }),
])

// React to avatar changes
qr.db.on('~/avatar', async (q) => {
  if (!q?.data) return
  const { url } = qr.db.blobs.status(q.data) ?? {}
  if (url) avatarImg.src = url
})
```

```html
<!-- Profile card with all bindings -->
<div class="profile-card">
  <qu-media key="~/avatar" size="96"></qu-media>
  <h2><span qu-key="~/alias"></span></h2>
  <p qu-key="~/bio"></p>
</div>

<!-- Or use the built-in profile component -->
<qu-user-profile pub="CURRENT_PUB" editable></qu-user-profile>
```

### Example 3 — Display another user's profile

```js
const bobPub = '...'  // obtained via relay or invitation

// Read Bob's profile
const alias  = await qr.db.get(KEY.user(bobPub).alias)
const avatar = await qr.db.get(KEY.user(bobPub).avatar)

console.log(alias?.data)   // 'Bob'
console.log(avatar?.data)  // hash or URL

// Watch Bob's profile for live updates
qr.db.on(`~${bobPub}/**`, (q, { event }) => {
  if (event === 'put') refreshProfile(q)
})
```

```html
<!-- Built-in peer components -->
<qu-avatar pub="BOB_PUB" size="48"></qu-avatar>
<qu-peer pub="BOB_PUB"></qu-peer>

<!-- Profile card for another user -->
<qu-profile-card pub="BOB_PUB"></qu-profile-card>

<!-- Online status indicator -->
<qu-status pub="BOB_PUB" label></qu-status>
```

---

## Multi-Device Usage

The same identity can be active on multiple devices simultaneously. All writes
to `~{pub64}/` sync across devices via the relay:

```js
// Device A — create identity and get backup
const qrA = await QuRay.init({ alias: 'Alice', relay: 'wss://...' })
const backup = await qrA.me.backup('passphrase')

// Device B — restore same identity
const qrB = await QuRay.init({
  identity:   backup,
  passphrase: 'passphrase',
  relay:      'wss://...',
})

// Both devices share the same pub key
console.log(qrA.me.pub === qrB.me.pub)  // true

// Writes on Device A appear on Device B
await qrA.db.put('~/note', 'Written on Device A')
qrB.db.on('~/note', (q) => console.log(q?.data))  // 'Written on Device A'
```

---

## Security Notes

- **Private keys never leave the device** in plaintext — they are generated in the browser's Web Crypto API
- **Backup encryption** uses PBKDF2 (100,000 iterations) + AES-256-GCM
- **`~/` writes are rejected** from other peers — only the key owner can write to their user space
- **Signatures are verified** on the IN pipeline before any data is stored

---

## Next: Spaces →

Continue to [03 — Spaces](./03-spaces.md) to learn how to create shared data containers with multiple users.
