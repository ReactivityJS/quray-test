// ════════════════════════════════════════════════════════════════════════════
// QuRay — middleware/verify.js
// IN-Pipeline: Signatur-Verifikation jedes eingehenden QuBit.
//
// Priorität: PIPELINE_PRIORITY.VERIFY (80) — immer zuerst in der IN-Pipeline.
//   → stop() bei Fehler: ungültige QuBits werden nie in die DB geschrieben
//   → _relayDelivered Flag: blob.chunk und andere raw-WS-Pakete überspringen
//     Signatur-Check (Integrität via SHA-256 beim Reassemble)
//
// Plugin-Interface: VerifyPlugin(identity) → (db) => offFn
// ════════════════════════════════════════════════════════════════════════════

import { PIPELINE_PRIORITY } from '../core/events.js'
import { canonicalizeQuBit, NO_STORE_TYPES } from '../core/qubit.js'


/**
 * IN-pipeline: verifies ECDSA signatures of incoming QuBits.
 * Stops pipeline if signature is invalid or missing.
 * @param {Identity} identityInstance - Local identity with verify() method
 * @returns {PluginFactory} (db) => offFn
 * @group Plugin
 * @since 0.1.0
 */
const VerifyPlugin = (identityInstance) => (db) => {
  const offFn = db.useIn(async ({ args: [pipelineContext], next, stop }) => {
    const { qubit } = pipelineContext

    if (!qubit?.sig || !qubit?.from) {
      // Signaling-Typen (peer.hello, peer.bye, webrtc.*, etc.) haben keine Signatur
      // und werden nie persistiert — explizit erlaubt.
      if (NO_STORE_TYPES.has(qubit?.type)) {
        await next()
        return
      }
      // Persistierbare Typen (data, msg, blob.meta, …) MÜSSEN eine Signatur haben.
      // Ein QuBit ohne sig/from könnte manipuliert oder korrupt sein.
      /*DEBUG*/ console.warn('[QuRay:VerifyPlugin] Unsigned persistable QuBit rejected:', qubit?.type, qubit?.key?.slice(0, 32))
      stop()
      return
    }

    const isSignatureValid = await identityInstance.verify(
      canonicalizeQuBit(qubit),
      qubit.sig,
      qubit.from   // Public Key des Absenders
    )

    if (!isSignatureValid) {
      /*DEBUG*/ console.warn('[QuRay:VerifyPlugin] Ungültige Signatur — QuBit abgewiesen:', qubit.type, 'from:', qubit.from?.slice(0, 16) + '…')
      stop()
      return
    }

    /*DEBUG*/ console.debug('[QuRay:VerifyPlugin] Signatur OK:', qubit.type, qubit.id?.slice(0, 8))
    await next()
  }, PIPELINE_PRIORITY.VERIFY)

  return offFn
}


export { VerifyPlugin }
