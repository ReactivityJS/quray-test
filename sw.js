// ════════════════════════════════════════════════════════════════════════════
// QuRay — sw.js  v0.9
// Service Worker: Background Sync · Push → Fetch → App · Blob-Queue
//
// ┌─ Push-Flow (repariert) ────────────────────────────────────────────┐
// │  1. Push empfangen                                                 │
// │  2. Notification SOFORT zeigen (unabhängig von Sync-Erfolg)        │
// │  3. Diff-Sync: GET /api/sync?prefix=P&keysonly=1                   │
// │     → fehlende Keys → POST /api/sync → Rows an App                │
// │  4. sw.syncData an alle App-Tabs                                   │
// │  5. sw.pushReceived an alle Tabs → App startet syncIn()            │
// └────────────────────────────────────────────────────────────────────┘
//
// ┌─ notificationclick (repariert) ────────────────────────────────────┐
// │  Öffnet Tab mit #chat (nicht #db)                                  │
// │  Wartet auf DOMContentLoaded bevor push.click gesendet wird        │
// └────────────────────────────────────────────────────────────────────┘
//
// ┌─ IDB-Stores ───────────────────────────────────────────────────────┐
// │  pending-blobs  — Blob-Download-Queue                              │
// │  pending-msgs   — Offline-Msg-Queue                                │
// │  conf           — Persistente Konfiguration (relayUrl etc.)        │
// └────────────────────────────────────────────────────────────────────┘
// ════════════════════════════════════════════════════════════════════════════

/* global self, clients */
'use strict'

const SW_IDB_NAME     = 'quray-sw-queue'
const SW_IDB_VERSION  = 2                  // v2: conf store hinzugefügt
const STORE_BLOBS     = 'pending-blobs'
const STORE_MSGS      = 'pending-msgs'
const STORE_CONF      = 'conf'             // persistente Konfiguration
const SYNC_TAG_MSGS   = 'quray-sync-msgs'
const SYNC_TAG_BLOBS  = 'quray-sync-blobs'
const PERIODIC_TAG    = 'quray-periodic-sync'
const HTTP_TIMEOUT_MS = 20_000
const DIFF_BATCH_SIZE = 40


// ── Konfiguration ────────────────────────────────────────────────────────────
// Wird via sw.setConfig von der App gesetzt und in IDB persistiert.
let _cfg = {
  relayUrl:         null,
  pub:              null,
  prefixes:         [],    // alle sync-relevanten Prefixes
  periodicSync:     false,
  periodicInterval: 15 * 60 * 1000,
}


// ── IDB ──────────────────────────────────────────────────────────────────────

let _db = null

const _openDb = () => new Promise((resolve, reject) => {
  if (_db) { resolve(_db); return }

  const req = indexedDB.open(SW_IDB_NAME, SW_IDB_VERSION)

  req.onupgradeneeded = ({ target: { result: db }, oldVersion }) => {
    if (!db.objectStoreNames.contains(STORE_BLOBS))
      db.createObjectStore(STORE_BLOBS, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(STORE_MSGS))
      db.createObjectStore(STORE_MSGS, { keyPath: 'id', autoIncrement: true })
    if (!db.objectStoreNames.contains(STORE_CONF))
      db.createObjectStore(STORE_CONF)
  }

  req.onsuccess = ({ target: { result: db } }) => { _db = db; resolve(db) }
  req.onerror   = ({ target: { error } })      => reject(error)
})

const _run = async (store, mode, fn) => {
  const db = await _openDb()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, mode)
    const st  = tx.objectStore(store)
    const req = fn(st)
    if (req && 'onsuccess' in req) {
      req.onsuccess = e => resolve(e.target.result ?? null)
      req.onerror   = e => reject(e.target.error)
    } else {
      tx.oncomplete = () => resolve(null)
      tx.onerror    = e  => reject(e.target.error)
    }
  })
}

const _getAll = async (store) => {
  const db = await _openDb()
  return new Promise((resolve, reject) => {
    const rows = []
    const req  = db.transaction(store, 'readonly').objectStore(store).openCursor()
    req.onsuccess = ({ target: { result: c } }) => {
      if (c) { rows.push(c.value); c.continue() } else resolve(rows)
    }
    req.onerror = ({ target: { error } }) => reject(error)
  })
}

// Konfiguration aus IDB laden (nach SW-Schlaf)
const _loadCfg = async () => {
  try {
    const saved = await _run(STORE_CONF, 'readonly', s => s.get('cfg'))
    if (saved) _cfg = { ..._cfg, ...saved }
  } catch {}
}

// Konfiguration in IDB speichern
const _saveCfg = async () => {
  try { await _run(STORE_CONF, 'readwrite', s => s.put(_cfg, 'cfg')) } catch {}
}


// ── HTTP ─────────────────────────────────────────────────────────────────────

const _fetch = async (url, opts = {}) => {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try   { const r = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(t); return r }
  catch (e) { clearTimeout(t); throw e }
}


// ── Client-Kommunikation ─────────────────────────────────────────────────────

const _broadcast = async (msg) => {
  const all = await clients.matchAll({ type: 'window', includeUncontrolled: false })
  for (const c of all) c.postMessage(msg)
}


// ── DIFF-SYNC ────────────────────────────────────────────────────────────────
// Läuft im SW — holt nur Keys zuerst, dann nur fehlende QuBits.
// Gibt geladene Rows ans App weiter (sw.syncData).

const _diffSyncPrefix = async (prefix, httpBase) => {
  try {
    const keysRes = await _fetch(
      `${httpBase}/api/sync?prefix=${encodeURIComponent(prefix)}&keysonly=1`
    )
    if (!keysRes.ok) return []

    const { rows: relayIndex = [] } = await keysRes.json()
    if (!relayIndex.length) return []

    // Lokale Keys aus App-IDB lesen
    // SW hat Zugriff auf dieselbe IDB wie die App
    const localRows = await _queryAppIdb(prefix)
    const localKeys = new Set(localRows.map(r => r.key))

    const relayKeys = relayIndex.map(r => typeof r === 'string' ? r : (r.key ?? r.k ?? r))
    const missing   = relayKeys.filter(k => k && !localKeys.has(k))
    if (!missing.length) return []

    console.info('[QuRay:SW] diffSync', prefix, missing.length, 'fehlend')

    const loaded = []
    for (let i = 0; i < missing.length; i += DIFF_BATCH_SIZE) {
      try {
        const r = await _fetch(`${httpBase}/api/sync`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ keys: missing.slice(i, i + DIFF_BATCH_SIZE) }),
        })
        if (!r.ok) continue
        const { rows = [] } = await r.json()
        loaded.push(...rows.filter(x => x.val?.type))
      } catch {}
    }

    return loaded

  } catch (e) {
    console.warn('[QuRay:SW] diffSync Fehler:', e.message)
    return []
  }
}

// App-IDB lesen (gleicher IDB-Name wie App — kein eigener Store)
const _queryAppIdb = (prefix) => new Promise((resolve) => {
  // dbName wird von der App via sw.setConfig gesetzt
  const dbName = _cfg.dbName ?? 'quray-' + (_cfg.pub ?? '').slice(0, 12).replace(/[+/=]/g, '_')
  try {
    const req = indexedDB.open(dbName)  // keine Version → öffnet mit aktueller Version
    req.onsuccess = ({ target: { result: db } }) => {
      try {
        const rows = []
        const rng  = IDBKeyRange.bound(prefix, prefix + '\uFFFF')
        const cur  = db.transaction('kv', 'readonly').objectStore('kv').openCursor(rng)
        cur.onsuccess = ({ target: { result: c } }) => {
          if (c) { rows.push({ key: c.key }); c.continue() }
          else   { db.close(); resolve(rows) }
        }
        cur.onerror = () => { db.close(); resolve([]) }
      } catch { db.close(); resolve([]) }
    }
    req.onerror = () => resolve([])
  } catch { resolve([]) }
})

const _performDeltaSync = async () => {
  const httpBase = _cfg.relayUrl
  const prefixes = _cfg.prefixes?.length ? _cfg.prefixes : []
  if (!httpBase || !prefixes.length) return []

  const allRows = []
  for (const prefix of prefixes) {
    const rows = await _diffSyncPrefix(prefix, httpBase)
    allRows.push(...rows)
  }

  if (allRows.length) {
    await _broadcast({ type: 'sw.syncData', rows: allRows })
    // Auch pushReceived senden damit App syncIn() startet
    await _broadcast({ type: 'sw.pushReceived' })
    console.info('[QuRay:SW] Delta-Sync gesamt:', allRows.length)
  }

  return allRows
}


// ── MSG-QUEUE ────────────────────────────────────────────────────────────────

const _flushMsgQueue = async () => {
  const msgs     = await _getAll(STORE_MSGS)
  const httpBase = _cfg.relayUrl
  if (!msgs.length || !httpBase) return

  for (const msg of msgs) {
    try {
      const r = await _fetch(`${httpBase}/api/msg`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(msg.packet),
      })
      if (r.ok) await _run(STORE_MSGS, 'readwrite', s => s.delete(msg.id))
    } catch {}
  }
}


// ── BLOB-QUEUE ───────────────────────────────────────────────────────────────

const _downloadBlob = async (task) => {
  const { id, hash, mime, name, owner, relayUrl } = task
  const httpBase = relayUrl ?? _cfg.relayUrl
  if (!httpBase) return false

  const ownerP = owner ? `?owner=${encodeURIComponent(owner)}` : ''

  try {
    const r = await _fetch(`${httpBase}/api/blob/${encodeURIComponent(hash)}${ownerP}`)
    if (!r.ok) return r.status === 404

    const { b64 } = await r.json()
    if (!b64) return false

    await _broadcast({ type: 'sw.blobReady', hash, b64, mime: mime ?? '', name: name ?? '' })
    await _run(STORE_BLOBS, 'readwrite', s => s.delete(id))
    return true

  } catch { return false }
}

const _flushBlobQueue = async () => {
  const blobs = await _getAll(STORE_BLOBS)
  for (const task of blobs) await _downloadBlob(task)
}


// ── PERIODIC SYNC ────────────────────────────────────────────────────────────

const _registerPeriodic = async () => {
  if (!('periodicSync' in self.registration)) return
  try {
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' })
    if (perm.state !== 'granted') return
    await self.registration.periodicSync.register(PERIODIC_TAG,
      { minInterval: _cfg.periodicInterval })
  } catch {}
}


// ── EVENTS ───────────────────────────────────────────────────────────────────

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await clients.claim()
    await _loadCfg()   // relayUrl nach SW-Schlaf wiederherstellen
  })())
})

self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG_BLOBS) e.waitUntil(_flushBlobQueue())
  if (e.tag === SYNC_TAG_MSGS)  e.waitUntil(_flushMsgQueue())
})

self.addEventListener('periodicsync', e => {
  if (e.tag === PERIODIC_TAG)
    e.waitUntil(Promise.all([_performDeltaSync(), _flushMsgQueue(), _flushBlobQueue()]))
})


// ── PUSH ─────────────────────────────────────────────────────────────────────
// Reihenfolge wichtig:
// 1. relayUrl sicherstellen
// 2. Notification SOFORT zeigen (Browser-Policy: vor erstem await oder kurz danach)
// 3. Diff-Sync im Hintergrund
// 4. App benachrichtigen

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    // Config sicherstellen
    if (!_cfg.relayUrl) await _loadCfg()

    // Push-Daten parsen
    let title = 'QuRay', body = 'Neue Nachricht', tag = 'quray-push', data = {}
    let requireInteraction = false, actions = []
    if (e.data) {
      try {
        data  = JSON.parse(e.data.text())
        title = data.title ?? 'QuRay'
        body  = data.body  ?? (data.alias ? `Nachricht von ${data.alias}` : 'Neue Nachricht')
        tag   = data.tag ?? data.msgId ?? tag
        // Call notifications need requireInteraction so they don't auto-dismiss
        if (data.type === 'call') {
          requireInteraction = true
          actions = [{ action: 'answer', title: '✅ Annehmen' }, { action: 'decline', title: '❌ Ablehnen' }]
        }
      } catch { body = e.data.text() }
    }

    // Notification zeigen wenn App nicht im Vordergrund
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const focused    = allClients.some(c => c.focused && c.visibilityState === 'visible')

    if (!focused) {
      await self.registration.showNotification(title, {
        body, tag,
        icon:    '/favicon.ico',
        badge:   '/favicon.ico',
        data,
        requireInteraction,
        actions: actions.length ? actions : [{ action: 'open', title: 'Öffnen' }],
        vibrate: data.type === 'call' ? [500, 200, 500, 200, 500] : [200, 100, 200],
        renotify: true,
        silent:  false,
      })
    }

    // Diff-Sync + Queue-Flush parallel
    await Promise.all([
      _performDeltaSync(),
      _flushMsgQueue(),
      _flushBlobQueue(),
    ])

  })())
})


// ── NOTIFICATION CLICK ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close()

  e.waitUntil((async () => {
    const data       = e.notification.data ?? {}
    const scope      = self.registration.scope
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const appTabs    = allClients.filter(c => c.url.startsWith(scope))

    if (appTabs.length > 0) {
      // Bestehenden Tab fokussieren — App navigiert selbst via push.click
      const target = appTabs[0]
      try { await target.focus() } catch {}
      // push.click schicken — App macht _switchTab('chat') selbst (kein navigate())
      target.postMessage({ type: 'push.click', data })
    } else {
      // Keinen offenen Tab — neues Fenster ohne Hash öffnen
      // Die App liest push.click und navigiert zu #chat selbst
      const win = await self.clients.openWindow(scope.replace(/\/$/, '') + '/')
      if (win) {
        // Warten bis App-Bootstrap abgeschlossen (boot() ist async)
        await new Promise(r => setTimeout(r, 2200))
        win.postMessage({ type: 'push.click', data })
      }
    }
  })())
})


// ── MESSAGE (App → SW) ───────────────────────────────────────────────────────

self.addEventListener('message', async e => {
  const { type, ...d } = e.data ?? {}

  switch (type) {
    case 'sw.setConfig':
      // d enthält: relayUrl, pub, prefixes, dbName, periodicSync, periodicInterval
      _cfg = { ..._cfg, ...d }
      await _saveCfg()  // persistent speichern für den Fall dass SW schläft
      if (_cfg.periodicSync) await _registerPeriodic()
      console.info('[QuRay:SW] Config:', _cfg.relayUrl, 'prefixes:', _cfg.prefixes?.join(', '))
      break

    case 'sw.queueDownload': {
      const task = {
        id:       d.id ?? crypto.randomUUID(),
        hash:     d.hash,
        mime:     d.mime ?? '',
        name:     d.name ?? '',
        owner:    d.owner ?? null,
        relayUrl: d.relayUrl ?? _cfg.relayUrl,
        ts:       Date.now(),
      }
      await _run(STORE_BLOBS, 'readwrite', s => s.put(task))
      if ('sync' in self.registration) {
        await self.registration.sync.register(SYNC_TAG_BLOBS).catch(_flushBlobQueue)
      } else { _flushBlobQueue() }
      break
    }

    case 'sw.queueMsg': {
      await _run(STORE_MSGS, 'readwrite', s => s.add({ packet: d.packet, ts: Date.now() }))
      if ('sync' in self.registration) {
        await self.registration.sync.register(SYNC_TAG_MSGS).catch(_flushMsgQueue)
      } else { _flushMsgQueue() }
      break
    }

    case 'sw.syncNow':
      await Promise.all([_performDeltaSync(), _flushMsgQueue(), _flushBlobQueue()])
      break

    case 'sw.getStatus':
      e.source?.postMessage({
        type:        'sw.status',
        pendingBlobs: (await _getAll(STORE_BLOBS)).length,
        pendingMsgs:  (await _getAll(STORE_MSGS)).length,
        config:      _cfg,
      })
      break
  }
})


// ── FETCH (App-Shell-Cache) ───────────────────────────────────────────────────

// Handle ?nocache=1 → clear all SW caches + IDB + force reload
async function _handleNocache(e) {
  // Clear all browser caches
  const keys = await caches.keys()
  await Promise.all(keys.map(k => caches.delete(k)))
  // Respond with redirect to same URL without ?nocache param
  const url = new URL(e.request.url)
  url.searchParams.delete('nocache')
  return Response.redirect(url.toString(), 302)
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return

  const url = new URL(e.request.url)

  // ?nocache=1 — force cache clear
  if (url.searchParams.has('nocache')) {
    e.respondWith(_handleNocache(e))
    return
  }

  // /api/ routes — always network, never cache
  if (url.pathname.startsWith('/api/')) return

  // Strip ?v= cache-buster for cache lookup, pass full URL to network
  const cacheKey = new Request(url.origin + url.pathname)

  e.respondWith(
    // Network-first: always try fresh from server
    fetch(e.request).then(async resp => {
      // Cache successful navigation and script responses
      if (resp.ok && ['document','script','style'].includes(e.request.destination)) {
        const cache = await caches.open('quray-app-v1')
        cache.put(cacheKey, resp.clone())
      }
      return resp
    }).catch(async () => {
      // Offline fallback: try cache without ?v= param
      const cached = await caches.match(cacheKey)
      return cached ?? new Response('Offline — cached version not available', {
        status: 503, headers: { 'Content-Type': 'text/plain' }
      })
    })
  )
})
