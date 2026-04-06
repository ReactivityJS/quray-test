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
import { canonicalizeQuBit } from '../core/qubit.js'


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

    // Signaling-Typen (peer.hello, peer.bye, webrtc.*, etc.) haben keine Signatur
    // und werden nie persistiert — einfach durchlassen
    if (!qubit?.sig || !qubit?.from) {
      await next()
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
