import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rankCandidates } from '../core/rank.js'
import { normalizeText } from '../core/text.js'

const SCHEMA_VERSION = 3

const RECORD_FIELDS = `id, kind, scope, scope_key AS scopeKey, title, body, tags,
  source_session AS sourceSession, source_turn AS sourceTurn, source_seq AS sourceSeq,
  importance, confidence, status, supersedes,
  created_at AS createdAt, updated_at AS updatedAt,
  last_used_at AS lastUsedAt, use_count AS useCount`

function recordColumns(alias = '') {
  return alias.length === 0
    ? RECORD_FIELDS
    : RECORD_FIELDS.split(',').map((part) => `${alias}${part.trim()}`).join(', ')
}

function rowToRecord(row) {
  if (row === undefined) return null
  return {
    ...row,
    tags: typeof row.tags === 'string' && row.tags.length > 0 ? row.tags.split(',') : [],
  }
}

function pinId(text, scope, scopeKey) {
  return `pin_${createHash('sha256').update([scope, scopeKey, normalizeText(text)].join('\u0000')).digest('hex').slice(0, 20)}`
}

/**
 * Open the local SQLite memory store. The database file is the single source of
 * truth; FTS5 keeps a lexical index of title/body/tags (trigram tokenizer when
 * available, so CJK substrings search correctly).
 *
 * @param {{ filePath: string, logger?: { warn: (...args: any[]) => void } }} options
 */
export function openMemoryStore(options) {
  const filePath = options?.filePath
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('memory4: store.filePath is required')
  mkdirSync(dirname(filePath), { recursive: true })
  const logger = options?.logger
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = OFF')

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      source_session TEXT,
      source_turn INTEGER,
      source_seq INTEGER,
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      supersedes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS records_scope_kind ON records(scope, scope_key, kind, status);
    CREATE INDEX IF NOT EXISTS records_updated ON records(updated_at DESC);
    CREATE TABLE IF NOT EXISTS pins (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pins_scope ON pins(scope, scope_key);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      record_id TEXT,
      actor TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_evidence (
      signature TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      sample TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      draft_path TEXT NOT NULL,
      target_path TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      evidence INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vectors (
      record_id TEXT PRIMARY KEY,
      dim INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      vector BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  let tokenizer = 'trigram'
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(title, body, tags, tokenize='trigram')")
  } catch (error) {
    logger?.warn?.('memory4: FTS5 trigram unavailable, falling back to unicode61: %o', error)
    tokenizer = 'unicode61'
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(title, body, tags, tokenize='unicode61')")
  }

  db.exec(`INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)

  const stmts = {
    get: db.prepare(`SELECT ${recordColumns()} FROM records WHERE id = ?`),
    rowid: db.prepare('SELECT rowid FROM records WHERE id = ?'),
    insert: db.prepare(`INSERT INTO records
      (id, kind, scope, scope_key, title, body, tags, source_session, source_turn, source_seq,
       importance, confidence, status, supersedes, created_at, updated_at, last_used_at, use_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE records SET
      kind = ?, scope = ?, scope_key = ?, title = ?, body = ?, tags = ?, source_session = ?, source_turn = ?, source_seq = ?,
      importance = ?, confidence = ?, status = ?, supersedes = ?, updated_at = ?, last_used_at = ?, use_count = ?
      WHERE id = ?`),
    delete: db.prepare('DELETE FROM records WHERE id = ?'),
    ftsDelete: db.prepare('DELETE FROM records_fts WHERE rowid = ?'),
    ftsInsert: db.prepare('INSERT INTO records_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)'),
    ftsCount: db.prepare('SELECT count(*) AS n FROM records_fts'),
    touch: db.prepare('UPDATE records SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?'),
    pinInsert: db.prepare('INSERT INTO pins(id, text, scope, scope_key, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'),
    pinList: db.prepare('SELECT id, text, scope, scope_key AS scopeKey, created_at AS createdAt FROM pins'),
    pinDelete: db.prepare('DELETE FROM pins WHERE id = ?'),
    statsTotal: db.prepare("SELECT count(*) AS n FROM records WHERE status = 'active'"),
    statsKind: db.prepare("SELECT kind, count(*) AS n FROM records WHERE status = 'active' GROUP BY kind"),
    statsScope: db.prepare("SELECT scope, count(*) AS n FROM records WHERE status = 'active' GROUP BY scope"),
    auditInsert: db.prepare('INSERT INTO audit(action, record_id, actor, detail, created_at) VALUES (?, ?, ?, ?, ?)'),
    auditList: db.prepare('SELECT id, action, record_id AS recordId, actor, detail, created_at AS createdAt FROM audit ORDER BY id DESC LIMIT ?'),
    evidenceGet: db.prepare('SELECT signature, count, first_at AS firstAt, last_at AS lastAt, sample FROM skill_evidence WHERE signature = ?'),
    evidenceUpsert: db.prepare(`INSERT INTO skill_evidence(signature, count, first_at, last_at, sample)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET count = count + 1, last_at = excluded.last_at, sample = excluded.sample`),
    skillInsert: db.prepare(`INSERT INTO skills(name, description, draft_path, target_path, status, evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, draft_path = excluded.draft_path,
        target_path = excluded.target_path, evidence = excluded.evidence, updated_at = excluded.updated_at`),
    skillGet: db.prepare('SELECT name, description, draft_path AS draftPath, target_path AS targetPath, status, evidence, created_at AS createdAt, updated_at AS updatedAt FROM skills WHERE name = ?'),
    skillList: db.prepare('SELECT name, description, draft_path AS draftPath, target_path AS targetPath, status, evidence, created_at AS createdAt, updated_at AS updatedAt FROM skills ORDER BY updated_at DESC LIMIT ?'),
    skillStatus: db.prepare('UPDATE skills SET status = ?, target_path = ?, updated_at = ? WHERE name = ?'),
    archiveEpisodic: db.prepare("UPDATE records SET status = 'archived', updated_at = ? WHERE status = 'active' AND kind = 'episodic' AND created_at < ?"),
    statsArchived: db.prepare("SELECT count(*) AS n FROM records WHERE status = 'archived'"),
    metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    vectorUpsert: db.prepare(`INSERT INTO vectors(record_id, dim, model, vector, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET dim = excluded.dim, model = excluded.model, vector = excluded.vector, updated_at = excluded.updated_at`),
    vectorGet: db.prepare('SELECT record_id AS recordId, dim, model, vector, updated_at AS updatedAt FROM vectors WHERE record_id = ?'),
    vectorDelete: db.prepare('DELETE FROM vectors WHERE record_id = ?'),
    vectorAll: db.prepare(`SELECT v.record_id AS recordId, v.dim, v.model, v.vector, v.updated_at AS vectorUpdatedAt, ${recordColumns('r.')}
      FROM vectors v JOIN records r ON r.id = v.record_id WHERE r.status = 'active' LIMIT ?`),
    vectorCount: db.prepare('SELECT count(*) AS n FROM vectors'),
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  function tagsOf(record) {
    return Array.isArray(record.tags) ? record.tags.join(',') : String(record.tags ?? '')
  }

  function reindex(id) {
    const row = stmts.rowid.get(id)
    if (row === undefined) return
    const record = rowToRecord(stmts.get.get(id))
    stmts.ftsDelete.run(row.rowid)
    stmts.ftsInsert.run(row.rowid, record.title, record.body, tagsOf(record))
  }

  function put(record) {
    if (!record || typeof record.id !== 'string') throw new TypeError('memory4: store.put requires a record with id')
    return transaction(() => {
      const existing = stmts.get.get(record.id)
      if (existing === undefined) {
        stmts.insert.run(
          record.id, record.kind, record.scope, record.scopeKey, record.title, record.body, tagsOf(record),
          record.sourceSession ?? null, record.sourceTurn ?? null, record.sourceSeq ?? null,
          record.importance, record.confidence, record.status, record.supersedes ?? null,
          record.createdAt, record.updatedAt, record.lastUsedAt ?? null, record.useCount,
        )
        reindex(record.id)
        return { record: rowToRecord(stmts.get.get(record.id)), created: true }
      }
      stmts.update.run(
        record.kind, record.scope, record.scopeKey, record.title, record.body, tagsOf(record),
        record.sourceSession ?? null, record.sourceTurn ?? null, record.sourceSeq ?? null,
        record.importance, record.confidence, record.status, record.supersedes ?? null,
        record.updatedAt, record.lastUsedAt ?? null, record.useCount, record.id,
      )
      reindex(record.id)
      return { record: rowToRecord(stmts.get.get(record.id)), created: false }
    })
  }

  function get(id) {
    return rowToRecord(stmts.get.get(id))
  }

  function scopeClause(alias, scopes, params) {
    const parts = []
    for (const scope of scopes ?? []) {
      if (scope.scope === 'user') {
        parts.push(`${alias}.scope = 'user'`)
      } else if (scope.scope === 'workspace') {
        parts.push(`(${alias}.scope = 'workspace' AND ${alias}.scope_key = ?)`)
        params.push(scope.key)
      } else if (scope.scope === 'session') {
        parts.push(`(${alias}.scope = 'session' AND ${alias}.scope_key = ?)`)
        params.push(scope.key)
      }
    }
    return parts.length === 0 ? '0' : `(${parts.join(' OR ')})`
  }

  function isCjkChar(char) {
    const code = char.codePointAt(0)
    return (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0x3400 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xac00 && code <= 0xd7af)
  }

  /**
   * Build an OR-of-phrases FTS5 query. Latin words become whole phrases; CJK
   * runs become overlapping trigrams because the trigram tokenizer indexes
   * three-character windows, and a long CJK question is rarely one contiguous
   * phrase in the stored body.
   */
  function ftsExpression(text) {
    const segments = normalizeText(text).split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
    const terms = new Set()
    for (const segment of segments) {
      const chars = [...segment]
      if (chars.length < 3) continue
      if (chars.some(isCjkChar)) {
        for (let index = 0; index + 3 <= chars.length; index += 1) {
          terms.add(chars.slice(index, index + 3).join(''))
          if (terms.size >= 32) break
        }
      } else {
        terms.add(segment)
      }
      if (terms.size >= 32) break
    }
    if (terms.size === 0) return null
    return [...terms].map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
  }

  function search(options = {}) {
    const scopes = options.scopes ?? [{ scope: 'user', key: 'global' }]
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 5))
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : null
    const text = normalizeText(options.text)
    const candidateLimit = Math.max(20, limit * 4)
    const params = []
    let rows = []
    let usedFts = false

    if (text.length >= 3) {
      const expression = ftsExpression(text)
      try {
        if (expression !== null) {
          const where = [`records_fts MATCH ?`, `r.status = 'active'`, scopeClause('r', scopes, params)]
          const args = [expression]
          if (kinds) where.push(`r.kind IN (${kinds.map(() => '?').join(', ')})`)
          const sql = `SELECT ${recordColumns('r.')}, bm25(records_fts) AS bm25
            FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
            WHERE ${where.join(' AND ')}
            ORDER BY bm25(records_fts) ASC LIMIT ?`
          rows = db.prepare(sql).all(
            ...args,
            ...params,
            ...(kinds ?? []),
            candidateLimit,
          )
          usedFts = rows.length > 0
        }
      } catch (error) {
        logger?.warn?.('memory4: FTS search failed, falling back to LIKE: %o', error)
      }
    }

    if (!usedFts) {
      const likeParams = []
      const where = [`r.status = 'active'`, scopeClause('r', scopes, likeParams)]
      const args = []
      if (text.length > 0) {
        where.push('(r.title LIKE ? OR r.body LIKE ? OR r.tags LIKE ?)')
        const pattern = `%${text}%`
        args.push(pattern, pattern, pattern)
      }
      if (kinds) where.push(`r.kind IN (${kinds.map(() => '?').join(', ')})`)
      const sql = `SELECT ${recordColumns('r.')}, NULL AS bm25 FROM records r
        WHERE ${where.join(' AND ')}
        ORDER BY r.importance DESC, r.updated_at DESC LIMIT ?`
      rows = db.prepare(sql).all(...likeParams, ...args, ...(kinds ?? []), candidateLimit)
    }

    return rankCandidates(rows.map(rowToRecord), {
      halfLifeDays: options.halfLifeDays ?? 30,
    }).slice(0, limit)
  }

  function list(options = {}) {
    const scopes = options.scopes ?? [{ scope: 'user', key: 'global' }]
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20))
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : null
    const params = []
    const where = [`r.status = 'active'`, scopeClause('r', scopes, params)]
    if (kinds) where.push(`r.kind IN (${kinds.map(() => '?').join(', ')})`)
    const sql = `SELECT ${recordColumns('r.')} FROM records r
      WHERE ${where.join(' AND ')}
      ORDER BY r.importance DESC, r.updated_at DESC LIMIT ?`
    return db.prepare(sql).all(...params, ...(kinds ?? []), limit).map(rowToRecord)
  }

  /**
   * Administrator read used by the local Settings UI. Unlike `search`/`list`
   * this is not session-scoped: it serves the on-machine management page and
   * still returns only active rows.
   */
  function adminList(options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50))
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : null
    const text = normalizeText(options.text)
    const candidateLimit = Math.max(50, limit * 4)
    let rows = []
    let usedFts = false

    if (text.length >= 3) {
      const expression = ftsExpression(text)
      try {
        if (expression !== null) {
          const where = [`records_fts MATCH ?`, `r.status = 'active'`]
          if (kinds) where.push(`r.kind IN (${kinds.map(() => '?').join(', ')})`)
          const sql = `SELECT ${recordColumns('r.')}, bm25(records_fts) AS bm25
            FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
            WHERE ${where.join(' AND ')}
            ORDER BY bm25(records_fts) ASC LIMIT ?`
          rows = db.prepare(sql).all(expression, ...(kinds ?? []), candidateLimit)
          usedFts = rows.length > 0
        }
      } catch (error) {
        logger?.warn?.('memory4: admin FTS search failed, falling back to LIKE: %o', error)
      }
    }

    if (!usedFts) {
      const where = [`r.status = 'active'`]
      const args = []
      if (text.length > 0) {
        where.push('(r.title LIKE ? OR r.body LIKE ? OR r.tags LIKE ?)')
        const pattern = `%${text}%`
        args.push(pattern, pattern, pattern)
      }
      if (kinds) where.push(`r.kind IN (${kinds.map(() => '?').join(', ')})`)
      const sql = `SELECT ${recordColumns('r.')}, NULL AS bm25 FROM records r
        WHERE ${where.join(' AND ')}
        ORDER BY r.importance DESC, r.updated_at DESC LIMIT ?`
      rows = db.prepare(sql).all(...args, ...(kinds ?? []), candidateLimit)
    }

    return rankCandidates(rows.map(rowToRecord), {
      halfLifeDays: options.halfLifeDays ?? 30,
    }).slice(0, limit)
  }

  /** Lexical search fused with optional embedding similarity (in-process cosine). */
  function hybridSearch(options = {}) {
    const scopes = options.scopes ?? [{ scope: 'user', key: 'global' }]
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 5))
    const base = search({
      text: options.text,
      scopes,
      kinds: options.kinds,
      limit: Math.max(20, limit * 4),
      halfLifeDays: options.halfLifeDays,
    })
    return mergeVectors(base, {
      queryVector: options.queryVector,
      weight: options.weight,
      kinds: options.kinds,
      limit,
      accept: (record) => inScopes(record, scopes),
    })
  }

  /** Administrator variant of {@link hybridSearch}: no scope filter. */
  function hybridAdminList(options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50))
    const base = adminList({
      text: options.text,
      kinds: options.kinds,
      limit: Math.max(50, limit * 4),
      halfLifeDays: options.halfLifeDays,
    })
    return mergeVectors(base, {
      queryVector: options.queryVector,
      weight: options.weight,
      kinds: options.kinds,
      limit,
      accept: () => true,
    })
  }

  function forget(id) {
    if (typeof id !== 'string' || id.length === 0) return false
    return transaction(() => {
      const row = stmts.rowid.get(id)
      if (row === undefined) return false
      stmts.ftsDelete.run(row.rowid)
      stmts.vectorDelete.run(id)
      stmts.delete.run(id)
      return true
    })
  }

  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
    let dot = 0
    let normA = 0
    let normB = 0
    for (let index = 0; index < a.length; index += 1) {
      dot += a[index] * b[index]
      normA += a[index] * a[index]
      normB += b[index] * b[index]
    }
    if (normA === 0 || normB === 0) return 0
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  function inScopes(record, scopes) {
    return scopes.some((scope) => scope.scope === 'user'
      ? record.scope === 'user'
      : record.scope === scope.scope && record.scopeKey === scope.key)
  }

  function mergeVectors(baseRows, options) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 5))
    const queryVector = options.queryVector
    if (!Array.isArray(queryVector) || queryVector.length === 0) return baseRows.slice(0, limit)
    const weight = Math.max(0, Math.min(1, Number(options.weight) || 0))
    const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? new Set(options.kinds) : null
    const accept = typeof options.accept === 'function' ? options.accept : () => true
    const candidates = new Map(baseRows.map((row) => [row.id, row]))
    for (const { record, vector } of allVectors(1000)) {
      if (kinds !== null && !kinds.has(record.kind)) continue
      if (!accept(record)) continue
      const similarity = cosineSimilarity(queryVector, vector)
      if (similarity <= 0.05) continue
      const existing = candidates.get(record.id) ?? { ...record, score: 0, bm25: null }
      existing.vectorSimilarity = similarity
      candidates.set(record.id, existing)
    }
    const scored = [...candidates.values()].map((row) => {
      const lexical = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0
      const semantic = typeof row.vectorSimilarity === 'number' ? row.vectorSimilarity : 0
      return { ...row, score: Number(((1 - weight) * lexical + weight * semantic).toFixed(4)) }
    })
    scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    return scored.slice(0, limit)
  }

  function touch(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return
    const now = Date.now()
    transaction(() => {
      for (const id of ids) {
        try { stmts.touch.run(now, id) } catch { /* record vanished */ }
      }
    })
  }

  function addPin(pin) {
    const id = pinId(pin.text, pin.scope, pin.scopeKey)
    const createdAt = Date.now()
    stmts.pinInsert.run(id, normalizeText(pin.text), pin.scope, pin.scopeKey, createdAt)
    return { id, text: normalizeText(pin.text), scope: pin.scope, scopeKey: pin.scopeKey, createdAt }
  }

  function listPins(scopes) {
    const params = []
    const clause = scopeClause('p', scopes ?? [], params)
    const sql = `SELECT id, text, scope, scope_key AS scopeKey, created_at AS createdAt FROM pins p
      WHERE ${clause} ORDER BY p.created_at DESC`
    return db.prepare(sql).all(...params)
  }

  function removePin(id) {
    if (typeof id !== 'string' || id.length === 0) return false
    return stmts.pinDelete.run(id).changes > 0
  }

  function stats() {
    const byKind = {}
    for (const row of stmts.statsKind.all()) byKind[row.kind] = row.n
    const byScope = {}
    for (const row of stmts.statsScope.all()) byScope[row.scope] = row.n
    return {
      total: stmts.statsTotal.get().n,
      archived: stmts.statsArchived.get().n,
      byKind,
      byScope,
      pins: stmts.pinList.all().length,
      indexed: stmts.ftsCount.get().n,
      vectors: stmts.vectorCount.get().n,
      tokenizer,
      filePath,
    }
  }

  function exportAll() {
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      records: db.prepare(`SELECT ${recordColumns()} FROM records ORDER BY created_at ASC`).all(),
      pins: stmts.pinList.all(),
      skills: stmts.skillList.all(100),
      audit: stmts.auditList.all(200),
    }
  }

  function addAudit(action, recordId, actor, detail) {
    stmts.auditInsert.run(action, recordId ?? null, actor ?? 'system', detail ?? null, Date.now())
  }

  function listAudit(limit = 20) {
    return stmts.auditList.all(Math.max(1, Math.min(200, Number(limit) || 20)))
  }

  function bumpSkillEvidence(signature, sample) {
    const now = Date.now()
    stmts.evidenceUpsert.run(signature, now, now, String(sample ?? '').slice(0, 1000))
    return stmts.evidenceGet.get(signature)
  }

  function upsertSkill(skill) {
    const now = Date.now()
    stmts.skillInsert.run(skill.name, skill.description ?? '', skill.draftPath, skill.targetPath ?? null, skill.evidence ?? 0, now, now)
    return stmts.skillGet.get(skill.name)
  }

  function getSkill(name) {
    return stmts.skillGet.get(name) ?? null
  }

  function listSkills(limit = 50) {
    return stmts.skillList.all(Math.max(1, Math.min(100, Number(limit) || 50)))
  }

  function setSkillStatus(name, status, targetPath) {
    return stmts.skillStatus.run(status, targetPath ?? null, Date.now(), name).changes > 0
  }

  /**
   * Archive episodic records older than the cutoff. Archived rows stay in the
   * database for export/audit but are excluded from retrieval.
   * @param {number} cutoff epoch milliseconds
   * @returns {number} archived row count
   */
  function archiveEpisodicBefore(cutoff) {
    if (!Number.isFinite(cutoff)) return 0
    return transaction(() => stmts.archiveEpisodic.run(Date.now(), cutoff).changes)
  }

  function getMeta(key) {
    const row = stmts.metaGet.get(key)
    return row === undefined ? undefined : row.value
  }

  function setMeta(key, value) {
    stmts.metaSet.run(key, String(value))
  }

  function toBlob(vector) {
    const values = Float32Array.from(vector)
    return new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
  }

  function fromBlob(blob) {
    if (blob === null || blob === undefined) return []
    const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
    const aligned = bytes.slice()
    return Array.from(new Float32Array(aligned.buffer, 0, Math.floor(aligned.byteLength / 4)))
  }

  function putVector(recordId, vector, model) {
    if (typeof recordId !== 'string' || !Array.isArray(vector) || vector.length === 0) return false
    stmts.vectorUpsert.run(recordId, vector.length, model ?? '', toBlob(vector), Date.now())
    return true
  }

  function getVector(recordId) {
    const row = stmts.vectorGet.get(recordId)
    if (row === undefined) return null
    return { recordId: row.recordId, dim: row.dim, model: row.model, vector: fromBlob(row.vector), updatedAt: row.updatedAt }
  }

  /** All active records with a vector, for in-process cosine ranking. */
  function allVectors(limit = 500) {
    const rows = stmts.vectorAll.all(Math.max(1, Math.min(2000, Number(limit) || 500)))
    return rows.map((row) => ({
      record: rowToRecord(row),
      vector: fromBlob(row.vector),
      dim: row.dim,
      model: row.model,
      vectorUpdatedAt: row.vectorUpdatedAt,
    }))
  }

  function vectorCount() {
    return stmts.vectorCount.get().n
  }

  function close() {
    try { db.close() } catch { /* already closed */ }
  }

  return {
    filePath,
    put,
    get,
    search,
    list,
    adminList,
    hybridSearch,
    hybridAdminList,
    forget,
    touch,
    addPin,
    listPins,
    removePin,
    stats,
    exportAll,
    addAudit,
    listAudit,
    bumpSkillEvidence,
    upsertSkill,
    getSkill,
    listSkills,
    setSkillStatus,
    archiveEpisodicBefore,
    getMeta,
    setMeta,
    putVector,
    getVector,
    allVectors,
    vectorCount,
    close,
  }
}
