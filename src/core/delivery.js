// ════════════════════════════════════════════════════════════════════════════
// QuRay — core/delivery.js
//
// DeliveryTracker: persistent delivery states for QuBits and blobs.
//
// Stored in conf/delivery/{safeKey} — local only, never synced.
// Uses db._internal.write() directly to avoid recursion through the OUT pipeline.
//
// State model:
//   local -> queued -> relay_in -> peer_sent -> peer_recv -> peer_read
//   blob_local -> blob_relay -> blob_peer
//   failed
//
// The tracker itself is intentionally transport-agnostic. It only stores and
// emits state transitions. QuSync / transports decide when transitions happen.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Enumeration of delivery states for the delivery chain.
 *
 * @group Delivery
 * @since 0.1.0
 */
export const DELIVERY_STATE = {
  LOCAL:      'local',
  QUEUED:     'queued',
  RELAY_IN:   'relay_in',
  PEER_SENT:  'peer_sent',
  PEER_RECV:  'peer_recv',
  PEER_READ:  'peer_read',
  BLOB_LOCAL: 'blob_local',
  BLOB_RELAY: 'blob_relay',
  BLOB_PEER:  'blob_peer',
  FAILED:     'failed',
}

const STATE_ORDER = [
  'local', 'queued', 'relay_in', 'peer_sent', 'peer_recv', 'peer_read',
]

/**
 * Persistent delivery tracker.
 *
 * Callback signature:
 *   on(key, (entry, meta) => {})
 *   onAny((entry, meta) => {})
 *
 * meta contains:
 *   { key, event, current, previous, scope }
 */
export const DeliveryTracker = ({ rawWrite, get, del }) => {

  const _key = (qubitKey) =>
    'conf/delivery/' + qubitKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)

  const _subs = new Map()
  const _anySubs = new Set()

  const _emitToSet = (set, entry, meta) => {
    if (!set?.size) return
    for (const fn of set) {
      try { fn(entry, meta) } catch {}
    }
  }

  const _notify = (qubitKey, entry, meta = {}) => {
    const payload = {
      key: qubitKey,
      scope: 'delivery',
      event: meta.event ?? 'delivery',
      current: entry,
      previous: meta.previous ?? null,
      ...meta,
    }
    _emitToSet(_subs.get(qubitKey), entry, payload)
    _emitToSet(_anySubs, entry, payload)
  }

  const get_ = async (qubitKey) => {
    if (!qubitKey) return null
    const stored = await get(_key(qubitKey))
    return stored?.state ? stored : (stored?.data ?? null)
  }

  const set = async (qubitKey, state, extra = {}) => {
    if (!qubitKey || !state) return null
    const previous = await get_(qubitKey).catch(() => null)
    const entry = { state, ts: Date.now(), ...extra }
    await rawWrite(_key(qubitKey), entry, 'local').catch(() => {})
    _notify(qubitKey, entry, { event: 'delivery-state', previous })
    return entry
  }

  const on = (qubitKey, fn, options = {}) => {
    const { once = false, immediate = true } = options
    if (!_subs.has(qubitKey)) _subs.set(qubitKey, new Set())

    let active = true
    const wrapped = (entry, meta) => {
      if (!active) return
      try { fn(entry, meta) } finally {
        if (once) off()
      }
    }

    _subs.get(qubitKey).add(wrapped)

    if (immediate) {
      get_(qubitKey).then((entry) => {
        if (!active || !entry) return
        wrapped(entry, {
          key: qubitKey,
          scope: 'delivery',
          event: 'delivery-state',
          current: entry,
          previous: null,
        })
      }).catch(() => {})
    }

    const off = () => {
      active = false
      _subs.get(qubitKey)?.delete(wrapped)
      if (_subs.get(qubitKey)?.size === 0) _subs.delete(qubitKey)
    }

    return off
  }

  const onAny = (fn, options = {}) => {
    const { once = false } = options
    let active = true
    const wrapped = (entry, meta) => {
      if (!active) return
      try { fn(entry, meta) } finally {
        if (once) off()
      }
    }
    _anySubs.add(wrapped)
    const off = () => { active = false; _anySubs.delete(wrapped) }
    return off
  }

  const clear = (qubitKey) => qubitKey && del(_key(qubitKey))

  const isAtLeast = async (qubitKey, minState) => {
    const entry = await get_(qubitKey)
    if (!entry?.state) return false
    return STATE_ORDER.indexOf(entry.state) >= STATE_ORDER.indexOf(minState)
  }

  return {
    set,
    get: (qubitKey) => get_(qubitKey),
    on,
    onAny,
    clear,
    isAtLeast,
    STATES: DELIVERY_STATE,
  }
}
