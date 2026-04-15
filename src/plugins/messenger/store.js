// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/store.js
// MessengerStore — reactive data layer for the Messenger plugin.
//
// Responsibilities:
//   • Manage conversation registry (conf/messenger/convs/)
//   • Send/query messages (group: @space/chat/, DM: ~/dm/{contact}/)
//   • Manage contacts (~{pub}/contacts/)
//   • Track read positions (conf/messenger/readpos/)
//   • Register msg.readpos sync handlers
//
// DM routing fix:
//   When Alice sends to Bob, she writes to ~alicePub/dm/bobPub/{ts}-{id}.
//   Bob must subscribe to ~alicePub/dm/bobPub/ to receive those messages.
//   addContact() triggers this subscription via sync.subscribe() so both
//   sides of the conversation are visible without relay-side inbox routing.
// ════════════════════════════════════════════════════════════════════════════

import { QUBIT_TYPE }    from '../../core/qubit.js'
import { pub64 }         from '../../core/identity.js'
import {
  MSG_TYPE,
  CONV_TYPE,
  MSG_KEY,
  createMessage,
} from './types.js'


/**
 * MessengerStore — reactive data layer.
 *
 * @param {object} options
 * @param {QuDBInstance}     options.db       — QuDB instance
 * @param {IdentityInstance} options.identity — local identity
 * @returns {MessengerStoreInstance}
 *
 * @example
 * const store = MessengerStore({ db: qr.db, identity: qr.me })
 * store.attach(qr._.sync)
 *
 * // Create a DM conversation
 * await store.addContact(bobPub, { alias: 'Bob', epub: bob.epub })
 * const convId = await store.getOrCreateDM(bobPub)
 *
 * // Send a text message
 * await store.sendMessage(convId, { text: 'Hello!' })
 *
 * // React to new messages
 * const off = await store.onMessages(convId, (qubit, meta) => console.log(qubit))
 */
const MessengerStore = ({ db, identity }) => {
  let _offHandlers = []
  let _sync        = null   // set by attach(sync)


  // ── Internal helpers ────────────────────────────────────────────────────────

  const _myPub = () => identity?.pub ?? null

  /** Read a conversation record from the local conf/ registry. */
  const _getConvRecord = async (convId) => {
    const q = await db.get(MSG_KEY.conv(convId))
    return q?.data ?? null
  }


  // ── Conversations ────────────────────────────────────────────────────────────

  /**
   * Return all conversations from the local registry.
   * @returns {Promise<QuBit[]>}
   */
  const getConversations = () => db.query(MSG_KEY.convPrefix(), { order: 'ts', orderDir: 'desc' })

  /**
   * Subscribe reactively to conversation list changes.
   * @param {function} fn
   * @returns {function} off
   */
  const onConversations = (fn) => db.on(MSG_KEY.convPrefix() + '**', fn)

  /**
   * Get or create a DM conversation with a contact.
   * Returns the convId (deterministic: sorted pair of pub64s).
   *
   * @param {string} contactPub
   * @returns {Promise<string>} convId
   */
  const getOrCreateDM = async (contactPub) => {
    const myPub  = _myPub()
    if (!myPub) throw new Error('MessengerStore: identity not set')
    const p64    = pub64(contactPub)

    // Deterministic convId: sorted pair, so A↔B and B↔A share the same ID
    const parts  = [pub64(myPub), p64].sort()
    const convId = `dm-${parts[0].slice(0, 12)}-${parts[1].slice(0, 12)}`
    const key    = MSG_KEY.conv(convId)
    const exists = await db.get(key)
    if (!exists) {
      await db.put(key, {
        type:       CONV_TYPE.DM,
        convId,
        contactPub: p64,
        spaceId:    null,
        name:       null,          // resolved from contact alias reactively
        lastTs:     Date.now(),
        lastMsg:    null,
        unread:     0,
      })
    }
    return convId
  }

  /**
   * Create a new group conversation.
   *
   * @param {object} opts
   * @param {string}   opts.name      — display name
   * @param {string[]} [opts.members] — initial member pub keys (besides owner)
   * @returns {Promise<{convId: string, spaceId: string}>}
   */
  const createGroup = async ({ name, members = [] }) => {
    const myPub   = _myPub()
    if (!myPub) throw new Error('MessengerStore: identity not set')
    const spaceId = crypto.randomUUID()
    const convId  = `group-${spaceId.slice(0, 8)}`

    // ACL: owner + all members can write
    const writers = members.length ? [pub64(myPub), ...members.map(pub64)] : '*'
    await db.put(`@${spaceId}/~acl`,  { owner: pub64(myPub), writers })
    await db.put(`@${spaceId}/~meta`, { name, type: 'group', createdAt: Date.now() })

    // Conversation registry entry
    await db.put(MSG_KEY.conv(convId), {
      type:    CONV_TYPE.GROUP,
      convId,
      spaceId,
      name,
      lastTs:  Date.now(),
      lastMsg: null,
      unread:  0,
    })

    return { convId, spaceId }
  }

  /**
   * Delete a conversation from the local registry.
   * Does NOT delete message history — only removes the conv entry.
   *
   * @param {string} convId
   */
  const deleteConversation = async (convId) => {
    await db.del(MSG_KEY.conv(convId)).catch(() => {})
  }

  /**
   * Update the conversation's last-message preview (called after send).
   * @private
   */
  const _touchConv = async (convId, msgText) => {
    const key  = MSG_KEY.conv(convId)
    const prev = (await db.get(key))?.data ?? {}
    await db.put(key, { ...prev, lastTs: Date.now(), lastMsg: msgText ?? null })
  }

  /**
   * Update the conversation's last-message preview for an INCOMING message,
   * incrementing the unread counter.
   *
   * @param {string} convId
   * @param {string} [msgText]
   */
  const touchConvIncoming = async (convId, msgText) => {
    const key  = MSG_KEY.conv(convId)
    const prev = (await db.get(key))?.data ?? {}
    await db.put(key, {
      ...prev,
      lastTs:  Date.now(),
      lastMsg: msgText ?? null,
      unread:  (prev.unread ?? 0) + 1,
    })
  }

  /**
   * Reset the unread counter for a conversation to 0.
   *
   * @param {string} convId
   */
  const resetUnread = async (convId) => {
    const key  = MSG_KEY.conv(convId)
    const prev = (await db.get(key))?.data ?? {}
    if ((prev.unread ?? 0) === 0) return
    await db.put(key, { ...prev, unread: 0 })
  }


  // ── Messages ─────────────────────────────────────────────────────────────────

  /**
   * Send a message in a conversation.
   *
   * @param {string} convId
   * @param {object} msgData — partial message: { type?, text?, attachments?, ... }
   * @param {object} [opts]
   * @param {boolean} [opts.encrypt] — E2E-encrypt the payload
   * @returns {Promise<string>} the written QuBit key
   */
  const sendMessage = async (convId, msgData, opts = {}) => {
    const myPub = _myPub()
    if (!myPub) throw new Error('MessengerStore: identity not set')

    const conv = await _getConvRecord(convId)
    if (!conv) throw new Error(`MessengerStore: unknown conversation "${convId}"`)

    const payload = createMessage(msgData)

    // Trigger blob uploads for any attachments that are still only staged
    for (const att of payload.attachments ?? []) {
      if (att.hash) await db.blobs.upload(att.hash).catch(() => {})
    }

    let data = payload
    if (opts.encrypt && identity?.encrypt) {
      // For DMs: encrypt for contactPub + self
      // For groups: caller must pass recipient epub list via opts.recipients
      const targets = opts.recipients ?? (conv.contactPub
        ? [{ pub: conv.contactPub, epub: opts.contactEpub }]
        : null)
      if (targets) {
        data = await identity.encrypt(JSON.stringify(payload), targets)
      }
    }

    let key
    if (conv.type === CONV_TYPE.GROUP) {
      key = MSG_KEY.group(conv.spaceId)
    } else {
      key = MSG_KEY.dm(myPub, conv.contactPub)
    }

    await db.put(key, data)
    await _touchConv(convId, payload.text ?? (payload.attachments?.length ? '📎' : ''))
    return key
  }

  /**
   * Query messages for a conversation (paginated, newest-last by default).
   * For DM conversations, queries BOTH sides (my outgoing + their outgoing to me)
   * and merges by timestamp.
   *
   * @param {string} convId
   * @param {object} [opts] — { limit, offset, order }
   * @returns {Promise<QuBit[]>}
   */
  const getMessages = async (convId, opts = {}) => {
    const conv = await _getConvRecord(convId)
    if (!conv) return []

    if (conv.type === CONV_TYPE.GROUP) {
      return db.query(MSG_KEY.groupPrefix(conv.spaceId), { order: 'key', ...opts })
    }

    // DM: merge both sides and sort by timestamp
    const myPub     = _myPub()
    const myP64     = pub64(myPub)
    const contactP64 = pub64(conv.contactPub)

    const [mine, theirs] = await Promise.all([
      db.query(`~${myP64}/dm/${contactP64}/`,     { order: 'key', ...opts }),
      db.query(`~${contactP64}/dm/${myP64}/`, { order: 'key', ...opts }),
    ])

    // Merge and sort by key (ts16 prefix ensures chronological order)
    return [...mine, ...theirs].sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''))
  }

  /**
   * Subscribe to incoming/outgoing messages for a conversation.
   * For DM conversations, subscribes to BOTH sides of the conversation.
   *
   * @param {string} convId
   * @param {function} fn — (qubit, meta) => void
   * @returns {Promise<function>} off — resolves after the conv record is loaded
   */
  const onMessages = async (convId, fn) => {
    const conv = await _getConvRecord(convId)
    if (!conv) return () => {}

    if (conv.type === CONV_TYPE.GROUP) {
      return db.on(MSG_KEY.groupPrefix(conv.spaceId) + '**', fn)
    }

    // DM: subscribe to both directions
    const myPub      = _myPub()
    const myP64      = pub64(myPub)
    const contactP64  = pub64(conv.contactPub)

    const off1 = db.on(`~${myP64}/dm/${contactP64}/**`,     fn)
    const off2 = db.on(`~${contactP64}/dm/${myP64}/**`, fn)

    return () => { off1(); off2() }
  }


  // ── Contacts ─────────────────────────────────────────────────────────────────

  /**
   * Add or update a contact.
   * Also subscribes to the contact's DM prefix so their messages to us are
   * received via the relay subscription mechanism (fixes DM routing).
   *
   * @param {string} contactPub
   * @param {object} opts — { alias?, epub? }
   */
  const addContact = async (contactPub, { alias = null, epub = null } = {}) => {
    const myPub = _myPub()
    if (!myPub) return
    const contactP64 = pub64(contactPub)
    const myP64      = pub64(myPub)

    await db.put(MSG_KEY.contact(myPub, contactPub), {
      pub:     contactP64,
      alias,
      epub,
      addedAt: Date.now(),
    })

    // Subscribe to the contact's DM space for messages they send to us.
    // This is the fix for the DM routing issue: we explicitly pull their
    // ~{contactPub}/dm/{myPub}/ prefix from the relay.
    if (_sync) {
      const dmPrefix = `~${contactP64}/dm/${myP64}/`
      await _sync.subscribe(dmPrefix, { live: true, snapshot: true }).catch(() => {})
    }
  }

  /**
   * Query all contacts.
   * @returns {Promise<QuBit[]>}
   */
  const getContacts = () => {
    const myPub = _myPub()
    if (!myPub) return Promise.resolve([])
    return db.query(MSG_KEY.contactPrefix(myPub))
  }

  /**
   * Subscribe to contact list changes.
   * @param {function} fn
   * @returns {function} off
   */
  const onContacts = (fn) => {
    const myPub = _myPub()
    if (!myPub) return () => {}
    return db.on(MSG_KEY.contactPrefix(myPub) + '**', fn)
  }

  /**
   * Re-subscribe to all existing contacts' DM prefixes.
   * Call after attach(sync) to restore subscriptions on page reload.
   * @private
   */
  const _resubscribeContacts = async () => {
    if (!_sync) return
    const myP64 = pub64(_myPub())
    const contacts = await getContacts().catch(() => [])
    for (const q of contacts) {
      const contactP64 = q?.data?.pub
      if (!contactP64) continue
      const dmPrefix = `~${contactP64}/dm/${myP64}/`
      await _sync.subscribe(dmPrefix, { live: true, snapshot: true }).catch(() => {})
    }
  }


  // ── Read tracking ─────────────────────────────────────────────────────────────

  /**
   * Mark the conversation as read up to and including msgKey.
   *
   * @param {string} convId
   * @param {string} msgKey
   */
  const markRead = async (convId, msgKey) => {
    await db.put(MSG_KEY.readpos(convId), { key: msgKey, ts: Date.now() })
  }

  /**
   * Get the current read position for a conversation.
   * @param {string} convId
   * @returns {Promise<{key:string, ts:number}|null>}
   */
  const getReadPosition = async (convId) => {
    const q = await db.get(MSG_KEY.readpos(convId))
    return q?.data ?? null
  }


  // ── Sync handler registration ─────────────────────────────────────────────────

  /**
   * Register sync handlers and store the sync reference for contact subscriptions.
   * Call this once after QuSync is initialized.
   *
   * @param {QuSyncInstance} sync
   */
  const attach = (sync) => {
    _sync = sync

    // msg.readpos — remote peer updated their read position
    _offHandlers.push(
      sync.registerHandler(QUBIT_TYPE.MSG_READPOS, async (qubit) => {
        const { convId, key } = qubit.data ?? {}
        if (!convId || !key) return
        // Store remote read position in our local conf (scoped to sender pub)
        await db.put(
          `conf/messenger/remote-readpos/${pub64(qubit.from)}/${convId}`,
          { key, ts: qubit.ts }
        ).catch(() => {})
      })
    )

    // Re-subscribe to all existing contacts' DM prefixes (fixes missing msgs on reload)
    _resubscribeContacts().catch(() => {})
  }

  /** Unregister all handlers. */
  const detach = () => {
    for (const off of _offHandlers) off?.()
    _offHandlers = []
    _sync = null
  }


  return {
    // Conversations
    getConversations,
    onConversations,
    getOrCreateDM,
    createGroup,
    deleteConversation,

    // Messages
    sendMessage,
    getMessages,
    onMessages,

    // Contacts
    addContact,
    getContacts,
    onContacts,

    // Read / unread tracking
    markRead,
    getReadPosition,
    resetUnread,
    touchConvIncoming,

    // Lifecycle
    attach,
    detach,
  }
}


export { MessengerStore }
