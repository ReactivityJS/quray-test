// ════════════════════════════════════════════════════════════════════════════
// QuRay — backends/fs.js
//
// FsBackend — Filesystem-Backend für QuDB (Node.js only).
// Gleiche Schnittstelle wie IdbBackend und MemoryBackend:
//   { get, set, del, query, name }
//
// Jeder QuBit wird als <base64url(key)>.json gespeichert.
// Query iteriert alle .json-Dateien im Verzeichnis.
//
// Nutzung (z.B. in relay.js):
//   import { FsBackend } from './src/backends/fs.js'
//   const db = QuDB({ backends: { '': FsBackend({ dir: './data/msgs' }) } })
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'


/**
 * Node.js filesystem backend for the relay server. Stores QuBits as JSON files
 * in a directory tree mirroring the key structure.
 * Not available in the browser.
 *
 * @param {string} dir - Directory path for data storage
 * @param {object} [config]
 * @returns {Backend} - { get, set, del, scan }
 * @group Backend
 * @since 0.1.0
 *
 * @example
 * // Used by relay.js — no browser use.
 * const store = FsBackend('./data')
 */
const FsBackend = ({ dir, pretty = false } = {}) => {

  // Ensure directory exists
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })

  // key → filename: base64url encode to avoid fs-illegal characters
  const _path = (key) => join(dir, Buffer.from(key).toString('base64url') + '.json')

  // ── get(key) → value | null ───────────────────────────────────────────────
  const get = (key) => {
    try {
      const p = _path(key)
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
    } catch (e) {
      /*DEBUG*/ console.warn('[QuRay:FsBackend] get error:', key, e.message)
      return null
    }
  }

  // ── set(key, value) → void ────────────────────────────────────────────────
  const set = (key, value) => {
    try {
      writeFileSync(_path(key), pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), 'utf8')
    } catch (e) {
      console.error('[QuRay:FsBackend] set error:', key, e.message)
      throw e  // Schreibfehler werfen damit Queue retry kann
    }
  }

  // ── del(key) → void ───────────────────────────────────────────────────────
  const del = (key) => {
    try {
      const p = _path(key)
      if (existsSync(p)) unlinkSync(p)
    } catch (e) {
      /*DEBUG*/ console.warn('[QuRay:FsBackend] del error:', key, e.message)
    }
  }

  // ── query(prefix) → [{key, val}] ─────────────────────────────────────────
  // Iteriert alle .json-Dateien, filtert nach key-Prefix.
  // Performance: O(n) über alle Dateien — für Relay-Grössenordnungen ausreichend.
  // Für grosse Deployments: SQLite-Backend oder Index-Datei.
  const query = (prefix) => {
    try {
      return readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const val = JSON.parse(readFileSync(join(dir, f), 'utf8'))
            // key ist im QuBit gespeichert (val.key), oder aus Dateiname dekodieren
            const key = val?.key ?? Buffer.from(f.slice(0, -5), 'base64url').toString('utf8')
            return { key, val }
          } catch { return null }
        })
        .filter(entry => entry && (!prefix || entry.key === prefix || entry.key.startsWith(prefix)))
        .sort((a, b) => (a.val?.ts ?? 0) - (b.val?.ts ?? 0))
    } catch (e) {
      /*DEBUG*/ console.error('[QuRay:FsBackend] query error:', prefix, e.message)
      return []
    }
  }

  // ── exists(key) → boolean — Hilfsmethode für Relay ───────────────────────
  const exists = (key) => existsSync(_path(key))

  return { name: 'fs', get, set, del, query, exists }
}


// ── BlobFsBackend — optimiert für binäre Blob-Daten ─────────────────────────
// Speichert Blobs als reine Binärdateien (kein JSON-Wrapper).
// Interface identisch zu FsBackend, aber für ArrayBuffer/Buffer.
const BlobFsBackend = ({ dir } = {}) => {

  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Blob-Dateiname: hash direkt (URL-safe, kein Encoding nötig)
  const _blobPath = (hash) => join(dir, hash.replace(/[/\\]/g, '_'))

  const get    = (hash)         => { try { const p=_blobPath(hash); return existsSync(p)?readFileSync(p):null } catch { return null } }
  const set    = (hash, buffer) => { try { writeFileSync(_blobPath(hash), buffer) } catch(e) { throw e } }
  const del    = (hash)         => { try { const p=_blobPath(hash); if(existsSync(p)) unlinkSync(p) } catch {} }
  const exists = (hash)         => existsSync(_blobPath(hash))
  const query  = ()             => []  // Blobs werden nicht per prefix abgefragt

  return { name: 'blob-fs', get, set, del, query, exists }
}


export { FsBackend, BlobFsBackend }
