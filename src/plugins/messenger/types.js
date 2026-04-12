// ════════════════════════════════════════════════════════════════════════════
// QuRay — plugins/messenger/types.js
// Constants, key helpers and message factory for the Messenger plugin.
//
// All key patterns follow the QuRay mount schema:
//   @{spaceId}/chat/{ts16}-{id}              ← group messages (synced)
//   ~{myPub}/dm/{contactPub}/{ts16}-{id}     ← DM sent copy (synced, signed)
//   >{recipientPub}/dm/{ts16}-{id}           ← DM inbox delivery (relay-routed)
//   ~{myPub}/contacts/{contactPub}           ← contact book (synced)
//   conf/messenger/convs/{convId}            ← conversation registry (local)
//   conf/messenger/readpos/{convId}          ← read position (local)
//   sys/call/{peerId}                        ← call state (ephemeral RAM)
// ════════════════════════════════════════════════════════════════════════════

import { KEY, ts16 } from '../../core/qubit.js'
import { pub64 }     from '../../core/identity.js'


// ─────────────────────────────────────────────────────────────────────────────
// Enum-like constants
// ─────────────────────────────────────────────────────────────────────────────

/** Message content types stored in qubit.data.type */
const MSG_TYPE = {
  TEXT:   'text',
  IMAGE:  'image',   // kept for legacy; mimeType detection is preferred
  FILE:   'file',
  CALL:   'call',    // call-event bubble (started / ended)
  SYSTEM: 'system',  // "Alice joined the group", etc.
}

/** Audio/Video call media type */
const CALL_TYPE = {
  AUDIO: 'audio',
  VIDEO: 'video',
}

/** Call lifecycle state (stored in sys/call/{peerId}) */
const CALL_STATE = {
  IDLE:        'idle',
  RINGING:     'ringing',     // incoming, waiting for accept/decline
  CONNECTING:  'connecting',  // WebRTC negotiation in progress
  ACTIVE:      'active',      // media flowing
  ENDED:       'ended',       // finished (auto-dismissed)
}

/** Conversation channel types */
const CONV_TYPE = {
  DM:    'dm',
  GROUP: 'group',
}

/** QuBit types sent over the network for call signalling (not stored) */
const MESSENGER_SIG_TYPE = {
  CALL_INVITE:  'messenger.call.invite',
  CALL_ACCEPT:  'messenger.call.accept',
  CALL_HANGUP:  'messenger.call.hangup',
}


// ─────────────────────────────────────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────────────────────────────────────

const MSG_KEY = {
  /**
   * Key for a message in a group space.
   * @param {string} spaceId — @-space UUID
   * @param {number} [tsMs]
   * @param {string} [id]
   */
  group: (spaceId, tsMs = Date.now(), id = crypto.randomUUID().slice(0, 8)) =>
    `@${spaceId}/chat/${ts16(tsMs)}-${id}`,

  /**
   * Key for a DM message stored in the sender's user space.
   * Pattern: ~{myPub}/dm/{contactPub64}/{ts16}-{id}
   */
  dm: (myPub, contactPub, tsMs = Date.now(), id = crypto.randomUUID().slice(0, 8)) =>
    `~${pub64(myPub)}/dm/${pub64(contactPub)}/${ts16(tsMs)}-${id}`,

  /**
   * Group message key prefix for db.query / db.on.
   */
  groupPrefix: (spaceId) => `@${spaceId}/chat/`,

  /**
   * DM prefix for a specific conversation partner.
   */
  dmPrefix: (myPub, contactPub) =>
    `~${pub64(myPub)}/dm/${pub64(contactPub)}/`,

  /**
   * Conversation registry entry (local-only conf/).
   */
  conv: (convId) => `conf/messenger/convs/${convId}`,

  /**
   * Prefix for all conversation registry entries.
   */
  convPrefix: () => `conf/messenger/convs/`,

  /**
   * Read-position marker for a conversation (local-only).
   */
  readpos: (convId) => `conf/messenger/readpos/${convId}`,

  /**
   * Ephemeral call state key (RAM-only sys/).
   */
  callState: (peerId) => `sys/call/${pub64(peerId)}`,

  /**
   * Contact entry in the user's own space.
   */
  contact: (myPub, contactPub) =>
    KEY.user(myPub).field(`contacts/${pub64(contactPub)}`),

  /**
   * Prefix for all contacts.
   */
  contactPrefix: (myPub) => KEY.user(myPub).field('contacts/'),
}


// ─────────────────────────────────────────────────────────────────────────────
// Message factory
//
// Returns a plain data object suitable for db.put(key, createMessage({...})).
// Format aligns with qu-chat-msg expectations: { text, attachments:[...] }
// plus Messenger-specific fields (type, callType, callDuration).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a normalized message data payload.
 *
 * @param {object} opts
 * @param {string}  [opts.type='text']       — MSG_TYPE value
 * @param {string}  [opts.text]              — plain text body
 * @param {Array}   [opts.attachments]       — [{hash, mime, name, size}]
 * @param {string}  [opts.replyTo]           — key of the message being quoted
 * @param {string}  [opts.callType]          — CALL_TYPE value for call events
 * @param {number}  [opts.callDuration]      — seconds for ended-call bubbles
 * @returns {object}
 */
const createMessage = ({
  type         = MSG_TYPE.TEXT,
  text         = null,
  attachments  = [],
  replyTo      = null,
  callType     = null,
  callDuration = null,
} = {}) => ({
  type,
  text:         text ?? null,
  attachments:  attachments.length ? attachments : undefined,
  replyTo:      replyTo   ?? undefined,
  callType:     callType  ?? undefined,
  callDuration: callDuration != null ? callDuration : undefined,
})


export {
  MSG_TYPE,
  CALL_TYPE,
  CALL_STATE,
  CONV_TYPE,
  MESSENGER_SIG_TYPE,
  MSG_KEY,
  createMessage,
}
