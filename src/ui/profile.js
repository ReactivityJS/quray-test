// ════════════════════════════════════════════════════════════════════════════
// QuRay — ui/profile.js
//
// ProfileManager: Duenner Wrapper um qr.node.user fuer Demos und Legacy-Code.
// ALLE Funktionen delegieren an qr.node.user.* und qr.me.*.
// Neu entwickelte Apps nutzen direkt qr.node.user.* + qr.me.watch().
//
// Behalten fuer Rueckwaertskompatibilitaet und als UI-Helper (resizeImg).
// ════════════════════════════════════════════════════════════════════════════

// resizeImg — Bild auf maxPx skalieren, JPEG konvertieren.
// Einzige Utility die nicht in node.js gehoert (browser-spezifisch).
export const resizeImg = (file, maxPx = 128) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const scale  = Math.min(1, maxPx / Math.max(img.width, img.height))
        const canvas = Object.assign(document.createElement('canvas'), {
          width:  Math.round(img.width  * scale),
          height: Math.round(img.height * scale),
        })
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas.toBlob failed')),
                      'image/jpeg', 0.88)
      }
      img.onerror = reject
      img.src = e.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })


// ProfileManager(qr) — Legacy API fuer bestehende Demos.
// Alle Operationen delegieren an qr.node.user + qr.me.
export async function ProfileManager(qr) {
  const { me, node } = qr

  // load() — laedt eigenes Profil (alle Sub-Keys) einmalig
  // Neu: qr.node.user.read() macht dasselbe reaktiv
  async function load() {
    const profile = await node.user.read()
    // Load custom fields (town, age, website, etc.) directly from ~pub/* sub-keys
    // Each is its own QuBit — filter out the known standard fields
    // Standard fields have dedicated DB keys or live in root node — exclude from custom list
    const STANDARD = new Set(['alias','avatar','backup','status','epub','pub'])
    const rows = await (qr.db?.query('~' + me.pub + '/').catch(() => [])) ?? []
    const customFields = rows
      .filter(q => {
        const field = q.key.replace('~' + me.pub + '/', '').split('/')[0]
        return field && !STANDARD.has(field) && !field.startsWith('blob')
      })
      .map(q => {
        const field = q.key.replace('~' + me.pub + '/', '')
        const d = q.data
        if (d?.encrypted && d?.enc) return { key: field, value: '', encrypted: true, enc: d.enc }
        return { key: field, value: typeof d === 'object' ? JSON.stringify(d) : String(d ?? ''), encrypted: false }
      })
    return { ...profile, props: customFields }
  }

  // watchSelf(onUpdate) — reaktiv auf eigene Profil-Aenderungen
  // Delegiert an me.watch() (Framework-Core-Funktion)
  function watchSelf(onUpdate) {
    return me.watch(async () => {
      const fresh = await load()
      onUpdate(fresh)
    })
  }

  return {
    load,
    watchSelf,
    saveAlias:    (alias)      => node.user.setAlias(alias),
    saveAvatar:   (b64)        => node.user.setAvatar(b64 || null),
    /**
     * Save custom fields directly as node fields: ~{pub}/{field}
     * Each field is its own signed QuBit — no special wrapper needed.
     * @param {Array<{key:string, value:string, encrypted?:boolean}>} fields
     */
    saveProps: async (fields) => {
      const incoming = fields ?? []
      const STANDARD = new Set(['alias','avatar','backup','status','pub','epub'])

      // Load current custom fields from DB to find deleted ones
      const currentRows = await (qr.db?.query('~' + me.pub + '/').catch(() => [])) ?? []
      const currentKeys = new Set(
        currentRows
          .map(q => q.key.replace('~' + me.pub + '/', '').split('/')[0])
          .filter(f => f && !STANDARD.has(f) && !f.startsWith('blob'))
      )
      const incomingKeys = new Set(incoming.map(f => f.key).filter(Boolean))

      // Delete fields that were removed from the list
      for (const key of currentKeys) {
        if (!incomingKeys.has(key)) {
          await node.user.setField(key, null)  // null → db.del()
        }
      }

      // Save/update all incoming fields
      const results = []
      for (const f of incoming) {
        if (!f.key) continue
        await node.user.setField(f.key, f.value || null, {
          encrypted:  f.encrypted ?? false,
          recipients: f.recipients ?? [],
        })
        results.push({ key: f.key, value: f.value })
      }
      return results
    },
    /**
     * Decrypt an encrypted field value returned from getField.
     */
    decryptProps: async (stored) => {
      // Legacy: stored was an array of {key, encrypted, enc} objects
      if (!Array.isArray(stored)) return []
      const result = []
      for (const f of stored) {
        if (!f?.encrypted || !f.enc) { if (f) result.push(f); continue }
        const value = await node.user.decryptField(f).catch(() => null)
        result.push({ key: f.key, value, encrypted: true })
      }
      return result
    },
    saveBackup:   (passphrase) => node.user.saveBackup(passphrase),
    resizeImg,
  }
}
