// ════════════════════════════════════════════════════════════════════════════
// QuRay — middleware/store.js
// IN + OUT-Pipeline: QuBits in das Backend schreiben.
//
// Zwei Plugins in einer Datei — gleiche Logik, zwei Richtungen:
//
//   StoreInPlugin  — eingehende QuBits (nach Verifikation) persistieren
//   StoreOutPlugin — ausgehende QuBits (nach Signatur) persistieren
//
// Beide nutzen db._internal.write() um die Pipeline nicht nochmal zu durchlaufen.
//
// NO_STORE_TYPES werden in beiden Richtungen übersprungen —
// Signaling und Protokoll-Msgs sind flüchtig.
//
// Konflikt-Strategie (Last-Write-Wins):
//   Eingehender QuBit gewinnt wenn ts >= lokaler ts.
//   Konfigurierbar via config.conflictStrategy.
//
// Plugin-Interface: StoreInPlugin(config?) → (db) => offFn
//                   StoreOutPlugin(config?) → (db) => offFn
// ════════════════════════════════════════════════════════════════════════════

import { PIPELINE_PRIORITY } from '../core/events.js'
import { NO_STORE_TYPES, cleanQuBitForTransport } from '../core/qubit.js'


// Standard Last-Write-Wins: eingehender QuBit gewinnt bei höherem oder gleichem ts
const _defaultConflictStrategy = (localQuBit, incomingQuBit) =>
  incomingQuBit.ts >= localQuBit.ts ? incomingQuBit : localQuBit


// ── StoreInPlugin ─────────────────────────────────────────────────────────
// Eingehende QuBits nach Verifikation in DB schreiben.
// Konflikt-Auflösung: lokal vs. eingehend per conflictStrategy.
/**
 * Middleware plugin that persists incoming (remote) QuBits to the backend.
 * Uses Last-Write-Wins conflict resolution (configurable).
 * Sets QuBit._status = 'synced' after storage.
 *
 * @param {object} [config]
 * @param {function} [config.conflictStrategy] - (local, incoming) → winner QuBit
 * @returns {PluginFactory}
 * @group Plugin
 * @since 0.1.0
 */
const StoreInPlugin = (config = {}) => (db) => {
  const resolveConflict = config.conflictStrategy ?? _defaultConflictStrategy

  const offFn = db.useIn(async ({ args: [pipelineContext], next }) => {
    const { qubit } = pipelineContext
    pipelineContext.previous = await db.get(qubit.key).catch(() => null)

    // Signaling- und Protokoll-Typen nie persistieren
    if (NO_STORE_TYPES.has(qubit.type)) {
      await next()
      return
    }

    // Konflikt-Prüfung: existiert bereits ein neuerer lokaler Eintrag?
    const existingQuBit = await db.get(qubit.key)
    if (existingQuBit) {
      const winnerQuBit = resolveConflict(existingQuBit, qubit)
      if (winnerQuBit.id !== qubit.id) {
        /*DEBUG*/ console.debug('[QuRay:StoreInPlugin] Konflikt: lokaler QuBit gewinnt (LWW):', qubit.key, 'local.ts:', existingQuBit.ts, 'incoming.ts:', qubit.ts)
        // Lokaler gewinnt — eingehenden verwerfen, aber Pipeline weiter
        await next()
        return
      }
    }

    // Lokale Metadaten setzen bevor wir schreiben
    const qubitToStore = {
      ...qubit,
      _status:  'synced',    // von Netz gekommen = bereits synced
      _localTs: Date.now(),
    }

    await db._internal.write(qubit.key, qubitToStore, 'sync')

    /*DEBUG*/ console.debug('[QuRay:StoreInPlugin] stored (sync):', qubit.type, qubit.key)
    await next()
  }, PIPELINE_PRIORITY.STORE_IN)

  return offFn
}


// ── StoreOutPlugin ────────────────────────────────────────────────────────
// Ausgehende QuBits nach Signatur in DB schreiben.
// Speichert nur kanonische Felder + sig — keine internen _-Felder in DB.
/**
 * Middleware plugin that persists outgoing (local) QuBits to the backend.
 * Sets QuBit._status = 'pending' and triggers DeliveryTracker 'local' state.
 *
 * @returns {PluginFactory}
 * @group Plugin
 * @since 0.1.0
 */
const StoreOutPlugin = () => (db) => {
  const offFn = db.useOut(async ({ args: [pipelineContext], next }) => {
    const { qubit, syncMode } = pipelineContext
    pipelineContext.previous = await db.get(qubit.key).catch(() => null)

    if (NO_STORE_TYPES.has(qubit.type)) {
      await next()
      return
    }

    // _status abhängig von syncMode setzen
    const syncStatus = syncMode === false ? 'local'   // nur lokal, kein Sync
                     : syncMode === 'lazy' ? 'pending' // Sync beim nächsten Connect
                     : 'pending'                       // sofort sync (default)

    const qubitToStore = {
      ...qubit,
      _status:  syncStatus,
      _localTs: Date.now(),
    }

    await db._internal.write(qubit.key, qubitToStore, 'local')

    // Track delivery state: QuBit is now stored locally.
    // Skip conf/ keys: delivery states ARE stored under conf/ and must not track themselves.
    if (!qubit.key.startsWith('conf/')) {
      db._internal.delivery?.set(qubit.key, 'local').catch(() => {})
    }

    // Pipelinecontext aktualisieren damit nachfolgende Middleware den Status kennt
    pipelineContext.qubit = qubitToStore

    /*DEBUG*/ console.debug('[QuRay:StoreOutPlugin] stored (local):', qubit.type, qubit.key, syncStatus)
    await next()
  }, PIPELINE_PRIORITY.STORE_OUT)

  return offFn
}


export { StoreInPlugin, StoreOutPlugin }
