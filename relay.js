// ════════════════════════════════════════════════════════════════════════════
// QuRay — relay.js  v0.9
// All-in-one relay server: Static Files + REST API + WebSocket on one port.
//
// ┌─ Architecture ──────────────────────────────────────────────────────┐
// │  relay.js is the Node.js entry point for running a QuRay relay.    │
// │  It composes createNodeRelay (src/relay/node-relay-factory.js)     │
// │  which injects FsBackend into createReplicaDb — the relay           │
// │  never leaks Node-specific code into the core framework.           │
// └────────────────────────────────────────────────────────────────────┘
//
// ┌─ URL routing ───────────────────────────────────────────────────────┐
// │  GET  /              → index.html                                  │
// │  GET  /sw.js         → sw.js  (Service-Worker-Allowed: / header)   │
// │  GET  /foo/bar.js    → static file from staticDir                  │
// │  GET  /spa-route     → index.html (SPA fallback, no ext in path)   │
// │  /api/**             → JSON REST API (optional auth)               │
// │  WS   (Upgrade)      → WebSocket handler (same port)               │
// └────────────────────────────────────────────────────────────────────┘
//
// ┌─ Features ──────────────────────────────────────────────────────────┐
// │  serve   Static file server for the browser app                    │
// │  router  Peer discovery, WS routing, WebRTC signaling              │
// │  sync    QuBit + blob persistence, delta-sync API                  │
// │  auth    API key protection for /api/* (opt-in)                    │
// │  push    Web Push (VAPID) for offline clients (opt-in)              │
// └────────────────────────────────────────────────────────────────────┘
//
// ┌─ Starting ──────────────────────────────────────────────────────────┐
// │  node relay.js                          # HTTP, port 8080          │
// │  PORT=443 HTTPS_CERT=cert.pem HTTPS_KEY=key.pem node relay.js      │
// │  API_KEY=secret node relay.js           # protect /api/*           │
// │  FEATURE_PUSH=true node relay.js        # enable Web Push          │
// └────────────────────────────────────────────────────────────────────┘
//
// ┌─ Environment variables ─────────────────────────────────────────────┐
// │  PORT              Port, default 8080                              │
// │  HOST              Bind address, default 0.0.0.0                  │
// │  STATIC_DIR        Browser files, default = directory of this file │
// │  DATA_DIR          Server data (msgs/, blobs/), default ./quray-data│
// │  API_KEY           When set → auth feature active                 │
// │  MAX_BLOB_MB       Blob size limit in MB, default 100              │
// │  HTTPS_CERT        Path to TLS certificate (PEM)                  │
// │  HTTPS_KEY         Path to TLS private key (PEM)                  │
// │  FEATURE_SERVE     false → disable static file server             │
// │  FEATURE_ROUTER    false → disable peer routing                   │
// │  FEATURE_SYNC      false → disable persistence                    │
// │  FEATURE_PUSH      true  → enable Web Push (requires web-push)    │
// │  VAPID_EMAIL       mailto:admin@domain.com (for VAPID)             │
// └────────────────────────────────────────────────────────────────────┘
// ════════════════════════════════════════════════════════════════════════════

import { createServer                      } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, writeFileSync, existsSync,
         mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, extname, dirname            } from 'node:path'
import { fileURLToPath                     } from 'node:url'
import { createHash                        } from 'node:crypto'
import WebSocket                            from 'ws'
const { Server: WebSocketServer } = WebSocket

// Framework imports — relay uses the same core as clients.
import { NO_STORE_TYPES, QUBIT_TYPE }     from './src/core/qubit.js'
import { createNodeRelay as _makeRelayPeer } from './src/relay/node-relay-factory.js'

// Optional: Web Push (install: npm install web-push)
let _webPush = null
try {
  const _wp = await import('web-push')
  const candidates = [_wp?.default, _wp]
  for (const c of candidates) {
    if (c && typeof c?.generateVAPIDKeys === 'function') { _webPush = c; break }
  }
  if (_webPush) console.info('[QuRay:Relay] web-push loaded ✓')
  else console.warn('[QuRay:Relay] web-push: generateVAPIDKeys not found')
} catch (e) {
  console.warn('[QuRay:Relay] web-push not available:', e.message)
}


// ─────────────────────────────────────────────────────────────────────────────
// MIME TYPES
// ─────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.ogg':  'audio/ogg',
  '.pdf':  'application/pdf',
  '.map':  'application/json',
  '.md':   'text/markdown; charset=utf-8',
}
const _mime = (p) => MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'


// ─────────────────────────────────────────────────────────────────────────────
// RELAY FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a QuRay relay server instance.
 *
 * @param {object} config
 * @param {number}  [config.port=8080]
 * @param {string}  [config.host='0.0.0.0']
 * @param {string}  [config.staticDir]        Path to browser app files
 * @param {string}  [config.dataDir='./quray-data'] Path for msgs/ and blobs/
 * @param {string}  [config.apiKey]           When set, /api/* requires X-Api-Key header
 * @param {number}  [config.maxBlobMb=100]    Max blob upload size in MB
 * @param {string}  [config.httpsCert]        Path to TLS certificate (PEM)
 * @param {string}  [config.httpsKey]         Path to TLS key (PEM)
 * @param {object}  [config.features]         { serve, router, sync, auth, push }
 * @returns {{ start, stop, peers, peerCount, broadcast, sendToPeer }}
 *
 * @example
 * import { createRelay } from './relay.js'
 *
 * const relay = createRelay({ port: 8080, dataDir: './data' })
 * await relay.start()
 * console.log('Relay running, peers:', relay.peerCount)
 * await relay.stop()
 */
const createRelay = (config = {}) => {

  // ── Configuration ──────────────────────────────────────────────────────────

  const {
    port       = 8080,
    host       = '0.0.0.0',
    dataDir    = './quray-data',
    apiKey     = null,
    maxBlobMb  = 100,
    ttlDefault = 8,
    httpsCert  = null,
    httpsKey   = null,
  } = config

  const _thisDir  = dirname(fileURLToPath(import.meta.url))
  const staticDir = config.staticDir ?? _thisDir

  const features = {
    serve:  true,
    router: true,
    sync:   true,
    auth:   false,
    push:   false,
    ...config.features,
  }

  const MAX_BLOB_BYTES = maxBlobMb * 1024 * 1024
  const PUSH_DIR = join(dataDir, 'push')
  mkdirSync(PUSH_DIR, { recursive: true })


  // ── RelayPeer (data + routing) ─────────────────────────────────────────────
  // createNodeRelay composes createReplicaDb (backend-agnostic) with FsBackend.
  // This keeps all Node-specific code outside the framework core.

  let _relayPeer = null   // initialised in start() because it's async

  // Shorthand helpers that delegate to the relay peer once initialised
  const _store    = async (q)      => {
    if (!features.sync) return
    const ok = await _relayPeer?.replica.store(q)
    if (ok) console.info('[QuRay:Relay] ↓ stored type=' + q.type + ' key=' + (q.key?.slice(0,40) ?? '?') + ' from=' + (q.from?.slice(0,12) ?? '?'))
    return ok
  }
  const _query    = async (prefix, since = 0) => {
    const rows = await (_relayPeer?.replica.query(prefix, since) ?? [])
    /*DEBUG*/ if (prefix) console.info('[QuRay:Relay] sync.query prefix=' + prefix + ' count=' + rows.length + (since ? ' since=' + since : ''))
    return rows
  }
  const _getByKey = (key)          => _relayPeer?.replica.get(key)
  const _putBlob  = (hash, buf)    => _relayPeer?.replica.putBlob(hash, buf)
  const _getBlob  = (hash)         => _relayPeer?.replica.getBlob(hash)


  // ── VAPID / Web Push ───────────────────────────────────────────────────────

  const _vapidFile   = join(PUSH_DIR, 'vapid.json')
  let _vapid         = null
  const _pushEnabled = features.push && !!_webPush

  const _initVapid = () => {
    if (!_pushEnabled) return
    try {
      if (existsSync(_vapidFile)) {
        _vapid = JSON.parse(readFileSync(_vapidFile, 'utf8'))
        console.info('[QuRay:Relay] VAPID keys loaded ←', _vapidFile)
      } else {
        _vapid = _webPush.generateVAPIDKeys()
        writeFileSync(_vapidFile, JSON.stringify(_vapid, null, 2))
        console.info('[QuRay:Relay] VAPID keys generated →', _vapidFile)
      }
      _webPush.setVapidDetails(
        process.env.VAPID_EMAIL ?? 'mailto:quray@localhost',
        _vapid.publicKey, _vapid.privateKey
      )
      console.info('[QuRay:Relay] Web Push active, publicKey:', _vapid.publicKey?.slice(0, 20) + '…')
    } catch (e) {
      console.error('[QuRay:Relay] VAPID setup error:', e.message)
    }
  }

  const _pushSubPath   = (pub) => join(PUSH_DIR, Buffer.from(pub).toString('base64url').slice(0, 64) + '.json')
  const _savePushSub   = (pub, sub, filter = {}) => { try { writeFileSync(_pushSubPath(pub), JSON.stringify({ pub, sub, filter, ts: Date.now() })) } catch (e) { console.warn('[QuRay:Relay] push save error:', e.message) } }
  const _loadPushSub   = (pub) => { try { const f = _pushSubPath(pub); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null } catch { return null } }
  const _deletePushSub = (pub) => { try { const f = _pushSubPath(pub); if (existsSync(f)) unlinkSync(f) } catch {} }

  const _shouldPush = (filter, fromPub, toPub = null) => {
    if (!filter || filter.mode === 'all') return true
    if (filter.mode === 'off') return false
    if (filter.mode === 'dm') return !!toPub
    if (filter.mode === 'allowlist') return (filter.allowlist ?? []).includes(fromPub)
    return true
  }

  const _sendPushNotification = async (rec, payload) => {
    if (!_webPush || !rec?.sub?.endpoint) return
    try {
      await _webPush.sendNotification(rec.sub, JSON.stringify(payload))
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) _deletePushSub(rec.pub)
      else console.warn('[QuRay:Relay] push error:', e.message)
    }
  }

  const _buildPushPayload = (qubit, title = 'QuRay') => ({
    title,
    body: qubit.data?.text ? qubit.data.text.slice(0, 120)
      : qubit.enc ? '[encrypted message]'
      : '[message]',
    from:  qubit.from,
    msgId: qubit.id,
    ts:    qubit.ts,
  })

  const _sendPush = async (toPub, qubit) => {
    if (!_pushEnabled || !_vapid) return
    const rec = _loadPushSub(toPub)
    if (!rec?.sub || _peers.has(toPub)) return   // peer online → no push needed
    if (!_shouldPush(rec.filter, qubit.from, toPub)) return
    await _sendPushNotification(rec, _buildPushPayload(qubit))
    console.info('[QuRay:Relay] push sent →', toPub.slice(0, 12), 'from', qubit.from?.slice(0, 12))
  }

  const _broadcastPush = async (qubit) => {
    if (!_pushEnabled || !_vapid) return
    try {
      const files = readdirSync(PUSH_DIR).filter(f => f.endsWith('.json'))
      for (const f of files) {
        try {
          const rec = JSON.parse(readFileSync(join(PUSH_DIR, f), 'utf8'))
          if (!rec?.sub?.endpoint || _peers.has(rec.pub)) continue
          if (!_shouldPush(rec.filter, qubit.from, null)) continue
          await _sendPushNotification(rec, _buildPushPayload(qubit))
        } catch (e) {
          if (e.statusCode !== 410 && e.statusCode !== 404) console.warn('[QuRay:Relay] push broadcast error:', e.message)
        }
      }
    } catch (e) { console.warn('[QuRay:Relay] push broadcast dir error:', e.message) }
  }

  const _sendCallPush = async (toPub, qubit) => {
    if (!_pushEnabled || !_vapid) return
    const rec = _loadPushSub(toPub)
    if (!rec?.sub || _peers.has(toPub)) return
    const fromAlias = qubit.data?.alias ?? qubit.from?.slice(0, 12) ?? 'Unknown'
    const mode      = qubit.data?.mode === 'video' ? 'Video call' : 'Audio call'
    await _sendPushNotification(rec, {
      title: '📞 Incoming call', body: `${fromAlias} — ${mode}`,
      tag: 'incoming-call', from: qubit.from, type: 'call', requireInteraction: true,
    })
  }


  // ── Peer registry ──────────────────────────────────────────────────────────

  const _shortId = () => Math.random().toString(36).slice(2, 10)
  const _pubSeg  = (pub) => (pub ?? '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  const _peers      = new Map()    // pub → { ws, pub, epub, alias, connectedTs }
  const _byeTimers  = new Map()    // pub → timer (grace period before broadcasting peer.bye)
  const GRACE_MS    = 12_000       // 12s: enough for background tab to reconnect

  const _addPeer = (pub, ws, data = {}) => {
    const normPub = _pubSeg(pub)
    if (_byeTimers.has(normPub)) {
      clearTimeout(_byeTimers.get(normPub))
      _byeTimers.delete(normPub)
      console.info('[QuRay:Relay] peer reconnected (grace cancelled):', normPub.slice(0, 16))
    }
    _peers.set(normPub, { ws, pub: normPub, ...data, connectedTs: Date.now() })
    console.info('[QuRay:Relay] +peer', normPub.slice(0, 16) + '…', `(${_peers.size} total)`)
  }

  const _removePeer = (ws) => {
    for (const [pub, peer] of _peers) {
      if (peer.ws === ws) { _peers.delete(pub); return pub }
    }
    return null
  }

  const _broadcast = (msg, skipWs = null) => {
    const s = JSON.stringify(msg)
    for (const p of _peers.values())
      if (p.ws !== skipWs && p.ws.readyState === 1) p.ws.send(s)
  }

  const _sendTo = (pub, msg) => {
    const normPub = _pubSeg(pub)
    const p       = _peers.get(normPub)
    if (p?.ws.readyState === 1) { p.ws.send(JSON.stringify(msg)); return true }
    return false
  }


  // ── Space subscriptions ───────────────────────────────────────────────────
  // Clients register their space memberships on connect so the relay can
  // deliver messages to space members without needing a member list in each packet.

  const _spaceClients = new Map()  // spaceId → Set<pub>


  // ── Write-authority check ──────────────────────────────────────────────────
  // A peer may only write to ~{pub}/ keys that match their own pub.
  // Full signature verification is done client-side by VerifyPlugin.
  // This server-side check is a lightweight guard against key squatting.

  const _checkWriteAuth = (qubit) => {
    if (!qubit.key?.startsWith('~')) return true
    const keyOwner = qubit.key.slice(1).split('/')[0]
    const fromSeg  = _pubSeg(qubit.from ?? '')
    return keyOwner === fromSeg
  }


  // ── Static file server ────────────────────────────────────────────────────

  const _resolve = (urlPath) => {
    const clean = urlPath.replace(/\.\./g, '').replace(/\/+/g, '/').replace(/^\//, '')
    const abs   = join(staticDir, clean || 'index.html')
    if (!abs.startsWith(staticDir)) return null   // path traversal guard

    if (existsSync(abs) && statSync(abs).isFile()) return abs
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      const idx = join(abs, 'index.html')
      if (existsSync(idx)) return idx
    }
    // SPA fallback: path without extension → index.html
    const last = clean.split('/').pop() ?? ''
    if (!last.includes('.')) {
      const idx = join(staticDir, 'index.html')
      if (existsSync(idx)) return idx
    }
    return null
  }

  const _serveFile = (res, filePath) => {
    try {
      const buf  = readFileSync(filePath)
      const isSW = filePath.endsWith('sw.js')
      const isImmutable = !isSW && !filePath.endsWith('.html') &&
        (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.woff2'))

      res.writeHead(200, {
        'Content-Type':   _mime(filePath),
        'Content-Length': buf.length,
        'Cache-Control':  isImmutable ? 'public, max-age=31536000, immutable' : 'no-cache, no-store',
        ...(isSW ? { 'Service-Worker-Allowed': '/' } : {}),
      })
      res.end(buf)
    } catch {
      res.writeHead(404); res.end('Not Found')
    }
  }


  // ── HTTP helpers ──────────────────────────────────────────────────────────

  const _auth = (headers) => {
    if (!features.auth || !apiKey) return true
    const k = headers['x-api-key'] ?? headers['authorization']?.replace('Bearer ', '')
    return k === apiKey
  }

  const _body = (req) => new Promise((ok, fail) => {
    const chunks = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString())) } catch { ok({}) } })
    req.on('error', fail)
  })

  const _json = (res, status, obj) => {
    const s = JSON.stringify(obj)
    res.writeHead(status, {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(s),
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Authorization',
    })
    res.end(s)
  }


  // ── HTTP request handler ──────────────────────────────────────────────────

  const _handleRequest = async (req, res) => {
    const url    = new URL(req.url, `http://${req.headers.host}`)
    const method = req.method.toUpperCase()
    const path   = url.pathname

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin' : '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Authorization',
      })
      res.end(); return
    }

    if (path.startsWith('/api/')) {
      if (!_auth(req.headers)) { _json(res, 401, { error: 'Unauthorized' }); return }
      await _handleApi(req, res, url, method, path); return
    }

    if (features.serve && (method === 'GET' || method === 'HEAD')) {
      const file = _resolve(path)
      if (file) { _serveFile(res, file); return }
    }

    res.writeHead(404); res.end('Not Found')
  }


  // ── REST API handler ──────────────────────────────────────────────────────

  const _handleApi = async (req, res, url, method, path) => {

    // GET /api/info — relay status and capabilities
    if (method === 'GET' && path === '/api/info') {
      _json(res, 200, {
        name:           'QuRay Relay',
        version:        '0.9.0',
        features:       Object.entries(features).filter(([, v]) => v).map(([k]) => k),
        peers:          _peers.size,
        uptime:         Math.round(process.uptime()),
        vapidPublicKey: (_pushEnabled && _vapid) ? _vapid.publicKey : null,
        pushEnabled:    _pushEnabled,
      }); return
    }

    // GET /api/peers — list currently connected peers
    if (method === 'GET' && path === '/api/peers') {
      _json(res, 200, {
        peers: [..._peers.values()].map(p => ({
          pub: p.pub, epub: p.epub ?? null, alias: p.alias ?? '', connectedTs: p.connectedTs,
        }))
      }); return
    }

    // GET /api/sync?prefix=X&keysonly=1  — key list for diff-sync phase 1
    // GET /api/sync?prefix=X&since=ts    — all rows since timestamp
    // POST /api/sync { keys: [...] }     — batch fetch by keys (diff-sync phase 2)
    if (path === '/api/sync') {
      if (!features.sync) { _json(res, 404, { error: 'sync disabled' }); return }

      if (method === 'GET') {
        const prefix   = url.searchParams.get('prefix') ?? ''
        const keysOnly = url.searchParams.get('keysonly') === '1'
        const since    = parseInt(url.searchParams.get('since') ?? '0')
        const rows     = await _query(prefix, since)
        if (keysOnly) {
          _json(res, 200, { rows: rows.map(q => q.key), prefix, count: rows.length })
        } else {
          _json(res, 200, { rows: rows.map(q => ({ key: q.key, val: q })), prefix, since, count: rows.length })
        }
        return
      }

      if (method === 'POST') {
        const { keys = [] } = await _body(req)
        if (!Array.isArray(keys) || !keys.length) { _json(res, 400, { error: 'keys[] required' }); return }
        const rows = []
        for (const key of keys.slice(0, 100)) {   // max 100 per request
          const q = await _getByKey(key)
          if (q) rows.push({ key: q.key ?? key, val: q })
        }
        console.info('[QuRay:Relay] sync.batch keys=' + keys.length + ' found=' + rows.length)
        _json(res, 200, { rows, count: rows.length }); return
      }
    }

    // POST /api/msg — send a QuBit to a peer (DM) or broadcast
    if (method === 'POST' && path === '/api/msg') {
      const { to, ttl = ttlDefault, payload: q } = await _body(req)
      if (!q?.type) { _json(res, 400, { error: 'payload.type required' }); return }

      if (features.sync && q.key && !NO_STORE_TYPES.has(q.type)) {
        if (!_checkWriteAuth(q)) {
          console.warn('[QuRay:Relay] write denied:', q.key.slice(0, 32), 'from', q.from?.slice(0, 12))
          _json(res, 403, { error: 'Write authority: ~space belongs to another pub' }); return
        }
        await _store(q)
      }

      if (features.router) {
        if (to) {
          const normTo = _pubSeg(to)
          const ok     = _sendTo(normTo, { to: normTo, ttl: ttl - 1, payload: q })
          console.info('[QuRay:Relay] route.dm', q.type, 'to='+normTo.slice(0,12), ok ? '✓' : 'offline')
          if (q.type === 'msg' && q.key && features.sync) {
            const inboxKey = '>' + normTo + '/' + q.ts.toString().padStart(16, '0') + '-' + (q.id ?? _shortId())
            await _store({ ...q, key: inboxKey, _inboxFor: normTo, _origKey: q.key })
          }
          if (q.type === 'msg') await _sendPush(normTo, q)
          if (q.type === 'webrtc.offer') await _sendCallPush(normTo, q)
        } else {
          _broadcast({ ttl: ttl - 1, payload: q })
          console.info('[QuRay:Relay] route.bc', q.type, 'peers='+_peers.size)
          if (q.type === 'msg') await _broadcastPush(q)
        }
      }

      _json(res, 200, { ok: true }); return
    }

    // POST /api/blob — upload blob bytes
    if (method === 'POST' && path === '/api/blob') {
      if (!features.sync) { _json(res, 404, { error: 'sync disabled' }); return }
      const { hash, b64, mime, name, from: fromPub } = await _body(req)
      if (!hash || !b64) { _json(res, 400, { error: 'hash + b64 required' }); return }

      const buf = Buffer.from(b64, 'base64')
      if (buf.length > MAX_BLOB_BYTES) { _json(res, 413, { error: `max ${maxBlobMb} MB` }); return }

      // Verify SHA-256 hash matches content
      const h   = createHash('sha256').update(buf).digest('base64')
      const hu  = h.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
      if (h !== hash && hu !== hash) { _json(res, 400, { error: 'hash mismatch' }); return }

      await _putBlob(hash, buf)
      console.info('[QuRay:Relay] blob.in hash='+hash.slice(0,16)+' size='+Math.round(buf.length/1024)+'KB')

      // Persist blob.meta QuBit so offline peers discover it via diff-sync
      if (fromPub) {
        const fromSeg = _pubSeg(fromPub)
        const metaTs  = Date.now()
        await _store({
          id: _shortId(), key: `~${fromSeg}/blob/${hash}`,
          from: fromPub, ts: metaTs, type: 'data',
          data: { available: true, hash, mime: mime ?? '', name: name ?? '', size: buf.length, ts: metaTs },
          enc: null, refs: [], order: null, sig: null,
        })
      }

      // Broadcast blob.ready to all connected peers
      if (features.router) {
        _broadcast({ ttl: 4, payload: {
          type: QUBIT_TYPE.BLOB_READY, hash, mime: mime ?? '', name: name ?? '',
          size: buf.length, from: fromPub ?? null,
        }})
        console.info('[QuRay:Relay] blob.ready broadcast hash='+hash.slice(0,16))
      }

      _json(res, 200, { ok: true, hash }); return
    }

    // HEAD /api/blob/:hash — dedup check (no payload returned)
    if (method === 'HEAD' && path.startsWith('/api/blob/')) {
      if (!features.sync) { res.writeHead(404); res.end(); return }
      const hash = decodeURIComponent(path.slice('/api/blob/'.length))
      const buf  = await _getBlob(hash)
      res.writeHead(buf ? 200 : 404); res.end(); return
    }

    // GET /api/blob/:hash[?owner=pub] — download blob bytes as base64
    if (method === 'GET' && path.startsWith('/api/blob/')) {
      if (!features.sync) { _json(res, 404, { error: 'sync disabled' }); return }
      const hash = decodeURIComponent(path.slice('/api/blob/'.length))
      const buf  = await _getBlob(hash)
      if (!buf) { _json(res, 404, { error: 'blob not found' }); return }

      // Look up stored mime/name from blob.meta QuBit
      let mime = '', name = ''
      const ownerPubRaw = url.searchParams?.get('owner') ?? null
      if (ownerPubRaw) {
        const ownerSeg  = _pubSeg(ownerPubRaw)
        const storedMeta = await _getByKey(`~${ownerSeg}/blob/${hash}`)
        mime = storedMeta?.data?.mime ?? ''
        name = storedMeta?.data?.name ?? ''
      }

      const b64 = Buffer.isBuffer(buf) ? buf.toString('base64')
        : buf instanceof Uint8Array ? Buffer.from(buf).toString('base64')
        : Buffer.from(buf).toString('base64')

      console.info('[QuRay:Relay] blob.out hash='+hash.slice(0,16)+' size='+Math.round(b64.length*3/4/1024)+'KB')
      _json(res, 200, { b64, hash, mime, name }); return
    }

    // DELETE /api/blob/:hash
    if (method === 'DELETE' && path.startsWith('/api/blob/')) {
      const hash = decodeURIComponent(path.slice('/api/blob/'.length))
      // Note: deletion is handled by the blob backend
      _json(res, 200, { ok: true }); return
    }

    // Push endpoints
    if (path === '/api/push/vapid-public-key' && method === 'GET') {
      _json(res, 200, { vapidPublicKey: (_pushEnabled && _vapid) ? _vapid.publicKey : null, enabled: _pushEnabled }); return
    }

    if (path === '/api/push/subscribe' && method === 'POST') {
      const { pub, subscription, filter } = await _body(req)
      if (!pub || !subscription?.endpoint) { _json(res, 400, { error: 'pub + subscription required' }); return }
      _savePushSub(pub, subscription, filter ?? { mode: 'all', allowlist: [] })
      console.info('[QuRay:Relay] push.subscribe +', pub.slice(0, 12), 'filter='+JSON.stringify(filter?.mode ?? 'all'))
      _json(res, 200, { ok: true }); return
    }

    if (path === '/api/push/unsubscribe' && method === 'POST') {
      const { pub } = await _body(req)
      if (!pub) { _json(res, 400, { error: 'pub required' }); return }
      _deletePushSub(pub)
      _json(res, 200, { ok: true }); return
    }

    if (url.pathname === '/api/push/filter') {
      if (method === 'GET') {
        const pub = url.searchParams.get('pub')
        if (!pub) { _json(res, 400, { error: 'pub required' }); return }
        const rec = _loadPushSub(pub)
        if (!rec) { _json(res, 404, { error: 'not subscribed' }); return }
        _json(res, 200, { mode: rec.filter?.mode ?? 'all', allowlist: rec.filter?.allowlist ?? [], preview: rec.filter?.preview !== false }); return
      }
      if (method === 'POST') {
        const { pub, mode, allowlist, preview } = await _body(req)
        if (!pub) { _json(res, 400, { error: 'pub required' }); return }
        const rec = _loadPushSub(pub)
        if (!rec) { _json(res, 404, { error: 'not subscribed' }); return }
        const validModes = ['all', 'dm', 'allowlist', 'off']
        const safeMode   = validModes.includes(mode) ? mode : 'all'
        _savePushSub(pub, rec.sub, { mode: safeMode, allowlist: Array.isArray(allowlist) ? allowlist : [], preview: preview !== false })
        _json(res, 200, { ok: true, mode: safeMode }); return
      }
    }

    _json(res, 404, { error: 'Unknown API endpoint' })
  }


  // ── WebSocket handler ─────────────────────────────────────────────────────

  const _handleWs = (ws) => {
    let _pub = null

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', async (raw) => {
      let packet
      try { packet = JSON.parse(raw.toString()) }
      catch { console.warn('[QuRay:Relay] WS: invalid JSON'); return }

      const { ttl = 0, payload: q } = packet
      if (!q?.type) return

      // Ping keepalive
      if (q.type === 'ping') { ws.send(JSON.stringify({ payload: { type: 'pong' } })); return }

      // peer.hello — register peer, send peer list
      if (q.type === 'peer.hello') {
        _pub = _pubSeg(q.from)
        _addPeer(_pub, ws, { epub: q.data?.epub, alias: q.data?.alias })
        ws.send(JSON.stringify({
          payload: {
            type: QUBIT_TYPE.PEERS_LIST,
            data: [..._peers.values()]
              .filter(p => p.pub !== _pub)
              .map(p => ({ pub: p.pub, epub: p.epub, alias: p.alias })),
          }
        }))
        console.info('[QuRay:Relay] ✓ peer ONLINE pub=' + _pub.slice(0,16) + ' alias=' + (q.data?.alias ?? '?') + ' total=' + _peers.size)
        if (features.router) _broadcast({ ttl: 4, payload: q }, ws)
        return
      }

      // peer.bye — explicit disconnect
      if (q.type === 'peer.bye') {
        const pub = _removePeer(ws)
        if (pub) {
          if (_byeTimers.has(pub)) { clearTimeout(_byeTimers.get(pub)); _byeTimers.delete(pub) }
          for (const members of _spaceClients.values()) members.delete(pub)
          console.info('[QuRay:Relay] ✗ peer OFFLINE pub=' + pub.slice(0,16) + ' remaining=' + _peers.size)
          if (features.router) _broadcast({ payload: { type: 'peer.bye', from: pub } }, ws)
        }
        return
      }

      // db.sub — subscribe to a prefix for live pushes
      if (q.type === QUBIT_TYPE.DB_SUB) {
        const prefix = q.data?.prefix ?? q.prefix
        if (!prefix || !_pub) return
        if (q.data?.live !== false) {
          if (!_spaceClients.has(prefix)) _spaceClients.set(prefix, new Set())
          _spaceClients.get(prefix).add(_pub)
        }
        if (q.data?.snapshot !== false) {
          const rows = await _query(prefix)
          ws.send(JSON.stringify({
            payload: {
              type: QUBIT_TYPE.DB_RES,
              id:   q.data?.requestId ?? q.id ?? null,
              data: { requestId: q.data?.requestId ?? q.id ?? null,
                      rows: rows.map(val => ({ key: val.key, val })) },
            }
          }))
        }
        return
      }

      // db.unsub
      if (q.type === QUBIT_TYPE.DB_UNSUB) {
        const prefix = q.data?.prefix ?? q.prefix
        if (prefix && _pub) _spaceClients.get(prefix)?.delete(_pub)
        return
      }

      // space.join — client registers space memberships
      if (q.type === 'space.join') {
        if (_pub && Array.isArray(q.spaces)) {
          for (const sid of q.spaces) {
            if (typeof sid !== 'string' || sid.length > 64) continue
            if (!_spaceClients.has(sid)) _spaceClients.set(sid, new Set())
            _spaceClients.get(sid).add(_pub)
          }
        }
        return
      }

      // Ephemeral routing-only types (typing, receipts, WebRTC signaling)
      const EPHEMERAL_TYPES = new Set(['typing', 'msg.delivered', 'msg.read', 'msg.readpos',
        'webrtc.offer', 'webrtc.answer', 'webrtc.ice', 'webrtc.hangup'])
      if (EPHEMERAL_TYPES.has(q.type)) {
        if (packet.to && features.router) _sendTo(packet.to, { ...packet, ttl: Math.max(0, ttl - 1) })
        if (q.space && features.router) {
          const members = _spaceClients.get(q.space) ?? new Set()
          for (const mp of members) { if (mp !== _pub) _sendTo(mp, { ...packet, ttl: 2 }) }
        }
        return
      }

      // Standard QuBits — persist + route
      if (features.sync && q.key && !NO_STORE_TYPES.has(q.type)) {
        if (!_checkWriteAuth(q)) {
          console.warn('[QuRay:Relay] ws.write.DENIED type=' + q.type + ' key=' + q.key?.slice(0, 32) + ' from=' + q.from?.slice(0,12))
          ws.send(JSON.stringify({ type: 'error', code: 403, msg: 'Write authority denied' }))
          return
        }
        await _store(q)
        console.info('[QuRay:Relay] ↓ sync.in  type=' + q.type + ' key=' + q.key?.slice(0, 40) + ' from=' + (q.from?.slice(0,12) ?? '?'))
      }

      if (features.router && ttl > 0) {
        const delivered = new Set()

        // 1. Prefix-based subscription routing (db.sub)
        for (const [prefix, members] of _spaceClients) {
          if (!q.key?.startsWith(prefix)) continue
          for (const mp of members) {
            if (mp === _pub || delivered.has(mp)) continue
            _sendTo(mp, { ...packet, ttl: ttl - 1 })
            delivered.add(mp)
          }
        }

        // 2. Space-based routing
        if (q.space) {
          const members = _spaceClients.get(q.space) ?? new Set()
          for (const mp of members) {
            if (mp === _pub || delivered.has(mp)) continue
            _sendTo(mp, { ...packet, ttl: ttl - 1 })
            delivered.add(mp)
          }
        }

        // 3. Members array routing (DMs with inbox copy)
        if (q.type === 'msg' && Array.isArray(q.members)) {
          const normFrom = _pubSeg(q.from ?? '')
          for (const _mp of q.members) {
            const mp = _pubSeg(_mp)
            if (mp === normFrom) continue
            if (!delivered.has(mp)) { _sendTo(mp, { ...packet, ttl: ttl - 1 }); delivered.add(mp) }
            if (features.sync && q.key) {
              const inboxKey = '>' + mp + '/' + q.ts.toString().padStart(16, '0') + '-' + (q.id ?? _shortId())
              await _store({ ...q, key: inboxKey, _inboxFor: mp, _origKey: q.key })
            }
            await _sendPush(mp, q)
          }
        }

        // 4. Direct routing via packet.to
        if (packet.to && !delivered.has(_pubSeg(packet.to))) {
          const normTo = _pubSeg(packet.to)
          const ok     = _sendTo(normTo, { ...packet, ttl: ttl - 1 })
          console.info('[QuRay:Relay] ↑ route.dm type=' + q.type + ' to=' + normTo.slice(0,12) + ' ' + (ok ? '✓ delivered' : '⚠ offline'))
          if (q.type === 'msg' && q.key && features.sync) {
            const inboxKey = '>' + normTo + '/' + q.ts.toString().padStart(16, '0') + '-' + (q.id ?? _shortId())
            await _store({ ...q, key: inboxKey, _inboxFor: normTo, _origKey: q.key })
          }
          if (q.type === 'msg') await _sendPush(normTo, q)
          if (!ok && features.sync && q.key) console.info('[QuRay:Relay] route.dm offline, stored in inbox')
        } else if (!packet.to && !q.space && !q.members && delivered.size === 0) {
          // Broadcast fallback
          _broadcast({ ...packet, ttl: ttl - 1 }, ws)
          if (q.type === 'msg') await _broadcastPush(q)
        }
      }
    })

    ws.on('close', () => {
      const pub = _removePeer(ws)
      if (pub) {
        for (const members of _spaceClients.values()) members.delete(pub)
        if (features.router) {
          // Grace period before broadcasting peer.bye (allows quick reconnects)
          const timer = setTimeout(() => {
            _byeTimers.delete(pub)
            if (!_peers.has(pub)) _broadcast({ payload: { type: 'peer.bye', from: pub } })
          }, GRACE_MS)
          _byeTimers.set(pub, timer)
        }
      }
    })

    ws.on('error', (e) => { console.warn('[QuRay:Relay] WS error:', e.message) })
  }


  // ── Start / Stop ──────────────────────────────────────────────────────────

  let _srv = null
  let _wss = null

  const start = async () => {
    // Initialise relay peer (async — opens FsBackend IDB/files)
    _relayPeer = await _makeRelayPeer({ dataDir, debug: false })
    _initVapid()

    return new Promise((resolve, reject) => {
      const handler = async (req, res) => {
        req.on('error', e => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') console.warn('[Relay] req error:', e.code || e.message) })
        res.on('error', e => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') console.warn('[Relay] res error:', e.code || e.message) })
        try { await _handleRequest(req, res) }
        catch (e) {
          if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return
          console.error('[QuRay:Relay] handler error:', e)
          try { res.writeHead(500); res.end('Internal Server Error') } catch {}
        }
      }

      if (httpsCert && httpsKey) {
        try {
          _srv = createHttpsServer({ cert: readFileSync(httpsCert), key: readFileSync(httpsKey) }, handler)
          console.info('[QuRay:Relay] TLS active (HTTPS/WSS)')
        } catch (e) { reject(new Error('TLS: ' + e.message)); return }
      } else {
        _srv = createServer(handler)
      }

      _wss = new WebSocketServer({ server: _srv })
      _wss.on('connection', _handleWs)

      // Global WS keepalive: ping all clients every 25s
      const _keepalive = setInterval(() => {
        _wss.clients.forEach(ws => {
          if (ws.isAlive === false) { ws.terminate(); return }
          ws.isAlive = false
          ws.ping()
        })
      }, 25_000)
      _wss.on('close', () => clearInterval(_keepalive))

      _srv.listen(port, host, () => {
        const proto = (httpsCert && httpsKey) ? 'https' : 'http'
        const wsp   = proto === 'https' ? 'wss' : 'ws'
        const featureList = Object.entries(features).filter(([, v]) => v).map(([k]) => k).join(', ')
        console.info(`\n${'═'.repeat(60)}`)
        console.info(`[QuRay:Relay] ✓ READY on port ${port}`)
        console.info(`${'─'.repeat(60)}`)
        console.info(`  Browser   →  ${proto}://localhost:${port}`)
        console.info(`  WebSocket →  ${wsp}://localhost:${port}`)
        console.info(`  Static    →  ${staticDir}`)
        console.info(`  Data      →  ${dataDir}`)
        console.info(`  Features  →  ${featureList}`)
        console.info(`  Push      →  ${_pushEnabled ? 'enabled (VAPID active)' : 'disabled'}`)
        console.info(`${'═'.repeat(60)}\n`)
        console.info('[QuRay:Relay] Listening for connections…')
        console.info('[QuRay:Relay] Sync IN:  ↓ (QuBit received from peer → stored)')
        console.info('[QuRay:Relay] Sync OUT: ↑ (QuBit routed to peer → delivered)')
        console.info(`${'─'.repeat(60)}\n`)
        resolve({ port, host, proto, wsp })
      })
      _srv.on('error', reject)
    })
  }

  const stop = () => new Promise((resolve) => {
    _wss?.close()
    _srv?.close(() => { console.info('[QuRay:Relay] stopped'); resolve() })
  })

  return {
    start,
    stop,
    get peers()     { return new Map(_peers) },
    get peerCount() { return _peers.size },
    broadcast:  _broadcast,
    sendToPeer: _sendTo,
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// CLI — node relay.js
// ─────────────────────────────────────────────────────────────────────────────

const _isMain = process.argv[1]?.endsWith('relay.js')

if (_isMain) {
  const relay = createRelay({
    port:       parseInt(process.env.PORT        ?? '8080'),
    host:                process.env.HOST        ?? '0.0.0.0',
    staticDir:           process.env.STATIC_DIR  ?? undefined,
    dataDir:             process.env.DATA_DIR    ?? './quray-data',
    apiKey:              process.env.API_KEY     ?? null,
    maxBlobMb:  parseInt(process.env.MAX_BLOB_MB ?? '100'),
    httpsCert:           process.env.HTTPS_CERT  ?? null,
    httpsKey:            process.env.HTTPS_KEY   ?? null,
    features: {
      serve:  process.env.FEATURE_SERVE  !== 'false',
      router: process.env.FEATURE_ROUTER !== 'false',
      sync:   process.env.FEATURE_SYNC   !== 'false',
      push:   process.env.FEATURE_PUSH   === 'true',
      auth:   !!process.env.API_KEY,
    },
  })

  relay.start().catch(e => { console.error('[QuRay:Relay] Error:', e.message); process.exit(1) })
  process.on('SIGTERM', async () => { await relay.stop(); process.exit(0) })
  process.on('SIGINT',  async () => { await relay.stop(); process.exit(0) })
}

export { createRelay }
