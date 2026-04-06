// ════════════════════════════════════════════════════════════════════════════
// QuRay — core/node.js
//
// QuNode: Typed helpers on top of QuDB.
// Knows the Key Schema. Provides ergonomic read/write/watch/list
// for generic nodes AND user nodes (profiles).
//
// QuNode is NOT a new data layer — it is a thin API over db.* that:
//   • Extracts .data from QuBits automatically
//   • Handles key construction
//   • Provides user-node-specific helpers (profile, visibility, props)
//   • Provides inbox/send helpers (delegating to net + db)
//
// Usage:
//   const node = QuNode({ db, me, net, peers })
//   qr.node = node   (mounted in quray.js)
// ════════════════════════════════════════════════════════════════════════════

import { KEY, ts16 } from './qubit.js'
import { pub64 }     from './identity.js'


const QuNode = ({ db, me, net, peers }) => {

  // ── Utilities ──────────────────────────────────────────────────────────────

  // Extract payload value from QuBit or raw value
  const _val = (qubit) => qubit?.data ?? qubit ?? null

  // Normalize any pub-key string to pub64 (url-safe base64)
  const _p64 = (pub) => (pub ?? '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')


  // ── Generic Node API ───────────────────────────────────────────────────────

  /**
   * Write a value to a key. Signed + stored + relay-synced.
   * @param {string} key
   * @param {any} data
   * @param {{ enc?: any, sync?: boolean, type?: string }} [opts]
   */
  const write = (key, data, opts = {}) => db.put(key, data, opts)

  /**
   * Read a value by key. Returns the payload (qubit.data), not the QuBit.
   * Returns null if not found.
   * @param {string} key
   * @returns {Promise<any>}
   */
  const read = async (key) => _val(await db.get(key))

  /**
   * Delete a key.
   * @param {string} key
   */
  const remove = (key) => db.del(key)

  /**
   * Reactive listener for a key or pattern.
   * Callback receives (value, qubit, context).
   * Supports '*' (one segment) and '**' (any segments).
   * Returns cleanup fn.
   * @param {string} keyOrPattern
   * @param {(value: any, qubit: object, ctx: object) => void} fn
   * @returns {() => void}
   */
  const watch = (keyOrPattern, fn) =>
    db.on(keyOrPattern, (qubit, ctx) => fn(_val(qubit), qubit, ctx))

  /**
   * Query all entries under a prefix.
   * Returns [{key, value, qubit}] sorted by ts (default).
   * @param {string} prefix
   * @param {{ limit?: number, order?: 'ts'|'key', since?: number }} [opts]
   * @returns {Promise<Array<{key:string, value:any, qubit:object}>>}
   */
  const list = async (prefix, opts = {}) => {
    const rows = await db.query(prefix, opts)
    return rows.map(q => ({ key: q.key, value: _val(q), qubit: q }))
  }


  // ── User Node API ──────────────────────────────────────────────────────────
  //
  // User Nodes live at ~{pub64}/ in the DB.
  // The root node ~{pub64} = {pub, epub, alias} is written by LocalPeer._writeNode().
  // Sub-keys are optional profile fields.
  //
  // Write-Authority: only the owner can write to ~{pub}/ (Relay enforced via sig check).
  // Other peers can READ ~{pub}/** but not write.
  //
  // Visibility: ~{pub}/status = 'public'|'hidden'
  // People directory (demo/people.html) only shows 'public' users.
  // Default: 'hidden' (privacy-first).


  const user = {

    /**
     * Set own display alias.
     * Writes to root node (~{pub}) + persists in conf/identity.
     * @param {string} alias
     */
    setAlias: (alias) => {
      me.alias = alias   // setter triggers _writeNode() + conf write
    },

    /**
     * Set own avatar. null = delete.
     * Writes to ~{pub}/avatar (base64-JPEG, max 128px recommended).
     * @param {string|null} base64Jpeg
     */
    setAvatar: (base64Jpeg) => {
      me.avatar = base64Jpeg   // setter triggers db.put / db.del
    },

    /**
     * Set a field directly on the user node: ~{pub}/{field}
     * Uniform structure — same as alias, avatar, status, etc.
     * value=null deletes the field.
     *
     * @param {string} field        e.g. 'town', 'age', 'website'
     * @param {*}      value        any JSON value, or null to delete
     * @param {object} [opts]
     * @param {boolean} [opts.encrypted]    encrypt with own key (self-only readable)
     * @param {string[]}[opts.recipients]   encrypt for specific peers (epub[])
     */
    /**
     * Set any user node field: ~{pub}/{field}
     * 'pub' and 'epub' are readonly — silently ignored if already written.
     * 'alias' writes ~{pub}/alias AND updates the root node cache.
     * All other fields are stored as their own atomic QuBit.
     *
     * @param {string} field       e.g. 'alias', 'town', 'age'  ('pub'/'epub' are readonly)
     * @param {*}      value       any JSON value, or null to delete
     * @param {object} [opts]
     * @param {boolean}  [opts.encrypted]    encrypt with own key
     * @param {string[]} [opts.recipients]   encrypt for specific peers (epub[])
     */
    setField: async (field, value, opts = {}) => {
      // readonly guard: pub and epub are written once at identity init
      if (field === 'pub' || field === 'epub') {
        /*DEBUG*/ console.debug('[QuRay:node] setField: \'pub\' and \'epub\' are readonly — ignoring')
        return
      }

      const { encrypted = false, recipients = [] } = opts
      const key = KEY.user(me.pub).field(field)

      if (value === null || value === undefined) {
        await db.del(key)
        return
      }

      if (encrypted || recipients.length) {
        const rcpts = recipients.length ? recipients.map(epub => ({ epub })) : null
        const enc   = await me.encrypt(JSON.stringify({ field, value }), rcpts)
        await db.put(key, { encrypted: true, field, enc })
        return
      }

      // 'alias' — route through setAlias for single write + conf/identity sync
      if (field === 'alias' && typeof value === 'string') {
        await me.setAlias?.(value)   // writes ~pub/alias + updates RAM + conf/identity
        return
      }

      await db.put(key, value)
    },

    /**
     * Get a field from any user node: ~{pub}/{field}
     * @param {string} field
     * @param {string} [pub]  defaults to own pub
     */
    getField: async (field, pub = me.pub) => {
      const q = await db.get(KEY.user(pub).field(field))
      return q?.data ?? null
    },

    /**
     * Decrypt a field stored with setField({ encrypted: true }).
     */
    decryptField: async (stored) => {
      if (!stored?.encrypted || !stored.enc) return stored
      try { return JSON.parse(await me.decrypt(stored.enc)).value } catch { return null }
    },

    /**
     * @deprecated Use setField() per-field instead.
     */

    /**
     * Set visibility in the public user directory.
     * 'public'  → appears in qr.node.user.list() and people.html
     * 'hidden'  → not listed (default, privacy-first)
     * @param {'public'|'hidden'} visibility
     */
    setVisibility: (visibility) =>
      db.put(KEY.user(me.pub).field('status'), visibility),

    /**
     * Save a keypair backup.
     * Encrypted with PBKDF2 + stored in ~{pub}/backup.
     * Passphrase=null removes the backup.
     * @param {string|null} passphrase
     */
    saveBackup: async (passphrase) => {
      if (passphrase) {
        const ciphertext = await me.backup(passphrase)
        await db.put(KEY.user(me.pub).field('backup'), ciphertext)
      } else {
        await db.del(KEY.user(me.pub).field('backup'))
      }
    },

    /**
     * Read a user profile (own or remote).
     * Returns a structured profile object derived from DB.
     * For remote peers, uses qr.peers for reactivity.
     * @param {string} [pub] - defaults to me.pub
     * @returns {Promise<UserProfile>}
     */
    read: async (pub) => {
      const p64 = pub ? _p64(pub) : me.pub

      if (p64 === me.pub) {
        // Own profile — read all sub-keys atomically
        const [avatarQ, backupQ, statusQ, _propsLegacy] = await Promise.all([
          db.get(KEY.user(p64).field('avatar')),
          db.get(KEY.user(p64).field('backup')),
          db.get(KEY.user(p64).field('status')),
          // Props are direct fields — no special props/ prefix needed.
          // The profile modal reads them via db.query('~pub/') and filters KNOWN fields.
          Promise.resolve([]),  // props field deprecated — use db.query(~pub/) directly
        ])
        return {
          pub:        me.pub,
          epub:       me.epub,
          alias:      me.alias,
          avatar:     _val(avatarQ),
          props:      [],  // deprecated — fields live directly at ~pub/{field}
          backup:     _val(backupQ) ?? null,
          visibility: _val(statusQ) ?? 'hidden',
          online:     true,
        }
      }

      // Remote peer — use PeerMap for reactive data
      const peer = peers.get(p64)
      return {
        pub:        p64,
        epub:       peer?.epub   ?? null,
        alias:      peer?.alias  ?? p64.slice(0, 12) + '…',
        avatar:     peer?.avatar ?? null,
        props:      peer?.props  ?? [],
        visibility: 'unknown',
        online:     peer?.online ?? false,
      }
    },

    /**
     * List all known user nodes (epub-gated: only confirmed user identities).
     * Includes users loaded from relay via sync, local IDB, and peer.hello.
     * Does NOT include users with visibility='hidden' by default.
     *
     * @param {{ includeHidden?: boolean }} [opts]
     * @returns {Promise<Array<RemotePeer>>}
     */
    list: async ({ includeHidden = false } = {}) => {
      const all = peers.all.filter(p => p.epub)  // epub-gate: confirmed user nodes
      if (includeHidden) return all
      // Filter out hidden users (those with ~pub/status = 'hidden')
      // For peers without a known status, include them (public by default for backwards compat)
      return all.filter(p => {
        const prop = p.props?.find(pr => pr.key === 'status')
        return !prop || prop.value !== 'hidden'
      })
    },

    /**
     * Reactive: watch own user node for any changes.
     * Alias for qr.me.watch(fn).
     * @param {Function} fn
     * @returns {() => void}
     */
    watch: (fn) => me.watch(fn),
  }


  // ── Message / Inbox API ────────────────────────────────────────────────────
  //
  // Messages use dual-delivery:
  //   1. db.put('>to/ts-id', payload) — Relay persists, B gets on next syncIn
  //   2. net.send({to, payload})      — WS push for immediate online delivery
  //
  // qr.inbox() subscribes to db.on('>me.pub/**') — fires on both paths.

  /**
   * Subscribe to own inbox.
   * Fires for incoming invites, notifications, direct messages.
   * @param {(data: any, qubit: object) => void} fn
   * @returns {() => void}
   */
  const inbox = (fn) => {
    const prefix = `>${me.pub}/`
    return db.on(prefix + '**', (qubit, { event }) => {
      if (event === 'del' || !qubit?.data) return
      fn(qubit.data, qubit)
    })
  }

  /**
   * Send a message to a peer (dual delivery: persist + WS push).
   * @param {string} toPub - recipient pub64 (normalized automatically)
   * @param {any} payload
   */
  const send = async (toPub, payload) => {
    const to  = _p64(toPub)
    const ts  = Date.now()
    const key = `>${to}/${String(ts).padStart(16, '0')}-${crypto.randomUUID()}`
    // 1. Persist — relay syncs >{to}/ on B's next connect
    await db.put(key, { ...payload, ts, from: me.pub })
    // 2. WS push — relay routes to B if currently connected
    net.send({ to, payload: { ...payload, ts, from: me.pub, key } })
  }


  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    // Generic node operations
    write,
    read,
    remove,
    watch,
    list,

    // User node operations (profile, visibility, props)
    user,

    // Messaging
    inbox,
    send,

    // Utilities
    toPub64: _p64,
  }
}


export { QuNode }
