// ════════════════════════════════════════════════════════════════════════════
// QuRay — qunet.js
// Transport-Manager: Plugin-Routing, Capability-Filter, Rate-Limiting.
//
// ┌─ Verantwortung ───────────────────────────────────────────────┐
// │  - Transports registrieren und verwalten                      │
// │  - Besten Transport per Capability-Filter wählen              │
// │  - Rate-Limiting pro Transport via QuQueue                    │
// │  - Eingehende Pakete bündeln → an Listener weiterleiten       │
// │  - Status als Signal — UI reagiert reaktiv                    │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ Was QuNet NICHT macht ────────────────────────────────────────┐
// │  - Keine Kryptographie                                        │
// │  - Keine DB-Operationen                                       │
// │  - Kein QuBit-Format — nur rohe Pakete                        │
// └───────────────────────────────────────────────────────────────┘
//
// Transport-Plugin-Interface:
//   { connect, disconnect, send, on, off, capabilities, state }
//   → siehe transports/http.js und transports/ws.js
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════

import { Signal, EventBus } from './events.js'


// ─────────────────────────────────────────────────────────────────────────────
// KONSTANTEN
// ─────────────────────────────────────────────────────────────────────────────

// Verbindungs-Status pro Transport
const TRANSPORT_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
  ERROR:        'error',
}

// Standard Rate-Limits pro Transport-Typ
const DEFAULT_RATE_LIMITS = {
  http: { requestsPerMinute: 120, concurrent: 4 },
  ws:   { requestsPerMinute: 300, concurrent: 10 },
  webrtc: { requestsPerMinute: 600, concurrent: 20 },
}


// ─────────────────────────────────────────────────────────────────────────────
// QUNET FACTORY
//
//   QuNet(config?) → netInstance
//
// config.rateLimits:   { [transportName]: { requestsPerMinute, concurrent } }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Multi-transport network layer. Manages WebSocket connections to relays,
 * handles reconnection with exponential backoff, and exposes a reactive
 * connection state Signal.
 *
 * @param {object} [config]
 * @param {number} [config.pingIntervalMs=25000] - WebSocket keepalive interval
 * @param {number} [config.maxReconnectDelayMs=30000] - Max backoff delay
 * @returns {QuNetInstance} - { add, remove, send, state$, relays }
 * @group Network
 * @since 0.1.0
 *
 * @example
 * // Used via QuRay.init() automatically.
 * // Access via qr._.net:
 * qr._.net.state$.on(states => {
 *   const online = Object.values(states).some(s => s === 'connected')
 * })
 */
const QuNet = (config = {}) => {
  // Registrierte Transports: name → { transport, rateState, offHandlers }
  const _registeredTransports = new Map()

  // Gebündelter EventBus für eingehende Pakete aller Transports
  const _incomingMessageBus = EventBus({ separator: '.' })

  // Status-Signal: { [transportName]: TRANSPORT_STATE }
  const state$ = Signal({})

  // Aktuell laufende Requests pro Transport (für Concurrency-Limit)
  const _runningRequestCounts = new Map()   // transportName → number

  // Endpoints describe where a transport connects to.
  // They keep transport choice and address separate from the send() API.
  const _endpoints = new Map()


  // ── Transport registrieren ───────────────────────────────────────────────

  const use = (transportInstance, transportName = null) => {
    const name = transportName ?? transportInstance.name ?? _generateTransportName()

    // Ratenlimit-Config für diesen Transport laden
    const rateLimitConfig = config.rateLimits?.[name]
      ?? DEFAULT_RATE_LIMITS[name]
      ?? DEFAULT_RATE_LIMITS.http

    _runningRequestCounts.set(name, 0)

    // Eingehende Nachrichten dieses Transports an den zentralen Bus weiterleiten
    const offMessage = transportInstance.on('message', async (rawPacket) => {
      /*DEBUG*/ console.debug('[QuRay:QuNet] Eingehendes Paket via', name, ':', rawPacket?.payload?.type)
      await _incomingMessageBus.emit('message', rawPacket, { transport: name })
    })

    // Status-Änderungen dieses Transports in state$ widerspiegeln
    const offState = transportInstance.state.on(async (newState) => {
      /*DEBUG*/ console.info('[QuRay:QuNet] Transport-Status:', name, '→', newState)
      await state$.update(currentStates => ({ ...currentStates, [name]: newState }))
      await _incomingMessageBus.emit('state', { transport: name, state: newState }, { transport: name })
    })

    _registeredTransports.set(name, {
      transport:         transportInstance,
      rateLimitConfig,
      offHandlers:       () => { offMessage(); offState() },
    })

    /*DEBUG*/ console.info('[QuRay:QuNet] Transport registriert:', name, transportInstance.capabilities)
    return name   // Transport-Name zurückgeben für späteren Zugriff
  }


  // ── Capability-Filter ────────────────────────────────────────────────────

  // Besten Transport finden der alle required Capabilities erfüllt
  // und den Status CONNECTED hat
  const _findBestTransport = (requiredCapabilities = {}) => {
    for (const [name, entry] of _registeredTransports) {
      const { transport } = entry
      const isConnected   = transport.state.get() === TRANSPORT_STATE.CONNECTED

      if (!isConnected) continue

      // Alle required Capabilities müssen erfüllt sein
      const meetsAllRequirements = Object.entries(requiredCapabilities)
        .every(([capabilityKey, requiredValue]) =>
          transport.capabilities[capabilityKey] === requiredValue
        )

      if (meetsAllRequirements) return { name, transport }
    }
    return null
  }


  // ── Rate-Limiting ────────────────────────────────────────────────────────

  // Prüfen ob Concurrency-Limit für diesen Transport erreicht ist
  const _isUnderConcurrencyLimit = (transportName) => {
    const currentCount  = _runningRequestCounts.get(transportName) ?? 0
    const entry         = _registeredTransports.get(transportName)
    const concurrentMax = entry?.rateLimitConfig?.concurrent ?? 4
    return currentCount < concurrentMax
  }

  const _incrementRunningCount = (transportName) => {
    _runningRequestCounts.set(transportName, (_runningRequestCounts.get(transportName) ?? 0) + 1)
  }

  const _decrementRunningCount = (transportName) => {
    const current = _runningRequestCounts.get(transportName) ?? 1
    _runningRequestCounts.set(transportName, Math.max(0, current - 1))
  }


  // ── Senden ───────────────────────────────────────────────────────────────

  // send — Paket über besten verfügbaren Transport senden
  // options.require: { realtime: true } etc. — Capability-Filter
  // options.via:     transportName → direkt an diesen Transport
  // Gibt false zurück wenn kein Transport verfügbar (kein Fehler!)
  const send = async (packetObject, options = {}) => {
    const {
      require: requiredCapabilities = {},
      via: preferredTransport = null,
      endpointId = null,
    } = options

    const endpoint = endpointId ? _endpoints.get(endpointId) : null
    const endpointTransport = endpoint?.transportName ?? endpoint?.transport ?? null
    let transportEntry = null

    if (preferredTransport || endpointTransport) {
      const resolvedTransportName = preferredTransport ?? endpointTransport
      // Direkter Transport-Zugriff
      const entry = _registeredTransports.get(resolvedTransportName)
      if (entry?.transport.state.get() === TRANSPORT_STATE.CONNECTED) {
        transportEntry = { name: resolvedTransportName, transport: entry.transport }
      }
    } else {
      transportEntry = _findBestTransport(requiredCapabilities)
    }

    if (!transportEntry) {
      /*DEBUG*/ console.debug('[QuRay:QuNet] Kein verfügbarer Transport — Paket nicht gesendet:', packetObject?.payload?.type)
      return false
    }

    const { name: transportName, transport } = transportEntry

    // Concurrency-Limit prüfen
    if (!_isUnderConcurrencyLimit(transportName)) {
      /*DEBUG*/ console.debug('[QuRay:QuNet] Concurrency-Limit erreicht für:', transportName, '— Paket wird verzögert')
      // Kurz warten und nochmal versuchen (einfaches Backpressure)
      await new Promise(resolve => setTimeout(resolve, 100))
      return send(packetObject, options)   // rekursiv, aber mit Delay
    }

    _incrementRunningCount(transportName)
    try {
      const wasSent = await transport.send(packetObject)
      /*DEBUG*/ if (wasSent) console.debug('[QuRay:QuNet] Gesendet via', transportName, ':', packetObject?.payload?.type)
      return wasSent
    } catch (sendError) {
      /*DEBUG*/ console.warn('[QuRay:QuNet] Sende-Fehler via', transportName, ':', sendError.message)
      return false
    } finally {
      _decrementRunningCount(transportName)
    }
  }

  // sendVia — direkt an einen bestimmten Transport (Shortcut)
  const sendVia = (transportName, packetObject) =>
    send(packetObject, { via: transportName })


  // ── Empfangen ────────────────────────────────────────────────────────────

  // on('message', cb) — alle eingehenden Pakete aller Transports
  // cb(rawPacket, { transport: transportName })
  // on() — Event-Listener. Gibt offFn zurück (wie db.on, Signal.on, Peers.onChange).
  // event: 'message' | 'state' | '*'
  const on = (eventName, callbackFn) => _incomingMessageBus.on(eventName, callbackFn)

  // off() — Legacy-API: Alle Listener für ein Event entfernen.
  // Bevorzuge: const off = net.on('message', fn); off()
  const off = (eventName) => _incomingMessageBus.off(eventName)


  // ── Transport-Verwaltung ─────────────────────────────────────────────────

  const connect = async (transportName, urlString, connectOptions = {}) => {
    const entry = _registeredTransports.get(transportName)
    if (!entry) {
      /*DEBUG*/ console.warn('[QuRay:QuNet] connect: Transport nicht gefunden:', transportName)
      return
    }
    await entry.transport.connect(urlString, connectOptions)
  }

  const disconnect = async (transportName) => {
    const entry = _registeredTransports.get(transportName)
    if (!entry) return
    entry.transport.disconnect()
    entry.offHandlers()
    _registeredTransports.delete(transportName)
    /*DEBUG*/ console.info('[QuRay:QuNet] Transport getrennt:', transportName)
  }

  const disconnectAll = async () => {
    for (const [name] of _registeredTransports) await disconnect(name)
  }

  // Transport-Instanz direkt zugreifen (für transport-spezifische Operationen)
  const getTransport = (transportName) =>
    _registeredTransports.get(transportName)?.transport ?? null

  // Alle verbundenen Transport-Namen
  const connectedTransports = () =>
    [..._registeredTransports.entries()]
      .filter(([, entry]) => entry.transport.state.get() === TRANSPORT_STATE.CONNECTED)
      .map(([name]) => name)

  // Konfiguration eines Transports zur Laufzeit anpassen
  const configure = (transportName, patchConfig) => {
    const entry = _registeredTransports.get(transportName)
    if (!entry) return
    Object.assign(entry.rateLimitConfig, patchConfig.rateLimit ?? {})
    /*DEBUG*/ console.debug('[QuRay:QuNet] Transport konfiguriert:', transportName, patchConfig)
  }


  const addEndpoint = (endpointConfig = {}) => {
    const endpointId = endpointConfig.id ?? `endpoint-${_endpoints.size + 1}`
    _endpoints.set(endpointId, {
      id: endpointId,
      transportName: endpointConfig.transportName ?? endpointConfig.transport ?? endpointId,
      url: endpointConfig.url ?? null,
      connectOptions: endpointConfig.connectOptions ?? {},
      capabilities: endpointConfig.capabilities ?? endpointConfig.caps ?? {},
      meta: endpointConfig.meta ?? {},
    })
    return endpointId
  }

  const removeEndpoint = (endpointId) => _endpoints.delete(endpointId)

  const getEndpoint = (endpointId) => {
    const endpoint = _endpoints.get(endpointId)
    return endpoint ? { ...endpoint } : null
  }

  const listEndpoints = () => [..._endpoints.values()].map(endpoint => ({ ...endpoint }))

  const connectEndpoint = async (endpointId, overrides = {}) => {
    const endpoint = _endpoints.get(endpointId)
    if (!endpoint) return false
    const transportName = endpoint.transportName ?? endpoint.transport ?? endpointId
    const url = overrides.url ?? endpoint.url ?? null
    await connect(transportName, url, { ...endpoint.connectOptions, ...overrides.connectOptions })
    return true
  }

  const disconnectEndpoint = async (endpointId) => {
    const endpoint = _endpoints.get(endpointId)
    if (!endpoint) return false
    const transportName = endpoint.transportName ?? endpoint.transport ?? endpointId
    await disconnect(transportName)
    return true
  }

  const sendTo = async (endpointId, packetObject, options = {}) =>
    send(packetObject, { ...options, endpointId })


  // ── Hilfsfunktionen ──────────────────────────────────────────────────────

  let _transportCounter = 0
  const _generateTransportName = () => `transport-${++_transportCounter}`


  return {
    // Transport-Management
    use,
    connect,
    disconnect,
    disconnectAll,
    getTransport,
    connectedTransports,
    configure,
    addEndpoint,
    removeEndpoint,
    getEndpoint,
    listEndpoints,
    connectEndpoint,
    disconnectEndpoint,

    // Senden
    send,
    sendVia,
    sendTo,

    // Empfangen
    on,
    off,

    // Status
    state$,

    // Konstanten
    TRANSPORT_STATE,
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export { QuNet, TRANSPORT_STATE, DEFAULT_RATE_LIMITS }
