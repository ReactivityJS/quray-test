// ════════════════════════════════════════════════════════════════════════════
// QuRay — middleware/sign.js
// OUT-Pipeline: ECDSA-Signatur für jedes ausgehende QuBit.
//
// Priorität: PIPELINE_PRIORITY.SIGN (70)
//   → nach E2E (75): Signatur wird über verschlüsseltem data berechnet
//   → vor STORE (60): DB enthält immer die signierte Version
//
// Plugin-Interface: SignPlugin(identity) → (db) => offFn
// ════════════════════════════════════════════════════════════════════════════

import { PIPELINE_PRIORITY } from '../core/events.js'
import { canonicalizeQuBit } from '../core/qubit.js'


/**
 * OUT-pipeline: attaches ECDSA signature to every outgoing QuBit.
 * Skips NO_STORE_TYPES. Runs after StoreOutPlugin.
 * @param {Identity} identityInstance - Local identity with sign() method
 * @returns {PluginFactory} (db) => offFn
 * @group Plugin
 * @since 0.1.0
 * @example
 * db.use(SignPlugin(identity))  // automatic via QuRay.init()
 */
const SignPlugin = (identityInstance) => (db) => {
  const offFn = db.useOut(async ({ args: [pipelineContext], next }) => {
    const { qubit } = pipelineContext

    if (!identityInstance?.pub) {
      /*DEBUG*/ console.warn('[QuRay:SignPlugin] no identity loaded - storing QuBit without signature')
      await next()
      return
    }

    // Kanonischen String signieren — exakte Feldreihenfolge aus qubit.js
    qubit.sig  = await identityInstance.sign(canonicalizeQuBit(qubit))
    qubit.from = qubit.from || identityInstance.pub

    /*DEBUG*/ console.debug('[QuRay:SignPlugin] QuBit signiert:', qubit.type, qubit.id?.slice(0, 8))
    await next()
  }, PIPELINE_PRIORITY.SIGN)

  return offFn
}


export { SignPlugin }
