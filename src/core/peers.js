// ════════════════════════════════════════════════════════════════════════════
// QuRay — core/peers.js  (v1.0)
//
// EIN Peer-Typ — zwei Modi:
//   full   = LocalPeer (ich selbst): volle Crypto-Keys, kann schreiben
//   remote = RemotePeer: nur pub/epub, kann verifizieren und verschlüsseln
//
// PeerMap = reaktive Map<pub64 → Peer> + db.on Watcher.
// Keine doppelte Logik — Peer ist Peer, unabhängig vom Modus.
// ════════════════════════════════════════════════════════════════════════════

import { pub64, pubShort }             from './identity.js'
import { KEY }                          from './qubit.js'

// Crypto helpers (shared by both modes)
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const ECDH  = { name: 'ECDH',  namedCurve: 'P-256' }
const _enc  = new TextEncoder()
const _b64ToBuffer = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0))
const _bufToB64    = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))

const _importKey = (b64, algo, usages, format = 'spki') => {
  const buf = format === 'jwk'
    ? JSON.parse(new TextDecoder().decode(_b64ToBuffer(b64)))
    : _b64ToBuffer(b64)
  return crypto.subtle.importKey(format, buf, algo, true, usages)
}

const _deriveAes = async (myEpriv, theirEpub) => {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirEpub }, myEpriv, 256)
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

const _aesEncrypt = async (aesKey, plaintext) => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, _enc.encode(plaintext))
  return { ct: _bufToB64(ct), iv: _bufToB64(iv) }
}

// Lazy crypto-key cache — invalidated when epub changes
const _makeKeyCache = () => {
  let _p = null
  return { get: (fn) => _p ?? (_p = fn()), invalidate: () => { _p = null } }
}


// ═════════════════════════════════════════════════════════════════════════════
// Peer — eine einzige Implementierung fuer lokale und remote Peers.
//
//   mode='full'   → identity (priv + epub), db, kann schreiben
//   mode='remote' → nur pub (optional epub), kein Schreiben
// ═════════════════════════════════════════════════════════════════════════════

const Peer = ({ mode = 'remote', identity = null, db = null, initialPub = null } = {}) => {

  const _pub     = mode === 'full' ? identity.pub  : initialPub
  let   _epub    = mode === 'full' ? identity.epub : null
  let   _alias   = mode === 'full' ? (identity.alias ?? pubShort(_pub)) : pubShort(_pub)
  let   _avatar  = null
  let   _props   = []
  let   _online  = mode === 'full'
  let   _rtc     = null

  const _keyCache = _makeKeyCache()
  const _subs     = new Set()
  const _notify   = () => _subs.forEach(fn => fn(_api))


  // Partial profile update — feuert nur wenn Wert sich aendert
  const _update = (node = {}) => {
    let dirty = false
    if (node.epub   !== undefined && node.epub   !== _epub  ) { _epub   = node.epub; _keyCache.invalidate(); dirty = true }
    if (node.alias  !== undefined && node.alias  !== _alias ) { _alias  = node.alias;  dirty = true }
    if (node.avatar !== undefined && node.avatar !== _avatar) { _avatar = node.avatar || null; dirty = true }
    if (node.props  !== undefined) {
      const pub = (node.props || []).filter(p => !p.encrypted)
      if (JSON.stringify(pub) !== JSON.stringify(_props)) { _props = pub; dirty = true }
    }
    if (dirty) _notify()
  }

  const _setOnline = (online) => {
    if (online) _lastSeen = Date.now()
    if (_online !== online) { _online = online; _notify() }
  }
  let _lastSeen = null
  const _setRtc    = (rtc)    => { _rtc = rtc; _notify() }
  const onChange   = (fn)     => { _subs.add(fn); return () => _subs.delete(fn) }


  // Lazy crypto keys — both modes use same cache mechanism
  const _cryptoKeys = () => _keyCache.get(async () => {
    if (mode === 'full') {
      const raw = await identity.exportBackup()
      const [pubKey, epubKey, privKey, eprivKey] = await Promise.all([
        _importKey(raw.pub,      ECDSA, ['verify']),
        _importKey(raw.epub,     ECDH,  []),
        _importKey(raw.signPriv, ECDSA, ['sign'],       'jwk'),
        _importKey(raw.encPriv,  ECDH,  ['deriveBits'], 'jwk'),
      ])
      return { pub: pubKey, epub: epubKey, priv: privKey, epriv: eprivKey }
    }
    const pubKey  = await _importKey(_pub, ECDSA, ['verify'])
    const epubKey = _epub ? await _importKey(_epub, ECDH, []) : null
    return { pub: pubKey, epub: epubKey, priv: null, epriv: null }
  })

  // verify — works in both modes (public key only)
  const verify = async (dataString, sig) => {
    try {
      const { pub: key } = await _cryptoKeys()
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, _b64ToBuffer(sig), _enc.encode(dataString))
    } catch { return false }
  }

  // encrypt — remote: encrypts for this peer; full: delegates to identity (envelope)
  const encrypt = async (plaintext, arg) => {
    if (mode === 'full') return identity.encrypt(plaintext, arg)
    if (!_epub) throw new Error(`Peer.encrypt: no epub (${pubShort(_pub)})`)
    const { epub: theirKey } = await _cryptoKeys()
    return _aesEncrypt(await _deriveAes(arg, theirKey), plaintext)
  }

  // Full-mode only operations
  const sign    = (s) => { if (mode!=='full') throw new Error('not local'); return identity.sign(s) }
  const decrypt = (e) => { if (mode!=='full') throw new Error('not local'); return identity.decrypt(e) }
  const backup  = (p) => { if (mode!=='full') throw new Error('not local'); return identity.exportBackup(p) }

  // READONLY_FIELDS — written once at identity creation, never overwritten
  const READONLY_FIELDS = new Set(['pub', 'epub'])

  // _writeField: write a single sub-key ~{pub}/{field} atomically
  // Each field is its own signed QuBit with independent id + ts + from.
  // Readonly fields are idempotent: skipped if already stored.
  const _writeField = async (field, value) => {
    if (!db || mode !== 'full') return
    if (READONLY_FIELDS.has(field)) {
      const existing = await db.get(KEY.user(_pub).field(field))
      if (existing?.data != null) return  // already written — never overwrite
    }
    if (value === null || value === undefined) {
      await db.del(KEY.user(_pub).field(field))
    } else {
      await db.put(KEY.user(_pub).field(field), value)
    }
  }

  // _writeNode: write all identity fields as atomic independent sub-keys.
  // No root node cache — pub/epub/alias are each their own QuBit.
  const _writeNode = async () => {
    if (!db || mode !== 'full') return
    await Promise.all([
      _writeField('pub',   _pub),   // readonly
      _writeField('epub',  _epub),  // readonly
      _writeField('alias', _alias), // writable, defaults to pub if not set
    ])
  }

  const setAlias = async (newAlias) => {
    _alias = newAlias; identity.alias = newAlias
    await _writeField('alias', newAlias)   // just one write, no cache to keep
    await db._internal.write('conf/identity', await identity.exportBackup(), 'local')
    _notify()
  }

  const getAvatar = async () => {
    if (!db) return null
    const q = await db.get(KEY.user(_pub).field('avatar'))
    return q?.data ?? q ?? null
  }

  const setAvatar = async (b64) => {
    if (!db) return
    b64 ? await db.put(KEY.user(_pub).field('avatar'), b64) : await db.del(KEY.user(_pub).field('avatar'))
    _notify()
  }

  // watch — fires on any ~pub/** change (own node for full mode)
  const watch = (fn) => db ? db.on(`~${pub64(_pub)}/**`, fn) : () => {}

  // Init: full mode writes node and subscribes to own changes
  if (mode === 'full' && db) {
    _writeNode().catch(e => { /*DEBUG*/ console.warn('[QuRay:Peer] writeNode failed:', e.message) })
    // Watch for alias changes from relay sync
    db.on(`~${pub64(_pub)}/alias`, (q) => {
      const alias = q?.data ?? q
      if (typeof alias === 'string' && alias !== _alias) {
        _alias = alias; identity.alias = alias; _notify()
      }
    })
  }

  // WebRTC
  const call   = (opts = {}) => { if (!_rtc) throw new Error('no WebRTC'); return _rtc.call(_pub, opts) }
  const hangup = ()          => _rtc?.hangup(_pub)

  const _api = {
    // Identity
    get pub()    { return _pub },
    get epub()   { return _epub },
    get pub64()  { return pub64(_pub) },
    get epub64() { return _epub ? pub64(_epub) : null },
    get mode()   { return mode },
    get nodeKey(){ return KEY.user(_pub).space },  // ~{pub}/ — the sub-key prefix
    // Profile (reactive)
    get alias()  { return _alias },
    get avatar() { return mode === 'full' ? getAvatar() : _avatar },  // remote: plain value, full: Promise<string|null>
    get props()  { return _props },
    get online() { return _online },
    // Setters (full mode only)
    set alias(v) { if (mode === 'full') setAlias(v) },
    set avatar(v){ if (mode === 'full') setAvatar(v) },
    setAlias,
    watch,
    // Crypto
    verify, encrypt, sign, decrypt, backup, exportBackup: backup,
    cryptoKeys: _cryptoKeys,
    // Reactivity
    on: onChange, onChange,
    // WebRTC
    get rtc() { return _rtc }, call, hangup,
    // Internal (PeerMap + sync.js)
    _update, _setOnline, _setRtc, _cryptoKeys,
    // Legacy compat
    get priv()  { return null },  // priv/epriv from exportBackup() if needed
    get epriv() { return null },
  }
  return _api
}


// ═════════════════════════════════════════════════════════════════════════════
// LocalPeer — factory for Peer in 'full' mode.
// Returns a Peer directly — no wrapper, identical API surface.
// ═════════════════════════════════════════════════════════════════════════════

const LocalPeer = async (identity, db) => {
  if (!identity.alias) {
    const q = await db.get('conf/alias').catch(() => null)
    const v = q?.data ?? q
    if (typeof v === 'string' && v) identity.alias = v
  }
  return Peer({ mode: 'full', identity, db })
}


// ═════════════════════════════════════════════════════════════════════════════
// PeerMap — reactive Map<pub64 → Peer(remote)>.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Reactive registry of all known peers. Tracks online status via heartbeat
 * signals and reads profile data (alias, avatar, epub) from QuDB.
 *
 * @param {QuDB} db - Database instance
 * @param {string} [localPub] - Own public key (to exclude from peer list)
 * @returns {PeerMapInstance}
 * @group Peer
 * @since 0.1.0
 *
 * @example
 * const { peers } = await QuRay.init({ ... })
 *
 * peers.all                        // Peer[] — all known peers
 * peers.online                     // Peer[] — currently online
 * peers.get(somePub)               // Peer | undefined
 * const off = peers.onChange(fn)   // reactive — call off() to unsubscribe
 *
 * // Peer fields:
 * peer.pub    // ECDSA public key (base64url)
 * peer.epub   // ECDH encryption key
 * peer.alias  // display name (reactive)
 * peer.online // boolean (reactive)
 */
const PeerMap = (db, localPub = null) => {
  const _map  = new Map()
  const _subs = new Set()
  const _notify = () => _subs.forEach(fn => fn(_api))

  const _getOrCreate = (pub) => {
    if (!pub || pub === localPub) return null
    if (_map.has(pub)) return _map.get(pub)
    const peer = Peer({ mode: 'remote', initialPub: pub, db })
    _map.set(pub, peer)
    peer.onChange(() => _notify())
    return peer
  }

  const _offNode = db.on('**', (val, { key } = {}) => {
    // Filter: only handle ~{pub}/{field} keys (skip @, >, conf/, sys/, blobs/)
    if (!key?.startsWith('~')) return
    const d = val?.data ?? val
    const parts = (key ?? '').slice(1).split('/')
    const pub = parts[0], field = parts[1]
    // Only handle sub-keys: ~{pub}/{field}
    // Root node ~{pub} no longer exists — all data lives in sub-keys
    if (!pub || pub === localPub || !field) return
    const peer = _map.get(pub) ?? _getOrCreate(pub)
    if (!peer || typeof peer._update !== 'function') return
    if (field === 'pub'    && typeof d === 'string') peer._update({ pub: d })
    if (field === 'epub'   && typeof d === 'string') peer._update({ epub: d })
    if (field === 'alias'  && typeof d === 'string') peer._update({ alias: d || null })
    if (field === 'avatar' && (typeof d === 'string' || d === null)) peer._update({ avatar: d || null })
    _notify()
  })

  const _offSys = db.on('sys/peers/**', (val, { key }) => {
    const pub = key.slice('sys/peers/'.length)
    if (!pub || pub === localPub || pub.length < 10) return
    const peer = _getOrCreate(pub)
    if (!peer || typeof peer._update !== 'function') return
    if (val !== null && val !== undefined) {
      // val is a full QuBit — extract data
      const d = val?.data ?? val
      if (d && typeof d === 'object') peer._update({ alias: d.alias, epub: d.epub })
      peer._setOnline(true)
    } else {
      peer._setOnline(false)
    }
    _notify()
  })

  // Heartbeat cleanup: peers that haven't sent hello in 90s → offline
  const _heartbeatCleanup = () => {
    const now = Date.now()
    let changed = false
    _map.forEach((peer, pub) => {
      if (peer.online && peer._lastSeen && (now - peer._lastSeen) > 90_000) {
        peer._setOnline(false)
        // Remove from sys/peers so qu-status reacts
        db._internal.write(KEY.peer(pub), null, 'sync').catch(() => {})
        db._internal.bus?.emit(KEY.peer(pub), null, { event: 'del', key: KEY.peer(pub), source: 'local' }).catch(() => {})
        changed = true
      }
    })
    if (changed) _notify()
  }
  setInterval(_heartbeatCleanup, 30_000)

  const load = async () => {
    // Single pass: all user data lives in sub-keys ~{pub}/{field}
    // Group by pub, then apply fields — pub/epub/alias create the peer
    const rows = await db.query('~')
    for (const q of rows) {
      const parts = (q.key ?? '').slice(1).split('/')
      const pub = parts[0], field = parts[1]
      if (!pub || pub === localPub || !field) continue
      const d = q?.data ?? q
      const peer = _map.get(pub) ?? _getOrCreate(pub)
      if (!peer) continue
      if (typeof peer._update !== 'function') continue
      if (field === 'pub'    && typeof d === 'string') peer._update({ pub: d })
      if (field === 'epub'   && typeof d === 'string') peer._update({ epub: d })
      if (field === 'alias'  && typeof d === 'string') peer._update({ alias: d || null })
      if (field === 'avatar' && (typeof d === 'string' || d === null)) peer._update({ avatar: d || null })
    }
    _notify()
  }

  const clearOnline = () => { _map.forEach(p => p._setOnline(false)); _notify() }
  const onChange    = (fn) => { _subs.add(fn); return () => _subs.delete(fn) }
  const destroy     = () => { _offNode?.(); _offSys?.(); _map.clear(); _subs.clear() }

  Promise.resolve().then(load).catch(() => {})

  const _api = {
    get:        (pub) => _getOrCreate(pub),
    get all()   { return [..._map.values()] },
    get online(){ return [..._map.values()].filter(p => p.online) },
    get count() { return _map.size },
    on: onChange, onChange, clearOnline, load, destroy,
  }
  return _api
}


export { Peer, LocalPeer, PeerMap }
