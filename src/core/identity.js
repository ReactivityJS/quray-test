// ════════════════════════════════════════════════════════════════════════════
// QuRay — identity.js
// Kryptographie: ECDSA + ECDH + AES-GCM + PBKDF2-Backup
//
// Zentrale Identität des Framework-Nutzers. Es gibt genau eine
// aktive Identität pro QuRay-Instanz. Kein anderes Modul greift
// direkt auf Schlüssel zu — alles läuft über diese API.
//
// ┌─ Schlüsselpaare ──────────────────────────────────────────────┐
// │  ECDSA P-256   signKey   → sign / verify                      │
// │  ECDH  P-256   encKey    → encrypt / decrypt                  │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ Verschlüsselungs-Modi ───────────────────────────────────────┐
// │  DM       recipient = epub-String    → ECDH direkt            │
// │  Gruppe   recipient = [{pub,epub},…] → Envelope mit CK        │
// │  Self     recipient = null           → Envelope keys[ownPub]  │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ EncData-Format ──────────────────────────────────────────────┐
// │  { ct, iv, by, epub }              DM / Self                  │
// │  { ct, iv, by, epub, keys:{…} }    Envelope                   │
// └───────────────────────────────────────────────────────────────┘
//
// Requires: Web Cryptography API (crypto.subtle)
//           Nur in Secure Context verfügbar (https:// oder localhost)
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════

import { Signal } from './events.js'


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE KRYPTO-KONSTANTEN
// ─────────────────────────────────────────────────────────────────────────────
const ALGO_ECDSA     = { name: 'ECDSA',   namedCurve: 'P-256' }
const ALGO_ECDH      = { name: 'ECDH',    namedCurve: 'P-256' }
const ALGO_AES_GCM   = { name: 'AES-GCM', length: 256 }
const ALGO_PBKDF2    = 'PBKDF2'
const IV_BYTE_LENGTH = 12
const PBKDF2_ITERATIONS = 100_000


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE BYTE-HELFER
// ─────────────────────────────────────────────────────────────────────────────
const _textEncoder = new TextEncoder()
const _textDecoder = new TextDecoder()

const _bufferToBase64 = (buffer) => {
  const bytes       = new Uint8Array(buffer)
  let   binaryString = ''
  // Chunk-weise um Call-Stack-Overflow bei großen Puffern zu vermeiden
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binaryString += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binaryString)
}

// base64url — kein +, /, = → sicher in URLs, CSS-Selektoren, HTML-IDs, IDB-Keys, JSON-Keys
const _bufferToBase64url = (buffer) =>
  _bufferToBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

// ── sha256b64url — kanonische Blob-Hash-Funktion des Frameworks ──────────────
// Gibt SHA-256 als base64url zurück (URL-safe, kein +/=).
// Dies ist die einzige Implementierung — alle Blob-Hashes im Framework nutzen
// dieses Format. Relay und Client müssen exakt dieselbe Ausgabe produzieren.
// Eingabe: ArrayBuffer | Uint8Array
export const sha256b64url = async (buffer) => {
  const buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer ?? new Uint8Array(buffer).buffer
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return _bufferToBase64url(hash)
}

// base64url → raw base64 (für SubtleCrypto importKey die 'spki' erwartet)
const _base64urlToBase64 = (s) => {
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = std.length % 4
  return pad ? std + '='.repeat(4 - pad) : std
}

const _base64ToBuffer = (base64String) =>
  Uint8Array.from(atob(base64String), char => char.charCodeAt(0))

// Akzeptiert base64url ODER raw base64 — robust gegen alte Backups
const _base64AnyToBuffer = (s) => _base64ToBuffer(
  s.includes('-') || s.includes('_') || !s.includes('=') ? _base64urlToBase64(s) : s
)

const _stringToBuffer = (str) => _textEncoder.encode(str)
const _bufferToString = (buf) => _textDecoder.decode(buf)


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE KEY-IMPORT/EXPORT HELFER
// ─────────────────────────────────────────────────────────────────────────────
// Öffentliche Keys werden IMMER als base64url exportiert:
//   kein +, /, = → direkt verwendbar in IDB-Keys, URLs, CSS, HTML-IDs, JSON-Keys
const _exportPublicKey  = (key) =>
  crypto.subtle.exportKey('spki', key).then(_bufferToBase64url)

const _exportPrivateKey = (key) =>
  crypto.subtle
    .exportKey('jwk', key)
    .then(jwk => _bufferToBase64(_stringToBuffer(JSON.stringify(jwk))))

// Akzeptiert base64url ODER altes raw base64 — für Rückwärtskompatibilität mit Backups
const _importPublicKey  = (base64Key, algorithm, usages = []) =>
  crypto.subtle.importKey('spki', _base64AnyToBuffer(base64Key), algorithm, true, usages)

const _importPrivateKey = (base64Key, algorithm, usages) =>
  crypto.subtle.importKey(
    'jwk',
    JSON.parse(_bufferToString(_base64ToBuffer(base64Key))),
    algorithm, true, usages
  )


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE AES-GCM HELFER
// ─────────────────────────────────────────────────────────────────────────────
const _aesEncrypt = async (aesKey, plaintext) => {
  const iv         = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    typeof plaintext === 'string' ? _stringToBuffer(plaintext) : plaintext
  )
  return { ct: _bufferToBase64(ciphertext), iv: _bufferToBase64(iv) }
}

const _aesDecrypt = (aesKey, ciphertextBase64, ivBase64) =>
  crypto.subtle
    .decrypt({ name: 'AES-GCM', iv: _base64ToBuffer(ivBase64) }, aesKey, _base64ToBuffer(ciphertextBase64))
    .then(_bufferToString)


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE ECDH SHARED-KEY ABLEITUNG
// ─────────────────────────────────────────────────────────────────────────────
const _deriveSharedAesKey = async (myEcdhPrivateKey, theirEpubBase64) => {
  const theirPublicKey = await _importPublicKey(theirEpubBase64, ALGO_ECDH, [])
  const sharedBits     = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey },
    myEcdhPrivateKey,
    256
  )
  return crypto.subtle.importKey('raw', sharedBits, 'AES-GCM', false, ['encrypt', 'decrypt'])
}


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE VERSCHLÜSSELUNGS-PFADE
// ─────────────────────────────────────────────────────────────────────────────

// DM-Pfad: direkte ECDH mit einem Empfänger-epub
const _encryptDirect = async (identityData, ecdhPrivateKey, plaintext, recipientEpub) => {
  const sharedKey = await _deriveSharedAesKey(ecdhPrivateKey, recipientEpub)
  return {
    by:   identityData.pub,
    epub: identityData.epub,
    ...await _aesEncrypt(sharedKey, plaintext)
  }
}

// Envelope-Pfad: einmaliger Content-Key, für jeden Empfänger individuell eingepackt
const _encryptEnvelope = async (identityData, ecdhPrivateKey, plaintext, recipientList) => {
  // 1. Einmaliger Content-Key (CK)
  const contentKey    = await crypto.subtle.generateKey(ALGO_AES_GCM, true, ['encrypt', 'decrypt'])
  const contentKeyRaw = await crypto.subtle.exportKey('raw', contentKey)

  // 2. Payload einmal mit CK verschlüsseln
  const encryptedPayload = await _aesEncrypt(contentKey, plaintext)

  // 3. CK für jeden Empfänger mit dessen ECDH-Shared-Key einpacken
  const wrappedKeys = {}
  for (const { pub, epub } of recipientList) {
    const sharedKey         = await _deriveSharedAesKey(ecdhPrivateKey, epub)
    const wrappedIv         = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH))
    const wrappedCiphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: wrappedIv },
      sharedKey,
      contentKeyRaw   // raw ArrayBuffer, kein String-Encoding
    )
    wrappedKeys[pub] = { ct: _bufferToBase64(wrappedCiphertext), iv: _bufferToBase64(wrappedIv) }
  }

  return {
    by:   identityData.pub,
    epub: identityData.epub,
    ...encryptedPayload,
    keys: wrappedKeys
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// INTERNE ENTSCHLÜSSELUNGS-PFADE
// ─────────────────────────────────────────────────────────────────────────────
const _decryptDirect = async (ecdhPrivateKey, encData) => {
  if (!encData.epub) throw new Error('identity.decrypt: epub fehlt in EncData (DM-Pfad)')
  const sharedKey = await _deriveSharedAesKey(ecdhPrivateKey, encData.epub)
  return _aesDecrypt(sharedKey, encData.ct, encData.iv)
}

const _decryptEnvelope = async (identityData, ecdhPrivateKey, encData) => {
  // Suche sowohl unter base64url (neu) als auch raw base64 (alte Nachrichten)
  const wrappedKey = encData.keys?.[identityData.pub]
    ?? encData.keys?.[fromPub64(identityData.pub)]
  if (!wrappedKey) throw new Error('identity.decrypt: Empfänger nicht in keys-Map')
  if (!encData.epub) throw new Error('identity.decrypt: epub fehlt in EncData (Envelope)')

  // CK entpacken
  const sharedKey        = await _deriveSharedAesKey(ecdhPrivateKey, encData.epub)
  const contentKeyBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: _base64ToBuffer(wrappedKey.iv) },
    sharedKey,
    _base64ToBuffer(wrappedKey.ct)
  )

  // Payload mit CK entschlüsseln
  const contentKey = await crypto.subtle.importKey('raw', contentKeyBuffer, ALGO_AES_GCM, false, ['decrypt'])
  return _aesDecrypt(contentKey, encData.ct, encData.iv)
}


// ─────────────────────────────────────────────────────────────────────────────
// PBKDF2 BACKUP-SCHUTZ
// ─────────────────────────────────────────────────────────────────────────────
const _protectWithPassphrase = async (dataObject, passphrase) => {
  const salt    = crypto.getRandomValues(new Uint8Array(16))
  const baseKey = await crypto.subtle.importKey('raw', _stringToBuffer(passphrase), ALGO_PBKDF2, false, ['deriveKey'])
  const aesKey  = await crypto.subtle.deriveKey(
    { name: ALGO_PBKDF2, hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt },
    baseKey, ALGO_AES_GCM, false, ['encrypt', 'decrypt']
  )
  return { encrypted: true, salt: _bufferToBase64(salt), ...await _aesEncrypt(aesKey, JSON.stringify(dataObject)) }
}

const _unprotectWithPassphrase = async (backupObject, passphrase) => {
  const salt    = _base64ToBuffer(backupObject.salt)
  const baseKey = await crypto.subtle.importKey('raw', _stringToBuffer(passphrase), ALGO_PBKDF2, false, ['deriveKey'])
  const aesKey  = await crypto.subtle.deriveKey(
    { name: ALGO_PBKDF2, hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt },
    baseKey, ALGO_AES_GCM, false, ['encrypt', 'decrypt']
  )
  const plaintext = await _aesDecrypt(aesKey, backupObject.ct, backupObject.iv)
  return JSON.parse(plaintext)
}



// ─────────────────────────────────────────────────────────────────────────────
// PUB-KEY ENCODING
//
// identity.pub / identity.epub sind IMMER base64url (kein +, /, =):
//   → direkt sicher in IDB-Keys, URLs, CSS-Selektoren, HTML-IDs, JSON-Keys
//   → _exportPublicKey() gibt base64url zurück
//   → _importPublicKey() akzeptiert base64url UND altes raw base64 (Backups)
//
//   pub64(pub)   → No-Op wenn pub bereits base64url; konvertiert altes raw base64
//                  Alle bestehenden pub64()-Aufrufe bleiben harmlos, können
//                  schrittweise entfernt werden.
//   fromPub64(s) → nur noch intern in _base64AnyToBuffer() für Krypto-Import
//   pubShort(p)  → erste 16 Zeichen des base64url als Kurz-ID
// ─────────────────────────────────────────────────────────────────────────────

// Idempotent: base64url bleibt base64url; konvertiert altes raw base64 falls nötig
const pub64 = (pub) =>
  (pub ?? '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

// Intern: base64url → raw base64 für SubtleCrypto (nur in _base64AnyToBuffer nötig)
const fromPub64 = (s) => {
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = std.length % 4
  return pad ? std + '='.repeat(4 - pad) : std
}

// Kurz-Anzeige für UI (erste 16 Zeichen des pub64)
const pubShort = (pub) => pub64(pub).slice(0, 16) + '…'

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY FACTORY
// Erstellt oder lädt ein Schlüsselpaar.
//
//   Identity({ backup?, passphrase? })  → Promise<identityInstance>
//
// backup: gespeichertes Identitäts-Objekt (aus identity.backup())
//         Mit Passphrase → verschlüsselt { salt, ct, iv }
//         Ohne            → { pub, epub, signPriv, encPriv, alias }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Create or restore a cryptographic identity.
 * Generates ECDSA (signing) + ECDH (encryption) key pairs.
 * If no backup is provided, a new identity is generated and persisted via QuRay.init().
 *
 * @param {object} [options]
 * @param {string} [options.alias=''] - Display name
 * @param {object} [options.backup] - Exported backup object to restore an existing identity
 * @param {string} [options.passphrase] - Passphrase to decrypt an encrypted backup
 * @returns {Promise<IdentityInstance>}
 * @group Identity
 * @since 0.1.0
 *
 * @example
 * // New identity
 * const me = await Identity({ alias: 'Alice' })
 * console.log(me.pub)   // ECDSA public key (base64url)
 * console.log(me.epub)  // ECDH public key (base64url)
 *
 * @example
 * // Restore from backup
 * const backup = JSON.parse(localStorage.getItem('identity-backup'))
 * const me = await Identity({ backup, passphrase: 'secret' })
 *
 * @example
 * // Export for backup/restore
 * const backup = await me.exportBackup('optional-passphrase')
 */
const Identity = async ({ alias = '', backup = null, passphrase = null } = {}) => {
  let _ecdsaKeyPair   // { publicKey, privateKey } ECDSA
  let _ecdhKeyPair    // { publicKey, privateKey } ECDH
  let _identityData   // { pub, epub, signPriv, encPriv, alias }

  // ── Initialisierung ─────────────────────────────────────────────────────

  if (backup) {
    // Bestehende Identität laden
    const rawData = backup.ct
      ? await _unprotectWithPassphrase(backup, passphrase)
      : backup

    // Normalisieren: altes raw base64 → base64url (falls Backup noch +/= enthält)
    _identityData = {
      ...rawData,
      pub:  pub64(rawData.pub),
      epub: pub64(rawData.epub),
    }
    _ecdsaKeyPair = {
      publicKey:  await _importPublicKey (rawData.pub,      ALGO_ECDSA, ['verify']),
      privateKey: await _importPrivateKey(rawData.signPriv, ALGO_ECDSA, ['sign']),
    }
    _ecdhKeyPair  = {
      publicKey:  await _importPublicKey (rawData.epub,    ALGO_ECDH,   []),
      privateKey: await _importPrivateKey(rawData.encPriv, ALGO_ECDH,   ['deriveBits']),
    }
    /*DEBUG*/ console.info('[QuRay:identity] Identität geladen:', _identityData.pub.slice(0, 16) + '…')
  } else {
    // Neue Identität generieren
    _ecdsaKeyPair = await crypto.subtle.generateKey(ALGO_ECDSA, true, ['sign', 'verify'])
    _ecdhKeyPair  = await crypto.subtle.generateKey(ALGO_ECDH,  true, ['deriveBits'])
    _identityData = {
      alias,
      pub:      await _exportPublicKey (_ecdsaKeyPair.publicKey),
      epub:     await _exportPublicKey (_ecdhKeyPair.publicKey),
      signPriv: await _exportPrivateKey(_ecdsaKeyPair.privateKey),
      encPriv:  await _exportPrivateKey(_ecdhKeyPair.privateKey),
    }
    /*DEBUG*/ console.info('[QuRay:identity] created new identity:', _identityData.pub.slice(0, 16) + '…')
  }

  // isLoaded als Signal — UI kann reaktiv auf Identitäts-Status reagieren
  const isLoaded$ = Signal(true)

  // ── Öffentliche API ─────────────────────────────────────────────────────

  /**
   * Sign a string with the ECDSA private key.
   * @param {string} dataString - Data to sign
   * @returns {Promise<string>} Base64-encoded signature
   * @group Identity
   * @example
   * const sig = await me.sign(JSON.stringify(payload))
   */
  const sign = async (dataString) => {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      _ecdsaKeyPair.privateKey,
      _stringToBuffer(dataString)
    )
    return _bufferToBase64(signature)
  }

  /**
   * Verify an ECDSA signature.
   * @param {string} dataString - Original data
   * @param {string} signatureBase64 - Base64 signature to verify
   * @param {string} [publicKeyBase64] - Public key to verify against (default: own key)
   * @returns {Promise<boolean>}
   * @group Identity
   * @example
   * const ok = await me.verify(data, sig, peerPub)
   */
  const verify = async (dataString, signatureBase64, publicKeyBase64 = null) => {
    try {
      const verifyKey = publicKeyBase64
        ? await _importPublicKey(publicKeyBase64, ALGO_ECDSA, ['verify'])
        : _ecdsaKeyPair.publicKey
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        _base64ToBuffer(signatureBase64),
        _stringToBuffer(dataString)
      )
    } catch (verifyError) {
      /*DEBUG*/ console.warn('[QuRay:identity] verify Fehler:', verifyError.message)
      return false
    }
  }

  // encrypt(plaintext, recipient)
  //   recipient = epub-String    → DM
  //   recipient = [{pub,epub},…] → Envelope (Gruppe)
  //   recipient = null           → Self (nur ich kann lesen)
  const encrypt = (plaintext, recipient = null) => {
    if (Array.isArray(recipient)) {
      return _encryptEnvelope(_identityData, _ecdhKeyPair.privateKey, plaintext, recipient)
    }
    if (recipient === null) {
      // Self: Envelope mit nur eigenem Schlüssel
      return _encryptEnvelope(_identityData, _ecdhKeyPair.privateKey, plaintext, [
        { pub: _identityData.pub, epub: _identityData.epub }
      ])
    }
    return _encryptDirect(_identityData, _ecdhKeyPair.privateKey, plaintext, recipient)
  }

  // decrypt erkennt DM / Envelope / Self automatisch anhand der Datenstruktur
  const decrypt = (encData) => {
    if (!encData?.ct || !encData?.iv) throw new Error('identity.decrypt: kein gültiges EncData-Objekt')
    return encData.keys
      ? _decryptEnvelope(_identityData, _ecdhKeyPair.privateKey, encData)
      : _decryptDirect(_ecdhKeyPair.privateKey, encData)
  }

  const hash = async (buffer) => {
    const arrayBuffer = buffer instanceof ArrayBuffer
      ? buffer
      : new Uint8Array(buffer).buffer
    return _bufferToBase64(await crypto.subtle.digest('SHA-256', arrayBuffer))
  }

  // backup: vollständiger Export aller Schlüssel
  // Mit passphrase → PBKDF2-verschlüsselt
  const exportBackup = (backupPassphrase = null) =>
    backupPassphrase
      ? _protectWithPassphrase(_identityData, backupPassphrase)
      : Promise.resolve({ ..._identityData })

  // Hilfsobjekt für anderen Peer — vereinfacht Operationen mit fremden Schlüsseln
  const peer = (peerPub, peerEpub) => ({
    pub:  peerPub,
    epub: peerEpub,
    verify:  (data, sig)  => verify(data, sig, peerPub),
    encrypt: (plaintext)  => _encryptDirect(_identityData, _ecdhKeyPair.privateKey, plaintext, peerEpub),
  })

  return {
    // ── Identität ─────────────────────────────────────────────────────────
    get pub()           { return _identityData.pub   },
    get epub()          { return _identityData.epub  },
    get alias()         { return _identityData.alias },
    set alias(newAlias) { _identityData.alias = newAlias },
    isLoaded$,

    // ── Krypto ────────────────────────────────────────────────────────────
    sign,
    verify,
    encrypt,
    decrypt,
    hash,

    // ── Backup / Export ───────────────────────────────────────────────────
    backup:       exportBackup,   // primary name
    exportBackup,                 // alias (rückwärtskompatibel)

    // ── Peer-Hilfsobjekt (Low-Level) ──────────────────────────────────────
    peer,
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export {
  Identity,
  pub64,
  fromPub64,
  pubShort,
  // sha256b64url — exported inline as `export const sha256b64url` above
  // Byte helpers used by other modules
  _bufferToBase64 as bufferToBase64,
  _base64ToBuffer as base64ToBuffer,
}
