// ════════════════════════════════════════════════════════════════════════════
// QuRay — ququeue.js
// Persistente Task-Queue — vollständig auf events.js aufgebaut.
//
// Jeder Status-Wechsel ist ein Event. Handler-Registrierung ist
// bus.on(). Die Queue ist damit transparent für externe Listener
// (z.B. UI-Fortschrittsbalken, Retry-Buttons, Logger-Plugin).
//
// ┌─ Status-Flow ────────────────────────────────────────────────┐
// │  pending → running → done (Task wird gelöscht)               │
// │                    → failed (nach maxRetries)                 │
// │         → stopped  (manuell via stop())                      │
// │  failed | stopped → [retry()] → pending                      │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ Persistenz ──────────────────────────────────────────────────┐
// │  Gespeichert via storageBackend.get/set (injiziert).          │
// │  Empfehlung: LocalStorageBackend für conf/_tasks —            │
// │  überlebt IDB-Timeouts auf Android (bekannter Bug).           │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ Idempotenz ──────────────────────────────────────────────────┐
// │  enqueue() mit dedupKey prüft ob ein Task mit gleichem        │
// │  action + dedupKey bereits pending/running existiert.         │
// │  Falls ja: gibt bestehende Task-ID zurück ohne neu einzureihen│
// └───────────────────────────────────────────────────────────────┘
//
// Debug-Logging: /*DEBUG*/ markierte console.* → bei Minify entfernbar
// ════════════════════════════════════════════════════════════════════════════

import { EventBus } from './events.js'


// ─────────────────────────────────────────────────────────────────────────────
// KONSTANTEN
// ─────────────────────────────────────────────────────────────────────────────

// Task-Status
const TASK_STATUS = {
  PENDING:  'pending',    // wartet auf Verarbeitung
  RUNNING:  'running',    // wird gerade verarbeitet
  DONE:     'done',       // erfolgreich — wird nach done() gelöscht
  FAILED:   'failed',     // maxRetries erreicht — wartet auf manuellen Retry
  STOPPED:  'stopped',    // manuell gestoppt — kein Auto-Retry
}

// Standard-Retry-Delays in Sekunden (Index = Anzahl bisheriger Versuche)
// Über letztem Index: letzter Wert wird wiederholt
const DEFAULT_RETRY_DELAYS_SECONDS = [1, 2, 5, 10, 30, 60]

const DEFAULT_MAX_RETRIES    = 5
const DEFAULT_PRIORITY       = 5    // 0 = höchste, 9 = niedrigste
const DEFAULT_CONCURRENT_MAX = 3    // max. parallele Tasks


// ─────────────────────────────────────────────────────────────────────────────
// QUQUEUE FACTORY
//
//   QuQueue(storageBackend, config?) → queueInstance
//
// storageBackend: { get(key), set(key, value) } — z.B. LocalStorageBackend
// config:         optionale Überschreibung der Defaults
// ─────────────────────────────────────────────────────────────────────────────
const QuQueue = (storageBackend, config = {}) => {
  const _retryDelays   = config.retryDelays   ?? DEFAULT_RETRY_DELAYS_SECONDS
  const _maxRetries    = config.maxRetries     ?? DEFAULT_MAX_RETRIES
  const _concurrentMax = config.concurrentMax  ?? DEFAULT_CONCURRENT_MAX
  const _storageKey    = config.storageKey     ?? 'conf/_tasks'

  // EventBus für alle Queue-Events — Listener registrieren sich hier
  const _bus = EventBus({ separator: '.' })

  // Handler-Map: action → async (task) => void
  const _handlers = new Map()

  // Laufende Tasks (im RAM — für Concurrency-Check)
  const _runningTaskIds = new Set()

  // Queue-Verarbeitung aktiv?
  let _isProcessing = false
  let _isStopped    = false


  // ── Persistenz ───────────────────────────────────────────────────────────

  const _loadAllTasks = async () => {
    try {
      const stored = await storageBackend.get(_storageKey)
      return Array.isArray(stored) ? stored : []
    } catch (loadError) {
      /*DEBUG*/ console.warn('[QuRay:QuQueue] Fehler beim Laden der Tasks:', loadError)
      return []
    }
  }

  const _saveAllTasks = async (taskArray) => {
    try {
      await storageBackend.set(_storageKey, taskArray)
    } catch (saveError) {
      /*DEBUG*/ console.error('[QuRay:QuQueue] Fehler beim Speichern der Tasks:', saveError)
    }
  }

  const _updateTask = async (taskId, patchObject) => {
    const allTasks   = await _loadAllTasks()
    const taskIndex  = allTasks.findIndex(task => task.id === taskId)
    if (taskIndex < 0) {
      /*DEBUG*/ console.warn('[QuRay:QuQueue] _updateTask: Task nicht gefunden:', taskId)
      return null
    }
    const updatedTask = { ...allTasks[taskIndex], ...patchObject, updatedTs: Date.now() }
    allTasks[taskIndex] = updatedTask
    await _saveAllTasks(allTasks)
    return updatedTask
  }


  // ── Retry-Delay Berechnung ───────────────────────────────────────────────

  const _calculateNextRetryTimestamp = (attemptCount) => {
    const delayIndex   = Math.min(attemptCount, _retryDelays.length - 1)
    const delaySeconds = _retryDelays[delayIndex]
    return Date.now() + delaySeconds * 1000
  }


  // ── Verarbeitung ─────────────────────────────────────────────────────────

  // Einen einzelnen Task ausführen
  const _executeTask = async (task) => {
    const handler = _handlers.get(task.action)
    if (!handler) {
      /*DEBUG*/ console.warn('[QuRay:QuQueue] Kein Handler für action:', task.action)
      // Ohne Handler direkt als failed markieren
      await fail(task.id, `Kein Handler registriert für action: ${task.action}`)
      return
    }

    _runningTaskIds.add(task.id)
    const runningTask = await _updateTask(task.id, { status: TASK_STATUS.RUNNING })
    if (runningTask) {
      /*DEBUG*/ console.debug('[QuRay:QuQueue] starting task:', task.action, task.id)
      await _bus.emit('task.running', runningTask)
    }

    try {
      await handler(task)
      // Handler erfolgreich — Task löschen
      await done(task.id)
    } catch (handlerError) {
      /*DEBUG*/ console.warn('[QuRay:QuQueue] Handler-Fehler:', task.action, handlerError.message)
      await fail(task.id, handlerError.message)
    } finally {
      _runningTaskIds.delete(task.id)
    }
  }

  // Nächsten pending Task aus der Queue holen und starten
  const _processNextBatch = async () => {
    if (_isStopped) return
    if (_runningTaskIds.size >= _concurrentMax) return

    const allTasks    = await _loadAllTasks()
    const now         = Date.now()

    const eligibleTasks = allTasks
      .filter(task =>
        task.status === TASK_STATUS.PENDING &&
        !_runningTaskIds.has(task.id) &&
        (task.nextRetryTs == null || task.nextRetryTs <= now)
      )
      .sort((taskA, taskB) => taskA.priority - taskB.priority   // niedrige Zahl = hohe Prio
        || taskA.createdTs - taskB.createdTs                    // ältere zuerst bei gleicher Prio
      )

    // So viele starten wie Concurrency erlaubt
    const slotsAvailable = _concurrentMax - _runningTaskIds.size
    const tasksToStart   = eligibleTasks.slice(0, slotsAvailable)

    for (const task of tasksToStart) {
      // Nicht awaiten — parallel starten, aber Concurrency-Limit beachten
      _executeTask(task).catch(unexpectedError => {
        /*DEBUG*/ console.error('[QuRay:QuQueue] Unerwarteter Fehler in _executeTask:', unexpectedError)
      })
    }

    // Wenn nichts mehr zu tun: drain-Event feuern
    const remainingPending = allTasks.filter(t =>
      t.status === TASK_STATUS.PENDING && !_runningTaskIds.has(t.id)
    )
    if (remainingPending.length === 0 && _runningTaskIds.size === 0) {
      await _bus.emit('drain')
      /*DEBUG*/ console.debug('[QuRay:QuQueue] queue drained')
    }
  }


  // ── Öffentliche API ──────────────────────────────────────────────────────

  // enqueue — Task einreihen (idempotent per action+dedupKey)
  const enqueue = async (actionName, taskData = {}, options = {}) => {
    const {
      priority  = DEFAULT_PRIORITY,
      maxRetries = _maxRetries,
      dedupKey  = null,
    } = options

    const allTasks = await _loadAllTasks()

    // Idempotenz: gleicher action+dedupKey der noch pending/running ist → skip
    if (dedupKey) {
      const existingTask = allTasks.find(task =>
        task.action   === actionName &&
        task.dedupKey === dedupKey &&
        (task.status === TASK_STATUS.PENDING || task.status === TASK_STATUS.RUNNING)
      )
      if (existingTask) {
        /*DEBUG*/ console.debug('[QuRay:QuQueue] Duplikat-Task übersprungen:', actionName, dedupKey)
        return existingTask.id
      }
    }

    const newTask = {
      id:          crypto.randomUUID(),
      action:      actionName,
      data:        taskData,
      status:      TASK_STATUS.PENDING,
      priority,
      maxRetries,
      dedupKey:    dedupKey ?? null,
      attempts:    0,
      progress:    0,
      nextRetryTs: null,
      createdTs:   Date.now(),
      updatedTs:   Date.now(),
      error:       null,
    }

    allTasks.push(newTask)
    await _saveAllTasks(allTasks)

    /*DEBUG*/ console.debug('[QuRay:QuQueue] queued task:', actionName, newTask.id)
    await _bus.emit('task.enqueue', newTask)

    // Sofort versuchen zu starten
    if (!_isStopped) _processNextBatch()

    return newTask.id
  }

  // done — Task als erfolgreich markieren und löschen
  const done = async (taskId) => {
    const allTasks   = await _loadAllTasks()
    const task       = allTasks.find(t => t.id === taskId)
    if (!task) return

    const completedTask = { ...task, status: TASK_STATUS.DONE, progress: 100, updatedTs: Date.now() }

    // done-Tasks werden gelöscht — nicht dauerhaft gespeichert
    const remainingTasks = allTasks.filter(t => t.id !== taskId)
    await _saveAllTasks(remainingTasks)

    /*DEBUG*/ console.debug('[QuRay:QuQueue] completed task:', task.action, taskId)
    await _bus.emit('task.done', completedTask)

    // Nächsten Task anstoßen
    if (!_isStopped) _processNextBatch()
  }

  // fail — Fehlversuch verbuchen, Retry planen oder als failed markieren
  const fail = async (taskId, errorMessage = '') => {
    const allTasks  = await _loadAllTasks()
    const task      = allTasks.find(t => t.id === taskId)
    if (!task) return

    const newAttemptCount = task.attempts + 1
    const hasReachedLimit = newAttemptCount >= task.maxRetries

    const updatedTask = await _updateTask(taskId, {
      attempts:    newAttemptCount,
      status:      hasReachedLimit ? TASK_STATUS.FAILED : TASK_STATUS.PENDING,
      nextRetryTs: hasReachedLimit ? null : _calculateNextRetryTimestamp(newAttemptCount),
      error:       errorMessage,
    })

    if (!updatedTask) return

    if (hasReachedLimit) {
      /*DEBUG*/ console.warn('[QuRay:QuQueue] Task hat maxRetries erreicht:', task.action, taskId)
      await _bus.emit('task.failed', updatedTask)
    } else {
      /*DEBUG*/ console.debug('[QuRay:QuQueue] Task-Retry geplant in', _retryDelays[Math.min(newAttemptCount, _retryDelays.length - 1)], 's:', task.action)
      // Retry nach Delay — nicht sofort
      const retryDelayMs = (_retryDelays[Math.min(newAttemptCount, _retryDelays.length - 1)] ?? 60) * 1000
      setTimeout(() => { if (!_isStopped) _processNextBatch() }, retryDelayMs)
    }
  }

  // retry — failed oder stopped Task zurück auf pending setzen
  const retry = async (taskId) => {
    const updatedTask = await _updateTask(taskId, {
      status:      TASK_STATUS.PENDING,
      attempts:    0,
      nextRetryTs: null,
      error:       null,
    })
    if (!updatedTask) return

    /*DEBUG*/ console.debug('[QuRay:QuQueue] Manueller Retry:', updatedTask.action, taskId)
    await _bus.emit('task.enqueue', updatedTask)
    if (!_isStopped) _processNextBatch()
  }

  // retryAll — alle failed und stopped Tasks zurücksetzen
  const retryAll = async () => {
    const allTasks    = await _loadAllTasks()
    const tasksToRetry = allTasks.filter(task =>
      task.status === TASK_STATUS.FAILED || task.status === TASK_STATUS.STOPPED
    )
    for (const task of tasksToRetry) await retry(task.id)
    /*DEBUG*/ console.info('[QuRay:QuQueue] retryAll:', tasksToRetry.length, 'Tasks zurückgesetzt')
  }

  // stop — einzelnen Task stoppen (kein Auto-Retry bis manuell)
  // Nützlich wenn ein Task hängt und Traffic/Last verursacht
  const stopTask = async (taskId) => {
    const updatedTask = await _updateTask(taskId, {
      status:      TASK_STATUS.STOPPED,
      nextRetryTs: null,
    })
    if (!updatedTask) return

    /*DEBUG*/ console.info('[QuRay:QuQueue] Task gestoppt:', updatedTask.action, taskId)
    await _bus.emit('task.stopped', updatedTask)
  }

  // cancel — Task endgültig entfernen (egal welcher Status)
  const cancel = async (taskId) => {
    const allTasks       = await _loadAllTasks()
    const task           = allTasks.find(t => t.id === taskId)
    const remainingTasks = allTasks.filter(t => t.id !== taskId)
    await _saveAllTasks(remainingTasks)
    _runningTaskIds.delete(taskId)
    if (task) {
      /*DEBUG*/ console.debug('[QuRay:QuQueue] Task abgebrochen:', task.action, taskId)
    }
  }

  // progress — Fortschritt eines laufenden Tasks melden (0–100)
  const reportProgress = async (taskId, percentComplete) => {
    const updatedTask = await _updateTask(taskId, { progress: Math.max(0, Math.min(100, percentComplete)) })
    if (updatedTask) await _bus.emit('task.progress', updatedTask)
  }

  // process — Handler für eine action registrieren
  // handle() — Handler für eine Task-Action registrieren.
  // Alias für process() — semantisch klarer: "handle this action".
  const handle = (actionName, handlerFn) => process(actionName, handlerFn)

  const process = (actionName, handlerFn) => {
    if (_handlers.has(actionName)) {
      /*DEBUG*/ console.warn('[QuRay:QuQueue] Handler für action überschrieben:', actionName)
    }
    _handlers.set(actionName, handlerFn)
    // Sofort pending Tasks für diese action anstoßen
    if (!_isStopped) _processNextBatch()
  }

  // start — Queue-Verarbeitung starten (oder fortsetzen nach stop)
  const start = () => {
    if (_isStopped) {
      _isStopped = false
      /*DEBUG*/ console.info('[QuRay:QuQueue] Queue gestartet')
      _processNextBatch()
    }
  }

  // stop — gesamte Queue pausieren (kein neuer Task wird gestartet)
  // Laufende Tasks werden noch beendet.
  const stop = () => {
    _isStopped = true
    /*DEBUG*/ console.info('[QuRay:QuQueue] Queue gestoppt (laufende Tasks werden beendet)')
  }

  // Abfragen — für UI und Debugging
  const getPending  = async () => (await _loadAllTasks()).filter(t => t.status === TASK_STATUS.PENDING)
  const getRunning  = async () => (await _loadAllTasks()).filter(t => t.status === TASK_STATUS.RUNNING)
  const getFailed   = async () => (await _loadAllTasks()).filter(t => t.status === TASK_STATUS.FAILED)
  const getStopped  = async () => (await _loadAllTasks()).filter(t => t.status === TASK_STATUS.STOPPED)
  const getAll      = async () =>  await _loadAllTasks()
  const getById     = async (taskId) => (await _loadAllTasks()).find(t => t.id === taskId) ?? null

  // Periodisch pending Tasks prüfen (für Retry-Delays nach App-Neustart)
  // Wird bei init() gestartet
  const _startRetryPoller = () => {
    const RETRY_POLL_INTERVAL_MS = 10_000  // alle 10 Sekunden prüfen
    setInterval(() => {
      if (!_isStopped) _processNextBatch()
    }, RETRY_POLL_INTERVAL_MS)
  }

  // init — beim App-Start: pending Tasks aus Storage laden und sofort starten
  const init = async () => {
    const allTasks = await _loadAllTasks()

    // Tasks die beim letzten Absturz als 'running' gespeichert wurden → zurück auf pending
    const crashedRunningTasks = allTasks.filter(t => t.status === TASK_STATUS.RUNNING)
    for (const crashedTask of crashedRunningTasks) {
      await _updateTask(crashedTask.id, { status: TASK_STATUS.PENDING, nextRetryTs: null })
    }
    if (crashedRunningTasks.length > 0) {
      /*DEBUG*/ console.info('[QuRay:QuQueue] init:', crashedRunningTasks.length, 'abgestürzte Tasks zurückgesetzt')
    }

    _startRetryPoller()
    _processNextBatch()

    /*DEBUG*/ console.info('[QuRay:QuQueue] init abgeschlossen,', allTasks.length, 'Tasks geladen')
  }

  // on/once — Listener auf Queue-Events (via events.js EventBus)
  // Damit kann jede externe Komponente auf Queue-Events reagieren
  // ohne direkte Kopplung an die Queue-Implementierung
  const on   = (pattern, handlerFn) => _bus.on(pattern, handlerFn)
  const once = (pattern, handlerFn) => _bus.once(pattern, handlerFn)

  return {
    // Lifecycle
    init,
    start,
    stop,

    // Task-Management
    enqueue,
    done,
    fail,
    retry,
    retryAll,
    stopTask,
    cancel,
    reportProgress,

    // Handler-Registrierung
    // queue.handle(actionName, fn)  — registriert Verarbeiter für einen Task-Typ.
    // queue.process(actionName, fn) — Alias (rückwärtskompatibel)
    // fn erhält (task) und muss Promise<void> zurückgeben.
    // Wirft die fn, wird der Task als failed markiert und retry gestartet.
    handle,
    process: handle,   // alias — gleiche Funktion, anderer Name

    // Abfragen
    getPending,
    getRunning,
    getFailed,
    getStopped,
    getAll,
    getById,

    // Events (via EventBus)
    on,
    once,

    // Status
    get isStopped() { return _isStopped },
    get runningCount() { return _runningTaskIds.size },
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export {
  QuQueue,
  TASK_STATUS,
  DEFAULT_RETRY_DELAYS_SECONDS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PRIORITY,
  DEFAULT_CONCURRENT_MAX,
}
