// ════════════════════════════════════════════════════════════════════════════
// QuRay — backends/memory.js + backends/localstorage.js
// Leichtgewichtige Storage-Backends für sys/ und conf/ Namespaces.
//
// MemoryBackend:
//   In-Memory Map — flüchtig, schnell, kein I/O.
//   Für sys/ Namespace (Peer-Status, WS-Status, WebRTC-Signaling).
//   Überlebt keinen Tab-Reload.
//
// LocalStorageBackend:
//   Browser LocalStorage — persistent, synchron intern, async Interface.
//   Für conf/ Namespace: Identität, Relay-URL, Prefs, Task-Queue.
//   WICHTIG: conf/_tasks hier speichern — überlebt IDB-Timeouts auf Android.
//   Namespace-Prefix verhindert Kollisionen mit anderem App-Code.
//
// Beide implementieren dasselbe Backend-Interface:
//   get(key), set(key, value), del(key), query(prefix)
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// MEMORY BACKEND
// ─────────────────────────────────────────────────────────────────────────────
/**
 * In-memory storage backend. Used for ephemeral data (sys/ prefix) and testing.
 * Data is lost on page refresh or navigation. Zero I/O, ideal for unit tests.
 *
 * @returns {Backend} - { get, set, del, scan }
 * @group Backend
 * @since 0.1.0
 *
 * @example
 * import { QuDB, MemoryBackend } from './dist/quray-core.js'
 * const db = QuDB({ backends: {
 *   '~': MemoryBackend(), '@': MemoryBackend(), '>': MemoryBackend(),
 *   'sys/': MemoryBackend(), 'conf/': MemoryBackend(), 'blobs/': MemoryBackend(),
 * }})
 * await db.init()
 */
const MemoryBackend = () => {
  const _store = new Map()

  const get = (keyString) =>
    Promise.resolve(_store.has(keyString) ? _store.get(keyString) : null)

  const set = (keyString, value) => {
    _store.set(keyString, value)
    return Promise.resolve()
  }

  const del = (keyString) => {
    _store.delete(keyString)
    return Promise.resolve()
  }

  // query: alle Keys mit Prefix, lexikographisch sortiert
  const query = (prefixString) => {
    const matchingEntries = [..._store.entries()]
      .filter(([key]) => {
        if (!prefixString) return true
        if (key === prefixString) return true
        // Single-char sigils (~, @, >) match all keys starting with that char
        if (prefixString.length === 1) return key.startsWith(prefixString)
        // Normalize: ensure prefix ends with '/' for correct prefix-matching
        const p = prefixString.endsWith('/') ? prefixString : prefixString + '/'
        return key.startsWith(p)
      })
      .sort(([keyA], [keyB]) => keyA < keyB ? -1 : keyA > keyB ? 1 : 0)
      .map(([key, val]) => ({ key, val }))
    return Promise.resolve(matchingEntries)
  }

  // clear: alle Einträge löschen (z.B. bei Logout)
  const clear = () => { _store.clear(); return Promise.resolve() }

  return {
    name: 'memory',
    get, set, del, query, clear,
    get size() { return _store.size },
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// LOCALSTORAGE BACKEND
// ─────────────────────────────────────────────────────────────────────────────

// LocalStorage sicher laden — wirft in manchen Browsern/Kontexten (z.B. Private Mode iOS)
const _safeGetLocalStorage = () => {
  try { return window?.localStorage ?? null }
  catch { return null }
}

const LocalStorageBackend = (options = {}) => {
  const _namespacePrefix = options.prefix ?? 'qr_'   // verhindert Kollisionen
  const _storage         = _safeGetLocalStorage()

  // Interner Key = Namespace-Prefix + übergebener Key
  const _internalKey = (keyString) => _namespacePrefix + keyString

  const get = (keyString) => {
    if (!_storage) return Promise.resolve(null)
    try {
      const rawValue = _storage.getItem(_internalKey(keyString))
      return Promise.resolve(rawValue != null ? JSON.parse(rawValue) : null)
    } catch (parseError) {
      /*DEBUG*/ console.warn('[QuRay:LocalStorageBackend] get parse Fehler:', keyString, parseError)
      return Promise.resolve(null)
    }
  }

  const set = (keyString, value) => {
    if (!_storage) return Promise.resolve()
    try {
      _storage.setItem(_internalKey(keyString), JSON.stringify(value))
    } catch (storageError) {
      // QuotaExceededError oder SecurityError
      /*DEBUG*/ console.error('[QuRay:LocalStorageBackend] set Fehler:', keyString, storageError.message)
    }
    return Promise.resolve()
  }

  const del = (keyString) => {
    if (!_storage) return Promise.resolve()
    try { _storage.removeItem(_internalKey(keyString)) }
    catch { /* ignorieren */ }
    return Promise.resolve()
  }

  const query = (prefixString) => {
    if (!_storage) return Promise.resolve([])
    const results        = []
    const fullPrefix     = _internalKey(prefixString ?? '')
    const namespaceLen   = _namespacePrefix.length

    try {
      for (let i = 0; i < _storage.length; i++) {
        const rawKey = _storage.key(i)
        if (!rawKey?.startsWith(_namespacePrefix)) continue

        const appKey = rawKey.slice(namespaceLen)   // Namespace-Prefix abschneiden
        if (prefixString && !appKey.startsWith(prefixString)) continue

        try {
          const parsed = JSON.parse(_storage.getItem(rawKey))
          results.push({ key: appKey, val: parsed })
        } catch { /* einzelne korrupte Einträge überspringen */ }
      }
    } catch (iterateError) {
      /*DEBUG*/ console.warn('[QuRay:LocalStorageBackend] query Fehler:', iterateError)
    }

    // Lexikographisch sortieren (wie IDB-Cursor)
    results.sort((entryA, entryB) =>
      entryA.key < entryB.key ? -1 : entryA.key > entryB.key ? 1 : 0
    )

    return Promise.resolve(results)
  }

  const clear = (prefixString = null) => {
    if (!_storage) return Promise.resolve()
    const keysToDelete = []
    const fullPrefix   = _internalKey(prefixString ?? '')

    for (let i = 0; i < _storage.length; i++) {
      const rawKey = _storage.key(i)
      if (rawKey?.startsWith(fullPrefix)) keysToDelete.push(rawKey)
    }

    keysToDelete.forEach(rawKey => {
      try { _storage.removeItem(rawKey) } catch { /* ignorieren */ }
    })

    /*DEBUG*/ console.debug('[QuRay:LocalStorageBackend] clear:', keysToDelete.length, 'Einträge gelöscht')
    return Promise.resolve()
  }

  // isAvailable: LocalStorage verfügbar und beschreibbar?
  const isAvailable = () => {
    if (!_storage) return false
    try {
      const testKey = _namespacePrefix + '__test__'
      _storage.setItem(testKey, '1')
      _storage.removeItem(testKey)
      return true
    } catch {
      return false
    }
  }

  return {
    name: 'localstorage',
    get, set, del, query, clear,
    isAvailable,
    get prefix() { return _namespacePrefix },
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// SESSION STORAGE BACKEND
// Identisch mit LocalStorage aber flüchtig (Tab-Scope).
// Für temporäre Daten die keinen Sync brauchen.
// ─────────────────────────────────────────────────────────────────────────────
const _safeGetSessionStorage = () => {
  try { return window?.sessionStorage ?? null }
  catch { return null }
}

const SessionStorageBackend = (options = {}) => {
  // SessionStorage nutzt dieselbe Implementierung wie LocalStorage,
  // nur mit anderem Storage-Objekt und Prefix
  const _namespacePrefix = options.prefix ?? 'qrs_'
  const _storage         = _safeGetSessionStorage()

  // Implementierung identisch mit LocalStorage — hier als Delegation
  const _localImpl = LocalStorageBackend({ prefix: _namespacePrefix })

  // Wir ersetzen nur den internen Storage — alle anderen Methoden bleiben gleich.
  // Da LocalStorageBackend window.localStorage nutzt, können wir nicht direkt
  // delegieren. Stattdessen eine minimale eigene Implementierung:
  const _internalKey = (keyString) => _namespacePrefix + keyString

  const get = (keyString) => {
    if (!_storage) return Promise.resolve(null)
    try {
      const rawValue = _storage.getItem(_internalKey(keyString))
      return Promise.resolve(rawValue != null ? JSON.parse(rawValue) : null)
    } catch { return Promise.resolve(null) }
  }

  const set = (keyString, value) => {
    if (!_storage) return Promise.resolve()
    try { _storage.setItem(_internalKey(keyString), JSON.stringify(value)) }
    catch (e) {
      /*DEBUG*/ console.warn('[QuRay:SessionStorageBackend] set Fehler:', e.message)
    }
    return Promise.resolve()
  }

  const del = (keyString) => {
    if (!_storage) return Promise.resolve()
    try { _storage.removeItem(_internalKey(keyString)) } catch { /* ignorieren */ }
    return Promise.resolve()
  }

  const query = (prefixString) => {
    if (!_storage) return Promise.resolve([])
    const results      = []
    const namespaceLen = _namespacePrefix.length
    try {
      for (let i = 0; i < _storage.length; i++) {
        const rawKey = _storage.key(i)
        if (!rawKey?.startsWith(_namespacePrefix)) continue
        const appKey = rawKey.slice(namespaceLen)
        if (prefixString && !appKey.startsWith(prefixString)) continue
        try { results.push({ key: appKey, val: JSON.parse(_storage.getItem(rawKey)) }) }
        catch { /* korrupte Einträge überspringen */ }
      }
    } catch { /* ignorieren */ }
    results.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    return Promise.resolve(results)
  }

  const clear = () => {
    if (!_storage) return Promise.resolve()
    const keysToDelete = []
    for (let i = 0; i < _storage.length; i++) {
      const rawKey = _storage.key(i)
      if (rawKey?.startsWith(_namespacePrefix)) keysToDelete.push(rawKey)
    }
    keysToDelete.forEach(rawKey => { try { _storage.removeItem(rawKey) } catch { /* ignorieren */ } })
    return Promise.resolve()
  }

  return {
    name: 'sessionstorage',
    get, set, del, query, clear,
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export { MemoryBackend, LocalStorageBackend, SessionStorageBackend }
