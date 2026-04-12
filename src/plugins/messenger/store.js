// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/store.js
// MessengerStore — reactive data layer for the Messenger plugin.
//
// Responsibilities:
//   • Manage conversation registry (conf/messenger/convs/)
//   • Send/query messages (group: @space/chat/, DM: ~/dm/{contact}/)
//   • Manage contacts (~{pub}/contacts/)
//   • Track read positions (conf/messenger/readpos/)
//   • Register msg.read / msg.readpos sync handlers
//
// Intentionally thin — all persistence goes through QuDB, all reactivity
// through db.on(). No internal state beyond the handler registry.
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
 * // Create a group chat
 * const { convId, spaceId } = await store.createGroup({ name: 'Team', members: [bobPub] })
 *
 * // Send a text message
 * await store.sendMessage(convId, { type: 'text', text: 'Hello!' })
 *
 * // React to new messages
 * const off = store.onMessages(convId, (qubit, meta) => console.log(qubit))
 */
const MessengerStore = ({ db, identity }) => {
  let _offHandlers = []


  // ── Internal helpers ────────────────────────────────────────────────────────

  const _myPub = () => identity?.pub ?? null

  /** Read a conversation record from the local conf/ registry. */
  const _getConvRecord = async (convId) => {
    const q = await db.get(MSG_KEY.conv(convId))
    return q?.data ?? null
  }

  /** Derive the message key prefix for a given conversation. */
  const _msgPrefix = (conv) => {
    if (!conv) return null
    if (conv.type === CONV_TYPE.GROUP) return MSG_KEY.groupPrefix(conv.spaceId)
    if (conv.type === CONV_TYPE.DM)    return MSG_KEY.dmPrefix(_myPub(), conv.contactPub)
    return null
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
   * Update the conversation's last-message preview (called after send).
   * @private
   */
  const _touchConv = async (convId, msgText) => {
    const key  = MSG_KEY.conv(convId)
    const prev = (await db.get(key))?.data ?? {}
    await db.put(key, { ...prev, lastTs: Date.now(), lastMsg: msgText ?? null })
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
   *
   * @param {string} convId
   * @param {object} [opts] — { limit, offset, order }
   * @returns {Promise<QuBit[]>}
   */
  const getMessages = async (convId, opts = {}) => {
    const conv = await _getConvRecord(convId)
    if (!conv) return []
    const prefix = _msgPrefix(conv)
    return db.query(prefix, { order: 'key', ...opts })
  }

  /**
   * Subscribe to incoming/outgoing messages for a conversation.
   *
   * @param {string} convId
   * @param {function} fn — (qubit, meta) => void
   * @returns {Promise<function>} off — resolves after the conv record is loaded
   */
  const onMessages = async (convId, fn) => {
    const conv = await _getConvRecord(convId)
    if (!conv) return () => {}
    const prefix = _msgPrefix(conv)
    return db.on(prefix + '**', fn)
  }


  // ── Contacts ─────────────────────────────────────────────────────────────────

  /**
   * Add or update a contact.
   *
   * @param {string} contactPub
   * @param {object} opts — { alias?, epub? }
   */
  const addContact = async (contactPub, { alias = null, epub = null } = {}) => {
    const myPub = _myPub()
    if (!myPub) return
    await db.put(MSG_KEY.contact(myPub, contactPub), {
      pub:     pub64(contactPub),
      alias,
      epub,
      addedAt: Date.now(),
    })
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
   * Register sync handlers for read receipt types.
   * Called by MessengerPlugin.attach(sync).
   *
   * @param {QuSyncInstance} sync
   */
  const attach = (sync) => {
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
  }

  /** Unregister all handlers. */
  const detach = () => {
    for (const off of _offHandlers) off?.()
    _offHandlers = []
  }


  return {
    // Conversations
    getConversations,
    onConversations,
    getOrCreateDM,
    createGroup,

    // Messages
    sendMessage,
    getMessages,
    onMessages,

    // Contacts
    addContact,
    getContacts,
    onContacts,

    // Read tracking
    markRead,
    getReadPosition,

    // Lifecycle
    attach,
    detach,
  }
}


export { MessengerStore }
