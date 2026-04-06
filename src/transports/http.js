// ════════════════════════════════════════════════════════════════════════════
// QuRay — transports/http.js
// HTTP REST Transport-Plugin.
//
// Verantwortung:
//   - POST /api/msg        QuBit senden
//   - GET  /api/info       Relay-Info holen (pub, epub, features)
//   - Polling (opt-in)     GET /api/sync?prefix= in Intervall
//
// Was HTTP NICHT macht:
//   - Keine Blob-Transfers (das macht QuSync direkt via fetch)
//   - Kein Streaming
//   - Kein Keep-Alive
//
// HTTP ist der primäre Datenpfad — funktioniert auf ALLEN Plattformen
// inkl. iOS Safari, Background SW, ohne offenen Tab.
//
// capabilities:
//   realtime:   false   (kein Push — polling oder WS-trigger nötig)
//   background: true    (funktioniert im SW)
//   p2p:        false
//   streaming:  false
//   maxPacket:  0       (unbegrenzt)
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════

import { Signal } from '../core/events.js'
import { TRANSPORT_STATE } from '../core/net.js'


// ─────────────────────────────────────────────────────────────────────────────
// HTTP TRANSPORT FACTORY
//
//   HttpTransport(options?) → transportInstance
//
// options.timeout:         ms, default 15_000
// options.retryOn:         HTTP-Status-Codes die als retry-fähig gelten, default [429, 502, 503]
// options.pollInterval:    ms, 0 = kein Polling (default)
// options.pollPrefix:      Prefix für Polling (z.B. 'data/alice/')
// ─────────────────────────────────────────────────────────────────────────────
/**
 * HTTP transport for relay REST API calls (blob upload/download, push subscribe).
 * Used alongside WsTransport — WebSocket for real-time, HTTP for bulk transfers.
 *
 * @param {string} baseUrl - HTTP base URL of the relay
 * @param {object} [config]
 * @param {number} [config.timeoutMs=30000]
 * @returns {HttpTransportInstance} - { fetch, upload, download }
 * @group Network
 * @since 0.1.0
 */
const HttpTransport = (options = {}) => {
  const _timeoutMs      = options.timeout      ?? 15_000
  const _retryOnCodes   = new Set(options.retryOn ?? [429, 502, 503])
  const _pollIntervalMs = options.pollInterval  ?? 0
  const _pollPrefix     = options.pollPrefix    ?? ''

  // Status-Signal — QuNet reagiert reaktiv darauf
  const state$ = Signal(TRANSPORT_STATE.DISCONNECTED)

  let _baseUrl       = null
  let _pollTimerId   = null
  let _onMessageCb   = null   // gesetzt von QuNet via on('message', cb)
  let _isDestroyed   = false


  // ── Verbindung ────────────────────────────────────────────────────────────

  // connect: Basis-URL setzen + /api/info holen
  // HTTP hat keine echte "Verbindung" — connect ist ein Health-Check
  const connect = async (urlString, connectOptions = {}) => {
    if (_isDestroyed) return
    _baseUrl = urlString.replace(/\/$/, '')    // trailing slash entfernen

    await state$.set(TRANSPORT_STATE.CONNECTING)

    try {
      const relayInfo = await _fetchInfo()
      await state$.set(TRANSPORT_STATE.CONNECTED)

      /*DEBUG*/ console.info('[QuRay:HttpTransport] Verbunden mit:', _baseUrl, relayInfo ? `(pub: ${relayInfo.pub?.slice(0, 16)}…)` : '(kein /api/info)')

      // Polling starten wenn konfiguriert
      if (_pollIntervalMs > 0 && _pollPrefix) _startPolling()

      return relayInfo

    } catch (connectError) {
      await state$.set(TRANSPORT_STATE.ERROR)
      /*DEBUG*/ console.warn('[QuRay:HttpTransport] connect Fehler:', connectError.message)
      throw connectError
    }
  }

  const disconnect = () => {
    _stopPolling()
    _baseUrl     = null
    _isDestroyed = true
    state$.set(TRANSPORT_STATE.DISCONNECTED)
    /*DEBUG*/ console.info('[QuRay:HttpTransport] Getrennt')
  }


  // ── Senden ────────────────────────────────────────────────────────────────

  // send: POST /api/msg
  // packetObject: { to, ttl, payload: QuBit }
  // Gibt true zurück bei Erfolg, false bei nicht-retry-fähigem Fehler,
  // wirft bei retry-fähigen Fehlern (QuNet/QuQueue übernehmen Retry)
  const send = async (packetObject) => {
    if (!_baseUrl) {
      /*DEBUG*/ console.debug('[QuRay:HttpTransport] send: kein baseUrl — nicht gesendet')
      return false
    }

    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), _timeoutMs)

    try {
      const response = await fetch(`${_baseUrl}/api/msg`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(packetObject),
        signal:  controller.signal,
      })
      clearTimeout(timeoutId)

      if (response.ok) {
        /*DEBUG*/ console.debug('[QuRay:HttpTransport] send OK:', packetObject?.payload?.type)
        return true
      }

      if (_retryOnCodes.has(response.status)) {
        /*DEBUG*/ console.warn('[QuRay:HttpTransport] send retry-fähiger Fehler:', response.status)
        // Werfen damit QuQueue den Retry übernimmt
        throw new Error(`HTTP ${response.status}`)
      }

      /*DEBUG*/ console.warn('[QuRay:HttpTransport] send endgültiger Fehler:', response.status)
      return false

    } catch (sendError) {
      clearTimeout(timeoutId)

      if (sendError.name === 'AbortError') {
        /*DEBUG*/ console.warn('[QuRay:HttpTransport] send Timeout nach', _timeoutMs, 'ms')
        throw new Error('HTTP Timeout')
      }

      // Netzwerk-Fehler → retry-fähig
      if (!_retryOnCodes.has(parseInt(sendError.message?.split(' ')[1], 10))) {
        /*DEBUG*/ console.warn('[QuRay:HttpTransport] Netzwerk-Fehler:', sendError.message)
        await state$.set(TRANSPORT_STATE.ERROR)
      }

      throw sendError
    }
  }


  // ── /api/info ─────────────────────────────────────────────────────────────

  const _fetchInfo = async () => {
    if (!_baseUrl) return null
    try {
      const controller = new AbortController()
      const timeoutId  = setTimeout(() => controller.abort(), 5_000)
      const response   = await fetch(`${_baseUrl}/api/info`, { signal: controller.signal })
      clearTimeout(timeoutId)
      if (!response.ok) return null
      return response.json()
    } catch {
      return null   // /api/info ist optional
    }
  }

  // fetchInfo: öffentlich für QuSync (Relay-pub, epub holen)
  const fetchInfo = () => _fetchInfo()


  // ── Polling (opt-in) ──────────────────────────────────────────────────────

  // HTTP-Polling als Fallback wenn kein WS verfügbar (z.B. iOS Background)
  // Löst 'message'-Events aus wie ein WS-Push es täte
  const _startPolling = () => {
    if (_pollTimerId) return
    /*DEBUG*/ console.info('[QuRay:HttpTransport] Polling gestartet:', _pollPrefix, `alle ${_pollIntervalMs}ms`)

    _pollTimerId = setInterval(async () => {
      if (_isDestroyed || !_onMessageCb) return
      await _poll().catch(pollError => {
        /*DEBUG*/ console.warn('[QuRay:HttpTransport] Poll-Fehler:', pollError.message)
      })
    }, _pollIntervalMs)
  }

  const _stopPolling = () => {
    if (_pollTimerId) {
      clearInterval(_pollTimerId)
      _pollTimerId = null
    }
  }

  const _poll = async () => {
    if (!_baseUrl || !_pollPrefix) return

    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), _timeoutMs)

    const response = await fetch(
      `${_baseUrl}/api/sync?prefix=${encodeURIComponent(_pollPrefix)}`,
      { signal: controller.signal }
    )
    clearTimeout(timeoutId)

    if (!response.ok) return

    const { rows = [] } = await response.json()
    if (!rows.length) return

    /*DEBUG*/ console.debug('[QuRay:HttpTransport] Poll:', rows.length, 'neue Einträge')

    // Wie ein WS-db.push behandeln
    if (_onMessageCb) {
      await _onMessageCb({
        payload: {
          type: 'db.res',
          data: { rows },
        }
      })
    }
  }


  // ── Event-Handler (Transport-Interface) ──────────────────────────────────

  // HTTP hat keine eingehenden Nachrichten außer via Polling
  // QuNet ruft on('message', cb) auf um eingehende Pakete zu empfangen
  const _eventHandlers = new Map()

  const on = (eventName, callbackFn) => {
    _eventHandlers.set(eventName, callbackFn)
    if (eventName === 'message') _onMessageCb = callbackFn
    return () => { _eventHandlers.delete(eventName); if (eventName === 'message') _onMessageCb = null }
  }

  const off = (eventName) => {
    _eventHandlers.delete(eventName)
    if (eventName === 'message') _onMessageCb = null
  }


  return {
    name: 'http',

    // Transport-Interface (QuNet erwartet diese)
    connect,
    disconnect,
    send,
    on,
    off,
    state$,
    get state() { return state$ },  // alias for net.js compatibility

    // Zusatz-API
    fetchInfo,
    get baseUrl() { return _baseUrl },

    capabilities: {
      realtime:   false,
      background: true,    // funktioniert im SW ohne Tab
      p2p:        false,
      streaming:  false,
      maxPacket:  0,       // unbegrenzt
    },
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export { HttpTransport }
