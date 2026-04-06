import { PIPELINE_PRIORITY } from '../core/events.js'
import { KEY, pub64 } from '../core/qubit.js'

function parseActorPublicKey(actorPublicKey) {
  return actorPublicKey ? pub64(actorPublicKey) : null
}

function parseKeyOwnerPublicKey(keyString) {
  // Normalise through pub64 so comparisons with actorPublicKey (also pub64-normalised)
  // are reliable regardless of whether the key was built from raw base64 or base64url.
  const userMatch = /^~([^/]+)\//u.exec(keyString)
  if (userMatch) return pub64(userMatch[1])
  const inboxMatch = /^>([^/]+)\//u.exec(keyString)
  if (inboxMatch) return pub64(inboxMatch[1])
  return null
}

function parseSpaceId(keyString) {
  const match = /^@([^/]+)\//u.exec(keyString)
  return match ? match[1] : null
}

async function readSpaceAccessControlEntry(database, spaceId) {
  return database.get(KEY.space(spaceId).acl, { includeDeleted: true })
}

async function canActorWriteQuBit(database, qubit) {
  const keyString = qubit?.key ?? ''
  const actorPublicKey = parseActorPublicKey(qubit?.from)
  if (!keyString) return true

  if (keyString.startsWith('sys/') || keyString.startsWith('conf/') || keyString.startsWith('blobs/')) return true

  const ownerPublicKey = parseKeyOwnerPublicKey(keyString)
  if (ownerPublicKey) return actorPublicKey === ownerPublicKey

  const spaceId = parseSpaceId(keyString)
  if (!spaceId) return true

  const aclQuBit = await readSpaceAccessControlEntry(database, spaceId)
  const aclValue = aclQuBit?.data ?? null

  if (!aclValue) {
    // No ACL exists for this space yet.
    // The ~acl key itself can only be written by whoever claims ownership (data.owner).
    if (keyString === KEY.space(spaceId).acl) {
      return aclValue == null && actorPublicKey && pub64(qubit?.data?.owner ?? '') === actorPublicKey
    }
    // ~meta is writable by any authenticated actor (no ACL required).
    if (keyString === KEY.space(spaceId).meta) return Boolean(actorPublicKey)
    // All other keys in an ACL-less space are open — any authenticated actor may write.
    // The relay enforces its own ACL on ingest; this is a client-side pre-flight only.
    return Boolean(actorPublicKey)
  }

  if (aclValue.owner && pub64(aclValue.owner) === actorPublicKey) return true
  if (keyString === KEY.space(spaceId).acl) return false
  if (aclValue.writers === '*') return true
  if (Array.isArray(aclValue.writers)) return aclValue.writers.map((entry) => pub64(entry)).includes(actorPublicKey)
  return false
}

const AccessControlPlugin = () => (database) => {
  const validateWrite = async (pipelineContext, directionLabel) => {
    const { qubit } = pipelineContext
    if (!qubit?.key) return

    const isAllowed = await canActorWriteQuBit(database, qubit)
    if (isAllowed) return

    const actorPublicKey = qubit?.from ? pub64(qubit.from) : 'unknown'
    throw new Error(`[QuRay:AccessControl] ${directionLabel} write denied for ${qubit.key} by ${actorPublicKey}`)
  }

  const stopIncoming = database.useIn(async ({ args: [pipelineContext], next }) => {
    await validateWrite(pipelineContext, 'incoming')
    await next()
  }, PIPELINE_PRIORITY.ACCESS_IN)

  const stopOutgoing = database.useOut(async ({ args: [pipelineContext], next }) => {
    await validateWrite(pipelineContext, 'outgoing')
    await next()
  }, PIPELINE_PRIORITY.ACCESS_OUT)

  return () => {
    stopIncoming()
    stopOutgoing()
  }
}

export {
  AccessControlPlugin,
  canActorWriteQuBit,
}
