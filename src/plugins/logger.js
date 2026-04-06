// ════════════════════════════════════════════════════════════════════════════
// QuRay — middleware/logger.js
// Produktions-Logging-Plugin — ersetzt console.* durch strukturiertes Logging.
//
// Warum als Plugin?
//   console.* im Source-Code ist Debug-only (/*DEBUG*/ Marker → raus bei Minify).
//   Produktions-Logging braucht: Persistenz, Remote-Transport, Sampling,
//   Log-Level-Filter, strukturierte Felder. Das ist zu viel für console.*.
//
// LoggerPlugin(config) → (db) → offFn
//
// config.level:       'debug' | 'info' | 'warn' | 'error', default 'info'
// config.transport:   async (logEntry) → void — wohin Logs gehen
// config.sample:      0–1 — Sampling-Rate für debug-Logs, default 1.0
// config.fields:      { [key]: value } — Felder die jedem Log-Eintrag hinzugefügt werden
//
// Standard-Transports enthalten:
//   LoggerPlugin.consoleTransport()   — strukturiert in console.log
//   LoggerPlugin.memoryTransport(n)   — letzten n Logs im RAM (für Tests)
//   LoggerPlugin.httpTransport(url)   — POST an Log-Endpoint
// ════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// LOG-LEVEL HIERARCHIE
// ─────────────────────────────────────────────────────────────────────────────
const LOG_LEVEL = { debug: 0, info: 1, warn: 2, error: 3 }
const LOG_LEVEL_NAMES = ['debug', 'info', 'warn', 'error']


// ─────────────────────────────────────────────────────────────────────────────
// LOGGER FACTORY (standalone — kann ohne Plugin genutzt werden)
// ─────────────────────────────────────────────────────────────────────────────
const createLogger = (config = {}) => {
  const minLevel    = LOG_LEVEL[config.level ?? 'info'] ?? 1
  const transportFn = config.transport ?? LoggerPlugin.consoleTransport()
  const sampleRate  = config.sample    ?? 1.0
  const extraFields = config.fields    ?? {}

  const _log = async (levelName, ...messageParts) => {
    const levelNum = LOG_LEVEL[levelName] ?? 1
    if (levelNum < minLevel) return

    // Debug-Sampling: nicht jeden Debug-Log schreiben
    if (levelNum === 0 && sampleRate < 1.0 && Math.random() > sampleRate) return

    const logEntry = {
      ts:      Date.now(),
      level:   levelName,
      msg:     messageParts.filter(p => typeof p === 'string').join(' '),
      data:    messageParts.find(p => typeof p === 'object' && p !== null) ?? null,
      ...extraFields,
    }

    try {
      await transportFn(logEntry)
    } catch { /* Transport-Fehler dürfen App nicht crashen */ }
  }

  return {
    debug: (...args) => _log('debug', ...args),
    info:  (...args) => _log('info',  ...args),
    warn:  (...args) => _log('warn',  ...args),
    error: (...args) => _log('error', ...args),
    child: (childFields) => createLogger({
      ...config,
      fields: { ...extraFields, ...childFields },
    }),
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// LOGGER PLUGIN — hängt sich in DB-Events und Pipeline ein
// ─────────────────────────────────────────────────────────────────────────────
const LoggerPlugin = (config = {}) => (db) => {
  const logger = createLogger(config)

  // ── IN-Pipeline: eingehende QuBits loggen (höchste Prio → nur Logging) ──
  const offInLog = db.useIn(async ({ args: [ctx], next }) => {
    logger.debug('in', ctx.qubit?.type, { key: ctx.qubit?.key, from: ctx.qubit?.from?.slice(0, 16) })
    await next()
  }, 99)   // Prio 99 → vor allem anderen in IN-Pipeline (nur Logging, kein stop())

  // ── OUT-Pipeline: ausgehende QuBits loggen ──────────────────────────────
  const offOutLog = db.useOut(async ({ args: [ctx], next }) => {
    logger.debug('out', ctx.qubit?.type, { key: ctx.qubit?.key })
    await next()
  }, 99)

  // ── Queue-Events loggen ─────────────────────────────────────────────────
  let offQueueLog = () => {}
  if (db.queue) {
    const queueLogger = logger.child({ module: 'queue' })
    const offFailed  = db.queue.on('task.failed', (task) =>
      queueLogger.warn('task.failed', task.action, { id: task.id, error: task.error, attempts: task.attempts })
    )
    const offStopped = db.queue.on('task.stopped', (task) =>
      queueLogger.info('task.stopped', task.action, { id: task.id })
    )
    const offDrain   = db.queue.on('drain', () =>
      queueLogger.debug('queue.drain')
    )
    offQueueLog = () => { offFailed(); offStopped(); offDrain() }
  }

  // ── Transport-Status loggen ─────────────────────────────────────────────
  // (wird von App via qr.net.state$.on() eingehängt — hier nur Beispiel)

  return () => { offInLog(); offOutLog(); offQueueLog() }
}


// ─────────────────────────────────────────────────────────────────────────────
// STANDARD-TRANSPORTS
// ─────────────────────────────────────────────────────────────────────────────

// consoleTransport — strukturiert, mit Level-Farben
LoggerPlugin.consoleTransport = () => (logEntry) => {
  const prefix = `[${new Date(logEntry.ts).toISOString()}] [${logEntry.level.toUpperCase()}]`
  const consoleFn = logEntry.level === 'error' ? console.error
                  : logEntry.level === 'warn'  ? console.warn
                  : logEntry.level === 'debug' ? console.debug
                  : console.info

  if (logEntry.data) {
    consoleFn(prefix, logEntry.msg, logEntry.data)
  } else {
    consoleFn(prefix, logEntry.msg)
  }
  return Promise.resolve()
}

// memoryTransport — letzten n Logs im RAM halten (für Tests + Debugging)
LoggerPlugin.memoryTransport = (maxEntries = 200) => {
  const entries = []
  const transport = (logEntry) => {
    entries.push(logEntry)
    if (entries.length > maxEntries) entries.shift()
    return Promise.resolve()
  }
  transport.entries  = entries
  transport.clear    = () => entries.splice(0)
  transport.byLevel  = (levelName) => entries.filter(e => e.level === levelName)
  transport.last     = (n = 10) => entries.slice(-n)
  return transport
}

// httpTransport — POST an Log-Endpoint (für Prod-Monitoring)
LoggerPlugin.httpTransport = (endpointUrl, options = {}) => {
  const batchSize    = options.batchSize    ?? 20
  const flushEveryMs = options.flushEveryMs ?? 5_000
  const minLevel     = LOG_LEVEL[options.minLevel ?? 'warn'] ?? 2

  const _pendingBatch = []
  let   _flushTimer  = null

  const _flush = async () => {
    if (!_pendingBatch.length) return
    const toSend = _pendingBatch.splice(0)
    try {
      await fetch(endpointUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ logs: toSend }),
      })
    } catch { /* Netzwerk-Fehler beim Logging ignorieren */ }
  }

  return async (logEntry) => {
    if ((LOG_LEVEL[logEntry.level] ?? 0) < minLevel) return
    _pendingBatch.push(logEntry)

    if (_pendingBatch.length >= batchSize) {
      clearTimeout(_flushTimer)
      await _flush()
    } else if (!_flushTimer) {
      _flushTimer = setTimeout(() => { _flushTimer = null; _flush() }, flushEveryMs)
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export { LoggerPlugin, createLogger, LOG_LEVEL, LOG_LEVEL_NAMES }
