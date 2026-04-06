// ════════════════════════════════════════════════════════════════════════════
// QuRay — transports/ws.js
// WebSocket Transport-Plugin — NUR für Signaling und kleine Events.
//
// ┌─ Was WS macht ────────────────────────────────────────────────┐
// │  peer.hello / peer.bye / peers.req / peers.list               │
// │  db.sub / db.push (Relay → Client "neues Item da")            │
// │  webrtc.offer / .answer / .ice                                │
// │  Kleine Echtzeit-Events die HTTP-Fetches triggern             │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ Was WS NICHT macht ──────────────────────────────────────────┐
// │  Kein Blob-Transfer (blob.chunk ist deprecated)               │
// │  Keine großen Daten                                           │
// └───────────────────────────────────────────────────────────────┘
//
// Reconnect: exponentielles Backoff mit konfigurierbarem Maximum.
// rawSend: direkte ws.send() ohne Pipeline (für blob.chunk-Fallback).
// Puffert ausgehende Pakete wenn WS nicht OPEN — sendet bei Reconnect.
//
// capabilities:
//   realtime:   true
//   background: false   (SW kann kein WS — nur HTTP)
//   p2p:        false
//   streaming:  false
//   maxPacket:  64 * 1024  (64 KB — WS-Frames)
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════

import { Signal } from '../core/events.js'
import { TRANSPORT_STATE } from '../core/net.js'


// ─────────────────────────────────────────────────────────────────────────────
// WS TRANSPORT FACTORY
//
//   WsTransport(options?) → transportInstance
//
// options.reconnect:        true | false, default true
// options.reconnectDelays:  [ms, ...] — exponentiell, default [1000, 2000, 5000, 10000, 30000]
// options.pingInterval:     ms, 0 = kein Ping, default 25_000
// options.onConnect:        async ({ relayInfo }) → void
// ─────────────────────────────────────────────────────────────────────────────
/**
 * WebSocket transport for relay connections. Handles connect/disconnect,
 * message framing (JSON), ping/pong keepalive, and exponential backoff reconnect.
 *
 * @param {string} url - WebSocket URL (ws:// or wss://)
 * @param {object} [config]
 * @param {number} [config.pingIntervalMs=25000]
 * @param {number} [config.reconnectDelayMs=1000]
 * @returns {TransportInstance} - { connect, disconnect, send, on, state$ }
 * @group Network
 * @since 0.1.0
 *
 * @example
 * // Used automatically by QuNet — no manual use needed.
 * // The relay URL is passed to QuRay.init({ relay: 'wss://...' })
 */
const WsTransport = (options = {}) => {
  const _shouldReconnect    = options.reconnect       ?? true
  const _reconnectDelays    = options.reconnectDelays ?? [1_000, 2_000, 5_000, 10_000, 30_000]
  const _pingIntervalMs     = options.pingInterval    ?? 25_000
  const _onConnectHook      = options.onConnect       ?? null

  // Status-Signal
  const state$ = Signal(TRANSPORT_STATE.DISCONNECTED)

  let _ws              = null
  let _wsSessionId     = 0      // inkrementiert bei jedem Reconnect, verhindert stale Callbacks
  let _reconnectIndex  = 0      // Index in _reconnectDelays
  let _reconnectTimer  = null
  let _pingTimer       = null
  let _isDestroyed     = false
  let _targetUrl       = null

  // Ausgehende Nachrichten die gebuffert werden wenn WS nicht OPEN
  const _sendBuffer = []

  // Registrierte Event-Handler (message, connect, disconnect, error)
  const _eventHandlers = new Map()

  const _emit = async (eventName, ...args) => {
    const handlerFn = _eventHandlers.get(eventName)
    if (handlerFn) {
      try { await handlerFn(...args) }
      catch (e) {
      /*DEBUG*/ console.warn('[QuRay:WsTransport] Event-Handler Fehler:', eventName, e)
    }
    }
  }


  // ── Verbindung ────────────────────────────────────────────────────────────

  const connect = async (urlString, connectOptions = {}) => {
    if (_isDestroyed) return
    _targetUrl = urlString
    _reconnectIndex = 0
    _doConnect()
  }

  const _doConnect = () => {
    if (_isDestroyed || !_targetUrl) return

    // Stale WS schließen
    if (_ws) {
      _ws.onopen = _ws.onmessage = _ws.onclose = _ws.onerror = null
      if (_ws.readyState !== WebSocket.CLOSED) _ws.close()
      _ws = null
    }

    const sessionId = ++_wsSessionId
    state$.set(TRANSPORT_STATE.CONNECTING)

    try {
      _ws = new WebSocket(_targetUrl)
    } catch (wsCreateError) {
      /*DEBUG*/ console.error('[QuRay:WsTransport] WebSocket erstellen fehlgeschlagen:', wsCreateError)
      state$.set(TRANSPORT_STATE.ERROR)
      _scheduleReconnect()
      return
    }

    _ws.onopen = async () => {
      if (sessionId !== _wsSessionId || _isDestroyed) return

      _reconnectIndex = 0   // Erfolgreich verbunden — Backoff zurücksetzen
      await state$.set(TRANSPORT_STATE.CONNECTED)
      _startPing()
      _flushSendBuffer()

      /*DEBUG*/ console.info('[QuRay:WsTransport] Verbunden:', _targetUrl)

      await _emit('connect')
      if (_onConnectHook) {
        await _onConnectHook().catch(hookError => {
          /*DEBUG*/ console.warn('[QuRay:WsTransport] onConnect-Hook Fehler:', hookError)
        })
      }
    }

    _ws.onmessage = async ({ data: rawData }) => {
      if (sessionId !== _wsSessionId || _isDestroyed) return

      let parsedPacket
      try {
        parsedPacket = JSON.parse(rawData)
      } catch {
        /*DEBUG*/ console.warn('[QuRay:WsTransport] Ungültiges JSON empfangen')
        return
      }

      if (!parsedPacket?.payload?.type && !parsedPacket?.type) return

      /*DEBUG*/ console.debug('[QuRay:WsTransport] Empfangen:', parsedPacket?.payload?.type ?? parsedPacket?.type)

      await _emit('message', parsedPacket)
    }

    _ws.onclose = async (closeEvent) => {
      if (sessionId !== _wsSessionId || _isDestroyed) return

      _stopPing()
      await state$.set(TRANSPORT_STATE.DISCONNECTED)
      /*DEBUG*/ console.info('[QuRay:WsTransport] Verbindung getrennt — Code:', closeEvent.code)

      await _emit('disconnect', { code: closeEvent.code, reason: closeEvent.reason })

      if (_shouldReconnect && !_isDestroyed) _scheduleReconnect()
    }

    _ws.onerror = async () => {
      // onerror kommt immer vor onclose — onclose macht den eigentlichen Cleanup
      await state$.set(TRANSPORT_STATE.ERROR)
      await _emit('error')
      /*DEBUG*/ console.warn('[QuRay:WsTransport] WebSocket-Fehler')
    }
  }

  const disconnect = () => {
    _isDestroyed = true
    _stopPing()
    _clearReconnectTimer()
    if (_ws) {
      _ws.onopen = _ws.onmessage = _ws.onclose = _ws.onerror = null
      _ws.close()
      _ws = null
    }
    state$.set(TRANSPORT_STATE.DISCONNECTED)
    /*DEBUG*/ console.info('[QuRay:WsTransport] Manuell getrennt')
  }


  // ── Reconnect ─────────────────────────────────────────────────────────────

  const _scheduleReconnect = () => {
    if (_isDestroyed || _reconnectTimer) return

    const delayMs = _reconnectDelays[Math.min(_reconnectIndex, _reconnectDelays.length - 1)]
    _reconnectIndex++

    /*DEBUG*/ console.info('[QuRay:WsTransport] Reconnect in', delayMs, 'ms (Versuch', _reconnectIndex, ')')

    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null
      if (!_isDestroyed) _doConnect()
    }, delayMs)
  }

  const _clearReconnectTimer = () => {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  }


  // ── Ping/Pong ─────────────────────────────────────────────────────────────

  // Regelmäßiger Ping hält die Verbindung am Leben (NAT-Timeouts verhindern)
  const _startPing = () => {
    _stopPing()
    if (!_pingIntervalMs) return
    _pingTimer = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: 'ping' }))
        /*DEBUG*/ console.debug('[QuRay:WsTransport] Ping gesendet')
      }
    }, _pingIntervalMs)
  }

  const _stopPing = () => {
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null }
  }


  // ── Senden ────────────────────────────────────────────────────────────────

  const send = async (packetObject) => {
    if (_ws?.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(packetObject))
      /*DEBUG*/ console.debug('[QuRay:WsTransport] Gesendet:', packetObject?.payload?.type)
      return true
    }

    // WS nicht offen — in Buffer legen (wird bei Reconnect gesendet)
    _sendBuffer.push(packetObject)
    /*DEBUG*/ console.debug('[QuRay:WsTransport] Gebuffert (WS nicht offen):', packetObject?.payload?.type, `(${_sendBuffer.length} im Buffer)`)
    return false
  }

  // rawSend: direkt ws.send() ohne JSON-Stringify (für bereits serialisierte Daten)
  // Puffert ebenfalls wenn WS nicht offen
  const rawSend = (rawData) => {
    if (_ws?.readyState === WebSocket.OPEN) {
      _ws.send(typeof rawData === 'string' ? rawData : JSON.stringify(rawData))
      return true
    }
    _sendBuffer.push(rawData)
    return false
  }

  const _flushSendBuffer = () => {
    if (!_sendBuffer.length) return
    /*DEBUG*/ console.info('[QuRay:WsTransport] Send-Buffer flushen:', _sendBuffer.length, 'Pakete')
    while (_sendBuffer.length) {
      const packet = _sendBuffer.shift()
      if (_ws?.readyState === WebSocket.OPEN) {
        _ws.send(typeof packet === 'string' ? packet : JSON.stringify(packet))
      }
    }
  }


  // ── Event-Handler ─────────────────────────────────────────────────────────

  const on = (eventName, callbackFn) => {
    _eventHandlers.set(eventName, callbackFn)
    return () => _eventHandlers.delete(eventName)
  }

  const off = (eventName) => _eventHandlers.delete(eventName)


  // ── Status-Abfragen ───────────────────────────────────────────────────────

  // wsAlive: WS wirklich OPEN — für Entscheidungen in QuSync
  const isAlive = () => _ws?.readyState === WebSocket.OPEN

  // HTTP-Basis-URL aus WS-URL ableiten
  const httpUrl = () => _targetUrl
    ? _targetUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
    : null


  return {
    name: 'ws',

    // Transport-Interface
    connect,
    disconnect,
    send,
    on,
    off,
    state$,
    get state() { return state$ },  // alias for net.js compatibility

    // Zusatz-API
    rawSend,
    isAlive,
    httpUrl,
    get bufferSize() { return _sendBuffer.length },

    capabilities: {
      realtime:   true,
      background: false,    // SW kann kein WS
      p2p:        false,
      streaming:  false,
      maxPacket:  64 * 1024,
    },
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export { WsTransport }
