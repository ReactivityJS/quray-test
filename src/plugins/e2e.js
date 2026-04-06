// ════════════════════════════════════════════════════════════════════════════
// QuRay — middleware/e2e.js
// OUT-Pipeline: Ende-zu-Ende-Verschlüsselung — optionales Plugin.
//
// Priorität: PIPELINE_PRIORITY.E2E (75)
//   → VOR SIGN (70): Signatur wird über das verschlüsselte data berechnet.
//     Empfänger verifiziert Signatur → entschlüsselt data. Konsistent.
//   → VOR STORE (60): DB enthält signierte EncData (history-decrypt beim Laden).
//
// Verschlüsselt msg.data wenn:
//   pipelineContext.encTarget gesetzt (epub des Empfängers)
//   ODER ctx.to gesetzt und epub des Empfängers in PeerStore bekannt
//
// PeerStore: Funktion die (pub) → epub auflöst.
//   Kann sys/peers/{pubSeg} aus QuDB sein oder ein externes Peer-Verzeichnis.
//
// Inbound-Decrypt:
//   Eingehende verschlüsselte QuBits bleiben in der DB verschlüsselt.
//   Entschlüsselung on-demand via db.get(key, { decrypt: true }).
//   → DecryptPlugin (in dieser Datei) als optionaler IN-Plugin für auto-decrypt.
//
// Plugin-Interface: E2EPlugin(identity, options?) → (db) => offFn
// ════════════════════════════════════════════════════════════════════════════

import { PIPELINE_PRIORITY } from '../core/events.js'
import { isEncryptedData }   from '../core/qubit.js'


// ── E2EPlugin ────────────────────────────────────────────────────────────
// Verschlüsselt ausgehende QuBits wenn Empfänger-epub bekannt ist.
/**
 * End-to-end encryption middleware. Encrypts outgoing QuBits for a specific
 * recipient using ECDH key agreement + AES-GCM. Decrypts incoming encrypted
 * QuBits automatically.
 *
 * @param {Identity} identity - Local identity for key derivation
 * @param {object} [config]
 * @returns {PluginFactory}
 * @group Plugin
 * @since 0.1.0
 *
 * @example
 * // Use enc option on db.put() to encrypt for a recipient:
 * await db.put('@dm/chat/001', { text: 'Secret!' }, {
 *   enc: peerEpub,  // recipient's ECDH public key
 * })
 */
const E2EPlugin = (identityInstance, options = {}) => (db) => {
  // peerEpubResolver: async (recipientPub) → epub | null
  // Default: aus sys/peers/{pubSeg} in QuDB lesen
  const resolvePeerEpub = options.peerEpubResolver ?? (async (recipientPub) => {
    const { pubSeg } = await import('../qubit.js')
    const peerInfo   = await db.get('sys/peers/' + pubSeg(recipientPub))
    return peerInfo?.epub ?? null
  })

  const offFn = db.useOut(async ({ args: [pipelineContext], next }) => {
    const { qubit, encTarget } = pipelineContext

    // Kein Empfänger oder bereits verschlüsselt → überspringen
    if (!pipelineContext.to && !encTarget) {
      await next()
      return
    }

    if (isEncryptedData(qubit.data)) {
      /*DEBUG*/ console.debug('[QuRay:E2EPlugin] data bereits verschlüsselt — übersprungen:', qubit.type)
      await next()
      return
    }

    if (qubit.data == null) {
      await next()
      return
    }

    // epub auflösen: direkt übergeben > ctx.to nachschlagen
    const recipientEpub = encTarget ?? await resolvePeerEpub(pipelineContext.to)

    if (!recipientEpub) {
      /*DEBUG*/ console.warn('[QuRay:E2EPlugin] epub nicht gefunden für Empfänger:', pipelineContext.to?.slice(0, 16) + '…', '— QuBit unverschlüsselt')
      await next()
      return
    }

    // Verschlüsseln — data wird durch EncData-Objekt ersetzt
    qubit.data = await identityInstance.encrypt(JSON.stringify(qubit.data), recipientEpub)
    qubit.enc  = 'ecdh-aes-gcm'

    /*DEBUG*/ console.debug('[QuRay:E2EPlugin] QuBit verschlüsselt:', qubit.type, 'für', pipelineContext.to?.slice(0, 16) + '…')
    await next()
  }, PIPELINE_PRIORITY.E2E)

  return offFn
}


// ── DecryptPlugin ────────────────────────────────────────────────────────
// IN-Pipeline: verschlüsselte QuBits automatisch entschlüsseln.
// Opt-in — default ist verschlüsselt in DB, on-demand decrypt via db.get().
//
// Wenn aktiviert: entschlüsselt eingehende QuBits direkt in der IN-Pipeline.
// data im RAM ist dann Plaintext — DB-Eintrag bleibt verschlüsselt.
//
// Priorität: zwischen VERIFY (80) und STORE (60) → Prio 70 macht Sinn,
// aber dann kollidiert es mit SIGN. Da es IN-Pipeline ist kein Problem —
// SIGN läuft nur in OUT. Trotzdem eigenen Wert nehmen um Klarheit zu haben.
const DECRYPT_PRIORITY = 65   // nach VERIFY (80), vor STORE_IN (60)... warte: 65 > 60, also vor Store. Korrekt.

const DecryptPlugin = (identityInstance) => (db) => {
  const offFn = db.useIn(async ({ args: [pipelineContext], next }) => {
    const { qubit } = pipelineContext

    if (!qubit.enc || !isEncryptedData(qubit.data)) {
      await next()
      return
    }

    try {
      const decryptedString = await identityInstance.decrypt(qubit.data)
      // Nur im RAM entschlüsseln — pipelineContext.qubit bekommt Plaintext,
      // aber rawWrite in StoreInPlugin schreibt den ORIGINAL qubit (verschlüsselt).
      // Daher: separates decryptedQubit im Context, rawWrite nutzt den originalen.
      pipelineContext.decryptedData = JSON.parse(decryptedString)
      /*DEBUG*/ console.debug('[QuRay:DecryptPlugin] Entschlüsselt:', qubit.type)
    } catch (decryptError) {
      // Nicht für uns verschlüsselt oder falscher Key — kein Fehler, einfach weiter
      /*DEBUG*/ console.debug('[QuRay:DecryptPlugin] Nicht entschlüsselbar (nicht für uns):', qubit.type, decryptError.message)
    }

    await next()
  }, DECRYPT_PRIORITY)

  return offFn
}


export { E2EPlugin, DecryptPlugin }
