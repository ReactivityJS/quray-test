// ════════════════════════════════════════════════════════════════════════════
// QuRay — src/push.js
//
// Push-Subscription-Helper.
//
// Kapselt den gesamten Web-Push-Flow:
//   1. VAPID-Public-Key vom Relay laden
//   2. PushManager.subscribe()
//   3. Subscription an Relay melden (POST /api/push/subscribe)
//   4. Filter setzen (alle / nur DMs / aus)
//
// Nutzung:
//   import { PushHelper } from '../src/push.js'
//
//   const push = PushHelper(qr)
//
//   // Einmalig bei App-Start: Status prüfen
//   const status = await push.status()
//   // { enabled: bool, subscription: PushSubscription|null, supported: bool }
//
//   // Aktivieren (löst Browser-Permission-Dialog aus)
//   await push.subscribe({ mode: 'all', preview: true })
//
//   // Deaktivieren
//   await push.unsubscribe()
//
//   // Filter ändern ohne erneutes Subscribe
//   await push.setFilter('dm')   // 'all' | 'dm' | 'off'
//
// Push-Modes:
//   'all'  — alle Nachrichten die für mich sind
//   'dm'   — nur direkte Nachrichten (kein Space-Broadcast)
//   'off'  — Push deaktiviert (Subscription bleibt aber erhalten)
//
// Technische Details:
//   · VAPID-Key wird vom Relay unter GET /api/push/vapid-public-key geliefert
//   · Subscription JSON wird an POST /api/push/subscribe geschickt
//   · Relay speichert pro pub eine JSON-Datei unter quray-data/push/
//   · SW empfängt Push → Notification zeigen → _performDeltaSync() → App
//
// Debug-Logging: /*DEBUG*/ markierte Zeilen → Strip in Prod-Build.
// ════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// PUSH HELPER FACTORY
//
//   PushHelper(qr) → helperInstance
//
// qr muss init() abgeschlossen haben (me.pub + me.epub verfügbar).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Web Push notification helper. Manages Service Worker registration, push
 * subscription, and server-side VAPID key negotiation.
 *
 * Push notifications require:
 *   1. HTTPS (or localhost)
 *   2. Service Worker (sw.js in root)
 *   3. Relay with web-push npm package + VAPID keys configured
 *
 * The relay's /api/push/vapid-public-key endpoint is checked before subscribing.
 * If the relay doesn't support push, status() returns { serverEnabled: false }.
 *
 * @param {QuRayInstance} qr - QuRay instance
 * @returns {PushHelperInstance} - { status, registerSW, subscribe, unsubscribe }
 * @group QuRay
 * @since 0.1.0
 *
 * @example
 * const push = PushHelper(qr)
 * await push.registerSW({ swUrl: '/sw.js' })
 *
 * const st = await push.status()
 * if (st.serverEnabled && st.supported) {
 *   await push.subscribe({ mode: 'dm' })  // 'all' | 'dm' | 'off'
 * }
 *
 * @example
 * // In your settings UI:
 * const { supported, enabled, serverEnabled, reason } = await push.status()
 * if (!serverEnabled) showMessage(reason)
 */
const PushHelper = (qr) => {

  // Relay-HTTP-URL aus aktiver WS-Verbindung ableiten
  const _relayHttpUrl = () => {
    const relays = qr.relays
    if (!relays?.length) throw new Error('PushHelper: kein Relay verbunden')
    return relays[0].url.replace(/^wss?:\/\//, m => m === 'wss://' ? 'https://' : 'http://')
  }


  // ── VAPID-Key vom Relay laden ─────────────────────────────────────────────

  let _vapidKey = null   // gecacht nach erstem Laden

  const getVapidKey = async () => {
    if (_vapidKey) return _vapidKey
    const httpBase = _relayHttpUrl()
    const res      = await fetch(`${httpBase}/api/push/vapid-public-key`)
    if (!res.ok) throw new Error(`VAPID-Key: HTTP ${res.status}`)
    const json = await res.json()
    if (!json.enabled || !json.vapidPublicKey) {
      throw new Error(
        json.enabled === false
          ? 'Push nicht aktiviert: web-push Paket auf dem Relay fehlt (npm install web-push)'
          : 'VAPID-Key: leer — Relay-Konfiguration prüfen'
      )
    }
    _vapidKey = json.vapidPublicKey
    return _vapidKey
  }


  // ── Service-Worker-Registration laden ────────────────────────────────────

  const _getSwReg = () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service Worker nicht unterstützt')
    return navigator.serviceWorker.ready
  }


  // ── URL-safe Base64 → Uint8Array (für applicationServerKey) ──────────────

  const _base64urlToUint8 = (base64url) => {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      base64url.length + (4 - base64url.length % 4) % 4, '='
    )
    return new Uint8Array(atob(base64).split('').map(c => c.charCodeAt(0)))
  }


  // ── Status prüfen ─────────────────────────────────────────────────────────

  const status = async () => {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window
    if (!supported) return { supported: false, enabled: false, subscription: null, serverEnabled: false }

    // Check if server supports push
    let serverEnabled = false
    try {
      const httpBase = _relayHttpUrl()
      const res = await fetch(`${httpBase}/api/push/vapid-public-key`)
      if (res.ok) { const j = await res.json(); serverEnabled = !!j.enabled && !!j.vapidPublicKey }
    } catch { serverEnabled = false }

    if (!serverEnabled) {
      return { supported: false, enabled: false, subscription: null, serverEnabled: false,
               reason: 'Server-Push nicht verfügbar (web-push fehlt auf Relay)' }
    }

    try {
      const reg     = await _getSwReg()
      const sub     = await reg.pushManager.getSubscription()
      const enabled = sub !== null
      return { supported: true, enabled, subscription: sub, serverEnabled: true }
    } catch (e) {
      /*DEBUG*/ console.warn('[QuRay:PushHelper] status Fehler:', e.message)
      return { supported: true, enabled: false, subscription: null, serverEnabled: true }
    }
  }


  // ── Push aktivieren ───────────────────────────────────────────────────────
  //
  // options.mode     'all' | 'dm' | 'off'   (default: 'all')
  // options.preview  true → Nachrichtenvorschau in Notification
  //
  // Löst den Browser-Permission-Dialog aus wenn noch keine Erlaubnis.
  // Wirft wenn Erlaubnis verweigert.

  const subscribe = async (options = {}) => {
    const { mode = 'all', preview = true } = options

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('Push Notifications werden nicht unterstützt')
    }

    // Erlaubnis prüfen / anfragen
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      throw new Error('Push-Erlaubnis verweigert')
    }

    const vapidKey = await getVapidKey()
    const reg      = await _getSwReg()

    // Subscription erstellen (oder vorhandene zurückbekommen)
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly:    true,
      applicationServerKey: _base64urlToUint8(vapidKey),
    })

    /*DEBUG*/ console.info('[QuRay:PushHelper] Subscribe:', subscription.endpoint.slice(0, 60) + '…')

    // Beim Relay registrieren
    const httpBase = _relayHttpUrl()
    const res      = await fetch(`${httpBase}/api/push/subscribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pub:          qr.me.pub,
        subscription: subscription.toJSON(),
        filter:       { mode, preview },
      }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(`Relay-Subscribe fehlgeschlagen: ${res.status} ${body.error ?? ''}`)
    }

    /*DEBUG*/ console.info('[QuRay:PushHelper] Subscribe OK, mode:', mode)
    return subscription
  }


  // ── Push deaktivieren ─────────────────────────────────────────────────────

  const unsubscribe = async () => {
    const reg = await _getSwReg()
    const sub = await reg.pushManager.getSubscription()

    if (sub) {
      await sub.unsubscribe()
    }

    // Relay informieren
    const httpBase = _relayHttpUrl()
    await fetch(`${httpBase}/api/push/unsubscribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pub: qr.me.pub }),
    }).catch(() => {})  // best-effort — Relay löscht Subscription beim nächsten Fehler sowieso

    /*DEBUG*/ console.info('[QuRay:PushHelper] Unsubscribe OK')
  }


  // ── Filter ändern ─────────────────────────────────────────────────────────
  //
  // Ändert den Filter ohne erneutes Subscribe.
  // mode: 'all' | 'dm' | 'off'

  const setFilter = async (mode, preview = true) => {
    const httpBase = _relayHttpUrl()
    const res      = await fetch(`${httpBase}/api/push/filter`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pub: qr.me.pub, filter: { mode, preview } }),
    })
    if (!res.ok) throw new Error(`setFilter fehlgeschlagen: ${res.status}`)
    /*DEBUG*/ console.info('[QuRay:PushHelper] Filter gesetzt:', mode)
  }


  // ── SW-Konfiguration aktualisieren ────────────────────────────────────────
  //
  // Sendet aktuelle Konfiguration (Prefixes etc.) an den SW.
  // Wird automatisch von QuSync aufgerufen — kann aber auch manuell
  // aufgerufen werden wenn sich Sync-Prefixes ändern (z.B. nach Space.join).

  const updateSwConfig = async (extraPrefixes = []) => {
    if (!('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg?.active) return

    const corePrefixes = [`~${qr.me.pub}/`, `>${qr.me.pub}/`]
    const allPrefixes  = [...new Set([...corePrefixes, ...extraPrefixes])]

    reg.active.postMessage({
      type:     'sw.setConfig',
      relayUrl: _relayHttpUrl(),
      pub:      qr.me.pub,
      dbName:   'quray-' + qr.me.pub.slice(0, 12).replace(/[+/=]/g, '_'),
      prefixes: allPrefixes,
    })

    /*DEBUG*/ console.debug('[QuRay:PushHelper] SW config aktualisiert, prefixes:', allPrefixes.length)
  }


  // ── SW registrieren ───────────────────────────────────────────────────────
  //
  // Registriert den Service Worker.
  // Muss einmalig aufgerufen werden, üblicherweise in QuRay.init() oder App-Bootstrap.
  //
  // options.swUrl  Pfad zum SW (default: '/sw.js')
  // options.scope  SW-Scope (default: '/')

  const registerSW = async (options = {}) => {
    if (!('serviceWorker' in navigator)) return null

    const { swUrl = '/sw.js', scope = '/' } = options

    try {
      const reg = await navigator.serviceWorker.register(swUrl, { scope })
      /*DEBUG*/ console.info('[QuRay:PushHelper] SW registriert:', swUrl)

      // Nach Registrierung Konfiguration senden
      await reg.ready
      await updateSwConfig()

      return reg
    } catch (e) {
      /*DEBUG*/ console.warn('[QuRay:PushHelper] SW-Registrierung fehlgeschlagen:', e.message)
      return null
    }
  }


  // ── Local notification (for calls/alerts when tab visible) ──────────────
  // Uses SW showNotification for consistent behavior across platforms.
  const notify = async ({ title, body, tag, requireInteraction = false, data = {} } = {}) => {
    if (!('Notification' in window)) return
    const permission = Notification.permission
    if (permission !== 'granted') return

    try {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg) {
        await reg.showNotification(title || 'QuRay', {
          body, tag, requireInteraction,
          icon:  '/icon.png',
          badge: '/badge.png',
          data,
        })
      } else {
        new Notification(title || 'QuRay', { body, tag, requireInteraction })
      }
    } catch {
      new Notification(title || 'QuRay', { body, tag, requireInteraction })
    }
  }

  return {
    status,         // → { supported, enabled, subscription }
    subscribe,      // (opts?) → Promise<PushSubscription>
    unsubscribe,    // () → Promise<void>
    setFilter,      // (mode, preview?) → Promise<void>
    updateSwConfig, // (extraPrefixes?) → Promise<void>
    registerSW,     // (opts?) → Promise<ServiceWorkerRegistration|null>
    getVapidKey,    // () → Promise<string>
    notify,         // ({ title, body, tag, requireInteraction }) → Promise<void>
  }
}


export { PushHelper }
