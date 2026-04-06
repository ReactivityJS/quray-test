// ════════════════════════════════════════════════════════════════════════════
// QuRay — events.js
// Fundament des Frameworks. Drei saubere Schichten:
//
//   Layer 0  Stack      Datenstruktur — hält Funktionen, weiß nichts von Ausführung
//   Layer 1  Runner     Pure Funktionen — führen Stacks aus, wissen nichts von Stacks
//   Layer 2  Manager    Hook · Signal · EventBus — verbinden Stack + Runner
//
// Jede Schicht kennt nur die darunter liegende.
// Nichts hier weiß von "QuDB", "QuNet", "QuBit" oder anderem Framework-Code.
//
// Debug-Logging:
//   Alle console.* Aufrufe sind mit /*DEBUG*/ markiert.
//   Ein Minifier-Plugin kann diese Zeilen automatisch entfernen.
//   Produktions-Logging → via LoggerPlugin in middleware/logger.js
//
// Namenskonventionen:
//   _camelCase    interne Variable / Funktion (nicht exportiert)
//   UPPER_CASE    Konstante
//   $suffix       Signal-Instanz (Konvention für Lesbarkeit im App-Code)
// ════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// LAYER 0 — STACKS
// Halten Funktionen. Keine Ausführungslogik.
// ─────────────────────────────────────────────────────────────────────────────

// SimpleStack — Set-Semantik, O(1) add/delete, Einfügungsreihenfolge
const SimpleStack = () => {
  const _entries = new Set()

  const add = (handlerFn) => {
    _entries.add(handlerFn)
    // Gibt off()-Funktion zurück — Cleanup-Pattern durchgehend im Framework
    return () => _entries.delete(handlerFn)
  }

  const remove = (handlerFn) => _entries.delete(handlerFn)

  const toArray = () => [..._entries]

  return { add, remove, toArray, get size() { return _entries.size } }
}


// PrioStack — nach Priorität sortiert (höher = früher), lazy Cache
// Wird für IN/OUT-Pipelines genutzt wo Reihenfolge kritisch ist (SIGN vor STORE etc.)
const PrioStack = () => {
  const _entries  = []      // [{ handlerFn, priority, _entryId }]
  let   _cache    = null    // null = Cache ungültig, wird bei toArray() neu gebaut
  let   _nextId   = 0

  const add = (handlerFn, priority = 50) => {
    const entryId = _nextId++
    _entries.push({ handlerFn, priority, _entryId: entryId })
    // Höhere Priorität zuerst — stabiles Sort über _entryId bei Gleichstand
    _entries.sort((entryA, entryB) =>
      entryB.priority !== entryA.priority
        ? entryB.priority - entryA.priority
        : entryA._entryId - entryB._entryId   // Einfügungsreihenfolge bei gleicher Prio
    )
    _cache = null
    // off() via closure über entryId — kein externer Index nötig
    return () => {
      const index = _entries.findIndex(entry => entry._entryId === entryId)
      if (index >= 0) { _entries.splice(index, 1); _cache = null }
    }
  }

  const remove = (handlerFn) => {
    const index = _entries.findIndex(entry => entry.handlerFn === handlerFn)
    if (index >= 0) { _entries.splice(index, 1); _cache = null }
  }

  const toArray = () => {
    if (!_cache) _cache = _entries.map(entry => entry.handlerFn)
    return _cache
  }

  return { add, remove, toArray, get size() { return _entries.length } }
}


// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — RUNNER
// Pure Funktionen. Nehmen fn-Array + args-Array. Konsistente Signatur:
//   runner(handlerArray, argsArray) → Promise
// ─────────────────────────────────────────────────────────────────────────────

// runAll — ruft alle Handler auf, isoliert Fehler pro Handler
// Geeignet für: Event-Listener, Subscriber, Fire-and-Forget
const runAll = async (handlerArray, argsArray) => {
  for (const handlerFn of handlerArray) {
    try {
      await handlerFn(...argsArray)
    } catch (handlerError) {
      /*DEBUG*/ console.warn('[QuRay:runAll] Handler-Fehler (isoliert):', handlerError)
    }
  }
}


// runBail — erste truthy-Rückgabe stoppt die Chain
// Geeignet für: Permission-Checks, Feature-Detection, first-match-wins
const runBail = async (handlerArray, argsArray) => {
  for (const handlerFn of handlerArray) {
    const result = await handlerFn(...argsArray)
    if (result !== undefined && result !== null && result !== false) return result
  }
  return undefined
}


// runWaterfall — Rückgabe jedes Handlers fließt als erstes Arg zum nächsten
// runWaterfall([f, g, h], [initialValue, ...rest]) → finalValue
// Geeignet für: Transformations-Pipelines, *.get-Hooks
const runWaterfall = async (handlerArray, argsArray) => {
  let [accumulatedValue, ...remainingArgs] = argsArray
  for (const handlerFn of handlerArray) {
    const result = await handlerFn(accumulatedValue, ...remainingArgs)
    // undefined-Rückgabe bedeutet "unverändert weitergeben"
    if (result !== undefined) accumulatedValue = result
  }
  return accumulatedValue
}


// runMiddleware — next()/stop()-Muster mit auto-next-Sicherung
// Handler bekommt: { args, next, stop, index }
//
// WICHTIG — auto-next Verhalten:
//   Wenn ein async Handler weder next() noch stop() aufruft,
//   warnt runMiddleware im Debug-Modus. In Prod wird trotzdem
//   automatisch weitergemacht um Deadlocks zu verhindern.
//   Empfehlung: immer explizit `await next()` aufrufen.
//
// Geeignet für: Pipeline-Middleware, *.set-Hooks, abortierbare Chains
const runMiddleware = async (handlerArray, argsArray) => {
  let _isStopped = false

  const executeStep = async (stepIndex) => {
    if (_isStopped || stepIndex >= handlerArray.length) return

    let _wasNextCalled = false
    let _wasStopCalled = false

    const next = async () => {
      if (!_wasNextCalled) {
        _wasNextCalled = true
        await executeStep(stepIndex + 1)
      }
    }

    const stop = () => {
      _wasStopCalled = true
      _isStopped     = true
    }

    await handlerArray[stepIndex]({ args: argsArray, next, stop, index: stepIndex })

    // Auto-next: Deadlock-Schutz wenn Handler vergisst next() aufzurufen
    if (!_isStopped && !_wasNextCalled && !_wasStopCalled) {
      /*DEBUG*/ console.warn( '[QuRay:runMiddleware] Handler an Index', stepIndex, 'hat weder next() noch stop() aufgerufen — auto-next aktiv.', 'Explizites await next() empfohlen um diesen Warn zu vermeiden.' )
      await executeStep(stepIndex + 1)
    }
  }

  return executeStep(0)
}


// ─────────────────────────────────────────────────────────────────────────────
// WILDCARD-MATCHER
// Einzige Wildcard-Implementierung im Framework.
// makeMatcher(sep) → match(patternString, nameString) → boolean
//
// sep='.'  für EventBus-Events:  'peer.hello', 'blob.*', 'data.**'
// sep='/'  für DB-Key-Pfade:     'data/*/msgs/**', 'sys/peers/*'
//
// Pattern-Syntax:
//   exact:  'a.b.c'    matcht genau diesen String
//   *:      'a.*.c'    matcht exakt ein Segment
//   **:     'a.**'     matcht 0..n Segmente (auch am Ende)
//   all:    '**'       matcht alles
// ─────────────────────────────────────────────────────────────────────────────
const makeMatcher = (separator = '.') => (patternString, nameString) => {
  if (patternString === nameString || patternString === '**') return true

  const patternSegments = patternString.split(separator)
  const nameSegments    = nameString.split(separator)

  // Rekursiver Matcher — verarbeitet Segment für Segment
  const matchFromIndex = (patternIndex, nameIndex) => {
    // Beide erschöpft → Match
    if (patternIndex === patternSegments.length) return nameIndex === nameSegments.length

    if (patternSegments[patternIndex] === '**') {
      // '**' matcht 0 bis n verbleibende Name-Segmente
      for (let offset = 0; offset <= nameSegments.length - nameIndex; offset++) {
        if (matchFromIndex(patternIndex + 1, nameIndex + offset)) return true
      }
      return false
    }

    // Normales Segment oder '*' (matcht genau eines)
    return (
      nameIndex < nameSegments.length &&
      (patternSegments[patternIndex] === '*' ||
       patternSegments[patternIndex] === nameSegments[nameIndex]) &&
      matchFromIndex(patternIndex + 1, nameIndex + 1)
    )
  }

  return matchFromIndex(0, 0)
}


// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — MANAGER
// Verbinden Stack + Runner. Bieten die öffentliche API.
// ─────────────────────────────────────────────────────────────────────────────

// ── Hook ──────────────────────────────────────────────────────────────────────
// Grundbaustein. Verbindet einen Stack mit einem Runner.
//
//   use(handlerFn, { once, priority })  → off()
//   run(...args)                        → runner(stack.toArray(), args)
//
// Durch den PrioStack als Standard für Pipelines nutzbar,
// durch SimpleStack für reine Event-Listener.
const Hook = (runnerFn, stackInstance = null) => {
  const _stack = stackInstance ?? SimpleStack()

  const use = (handlerFn, { once = false, priority = 50 } = {}) => {
    let offFn
    // once-Wrapper: entfernt sich selbst nach erstem Aufruf
    const wrappedHandler = once
      ? (...callArgs) => { offFn?.(); return handlerFn(...callArgs) }
      : handlerFn
    offFn = _stack.add(wrappedHandler, priority)
    return offFn
  }

  const run = (...args) => runnerFn(_stack.toArray(), args)

  return {
    use,
    remove: (handlerFn) => _stack.remove(handlerFn),
    run,
    get size() { return _stack.size },
  }
}


// ── Signal ────────────────────────────────────────────────────────────────────
// Reaktiver Wert. Kombination aus Wert + Hook(runAll).
//
//   get()                   → aktueller Wert (synchron!)
//   set(newValue)           → Wert setzen + alle Subscriber benachrichtigen
//   update(transformFn)     → transformFn(aktuell) → set(result)
//   on(callbackFn, callNow) → off()   callNow=true: sofort mit aktuellem Wert
//
// Bewusst KEIN Signal.computed (Memory-Leak-Risiko ohne Compiler-Support).
// Explizite Abhängigkeiten via on() sind lesbarer und sicherer.
const Signal = (initialValue, stackInstance = null) => {
  const _hook       = Hook(runAll, stackInstance)
  let   _currentVal = initialValue

  const get = () => _currentVal

  const set = async (newValue) => {
    _currentVal = newValue
    /*DEBUG*/ console.debug('[QuRay:Signal] set →', newValue)
    return _hook.run(newValue)
  }

  const update = async (transformFn) => {
    _currentVal = transformFn(_currentVal)
    /*DEBUG*/ console.debug('[QuRay:Signal] update →', _currentVal)
    return _hook.run(_currentVal)
  }

  const on = (callbackFn, callNow = false) => {
    const offFn = _hook.use(callbackFn)
    if (callNow) {
      try { callbackFn(_currentVal) }
      catch (immediateError) {
        /*DEBUG*/ console.warn('[QuRay:Signal] Fehler in sofort-Callback:', immediateError)
      }
    }
    return offFn
  }

  // Effect: läuft sofort und bei jeder Änderung
  // Gibt stop()-Funktion zurück — Aufrufer ist für Cleanup verantwortlich
  const effect = (effectFn) => {
    try { effectFn(_currentVal) } catch (e) {
      /*DEBUG*/ console.warn('[QuRay:Signal:effect]', e)
    }
    return on(effectFn)
  }

  return {
    get,
    set,
    update,
    on,
    effect,
    // Shortcut: Wert direkt lesbar als .value (für kompakten App-Code)
    get value() { return _currentVal },
  }
}


// ── EventBus ──────────────────────────────────────────────────────────────────
// Benannte Events mit Wildcard-Pattern-Matching.
// sep konfigurierbar: '.' für Events, '/' für DB-Key-Pfade.
//
//   on(pattern, handlerFn, opts)  → off()
//   once(pattern, handlerFn)      → off()
//   emit(eventName, ...args)      → Promise
//   off(pattern)                  → alle Handler für dieses Pattern entfernen
//   has(pattern)                  → boolean
//
// Intern: Map<pattern → Hook>
// Pattern-Cache wird bei on()/off() invalidiert.
/**
 * Hierarchical pub/sub event bus with glob pattern matching.
 * Used internally by QuDB for reactive db.on() subscriptions.
 * Supports * (one segment) and ** (recursive) wildcards.
 * Transport-agnostic — no DOM dependency, works in Node.js and Workers.
 *
 * @param {object} [options]
 * @param {string} [options.separator='/'] - Key segment separator
 * @returns {EventBusInstance} - { on, once, emit, off, has }
 * @group Database
 * @since 0.1.0
 *
 * @example
 * const bus = EventBus({ separator: '/' })
 * const off = bus.on('~pub/**', (val, ctx) => console.log(ctx.key, val))
 * await bus.emit('~pub/alias', { data: 'Alice' }, { key: '~pub/alias' })
 * off()  // always unsubscribe
 */
const EventBus = ({ separator = '.', stackFactory = () => SimpleStack(), runnerFn = runAll } = {}) => {
  const _patternMap  = new Map()    // pattern → Hook-Instanz
  const _matchFn     = makeMatcher(separator)

  // Hook für Pattern lazy erstellen
  const _getOrCreateHook = (pattern) => {
    if (!_patternMap.has(pattern)) {
      _patternMap.set(pattern, Hook(runnerFn, stackFactory()))
    }
    return _patternMap.get(pattern)
  }

  const on = (pattern, handlerFn, opts = {}) => {
    const offFn = _getOrCreateHook(pattern).use(handlerFn, opts)
    return () => {
      offFn()
      // Leere Hook-Instanzen aufräumen um Memory-Leaks zu verhindern
      if (_patternMap.get(pattern)?.size === 0) _patternMap.delete(pattern)
    }
  }

  const once = (pattern, handlerFn) => on(pattern, handlerFn, { once: true })

  const emit = async (eventName, ...args) => {
    /*DEBUG*/ console.debug('[QuRay:EventBus] emit:', eventName, args)
    const results = []
    for (const [pattern, hookInstance] of _patternMap) {
      // Fast path: exact match or catch-all skip full regex
      if (pattern === eventName || pattern === '**') {
        const result = await hookInstance.run(...args)
        if (result !== undefined) results.push(result)
        if (pattern === eventName) continue  // exact match — no need to check others with same pattern
      } else if (_matchFn(pattern, eventName)) {
        const result = await hookInstance.run(...args)
        if (result !== undefined) results.push(result)
      }
    }
    return results.length === 1 ? results[0]
         : results.length > 1  ? results
         : undefined
  }

  const off = (pattern) => _patternMap.delete(pattern)

  const has = (pattern) => _patternMap.has(pattern)

  return {
    on,
    once,
    emit,
    off,
    has,
    // Introspection (für Debugging + Tests)
    patterns:  () => [..._patternMap.keys()],
    listenerCount: (pattern) => _patternMap.get(pattern)?.size ?? 0,
    // Matcher direkt zugänglich — wird von StorageMount und Tests genutzt
    match: _matchFn,
  }
}


// ── suffixRunner ──────────────────────────────────────────────────────────────
// Konvention: letzter Namens-Abschnitt bestimmt den Runner.
// Ermöglicht EventBus mit gemischten Runner-Strategien pro Event-Typ.
//
//   *.get   → runWaterfall   (Wert-Transformation, Rückgabe fließt weiter)
//   *.set   → runMiddleware  (validierbar, abortierbar)
//   *.call  → runMiddleware  (hookbare Methode)
//   *.on    → runAll         (pure Listener, Fehler isoliert)
//   *       → runAll         (default)
const suffixRunner = (suffix) => ({
  get:  runWaterfall,
  set:  runMiddleware,
  call: runMiddleware,
  on:   runAll,
}[suffix] ?? runAll)


// ─────────────────────────────────────────────────────────────────────────────
// PRIORITÄTS-KONSTANTEN
// Exportiert damit Plugins keine Magic Numbers nutzen müssen.
// Reihenfolge ist kritisch — Kommentare erklären warum.
// ─────────────────────────────────────────────────────────────────────────────
const PIPELINE_PRIORITY = {
  // IN-Pipeline (eingehend: Netz → DB)
  VERIFY:       80,   // Signatur prüfen — zuerst, stop() bei Fehler
  STORE_IN:     60,   // in DB schreiben — nach Verifikation
  DISPATCH_IN:  50,   // db.on() feuern — nach Store (UI sieht valide Daten)

  // OUT-Pipeline (ausgehend: App → Netz)
  E2E:          75,   // Verschlüsseln — VOR sign! Signatur über EncData.
  SIGN:         70,   // ECDSA signieren — nach E2E, vor Store
  STORE_OUT:    60,   // signierte MSG in DB — nach Sign, gleiche Prio wie STORE_IN
  DISPATCH_OUT: 49,   // db.on() feuern — nach Store (49 < 50 = nach DISPATCH_IN)
  PKG:          20,   // NET-PKG wrapper {to, ttl, payload}
  SEND:         10,   // Transport.send() — immer letzter Schritt

  // Sync-OUT hook (QuSync plugs in here — runs AFTER dispatch so db.on() already fired)
  SYNC_OUT:      5,   // Enqueue pending QuBit into sync queue — always last
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export {
  // Layer 0 — Stacks
  SimpleStack,
  PrioStack,

  // Layer 1 — Runner (pure Funktionen)
  runAll,
  runBail,
  runWaterfall,
  runMiddleware,

  // Matcher — einzige Wildcard-Implementierung
  makeMatcher,

  // Layer 2 — Manager
  // Hook(runMiddleware, PrioStack()) direkt für IN/OUT-Pipelines nutzen —
  // das ist expliziter als ein Pipeline-Wrapper und spart Code.
  Hook,
  Signal,
  EventBus,
  suffixRunner,

  // Konstanten
  PIPELINE_PRIORITY,
}
