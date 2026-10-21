import { createHash } from 'node:crypto'
import { normalizeText } from './text.js'

/** Supported memory kinds. */
export const KINDS = Object.freeze(['working', 'episodic', 'semantic', 'procedural'])

/** Kinds that may be written through the generic tools/tests. */
export function isKind(value) {
  return typeof value === 'string' && KINDS.includes(value)
}

/** Persistable, injectable one-line memory text. */
export function cleanText(value, maxChars = 4000) {
  const text = normalizeText(value)
  if (text.length === 0) throw new TypeError('memory text must be a non-empty string')
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** Normalize tags into a stable, deduped array. */
export function cleanTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const value = tag.trim().toLowerCase()
    if (value.length > 0 && value.length <= 64) seen.add(value)
  }
  return [...seen].sort()
}

/** Stable content identity: same kind/scope/text replaces the same row. */
export function recordId(kind, scope, scopeKey, text) {
  return createHash('sha256')
    .update([kind, scope, scopeKey, normalizeText(text)].join('\u0000'))
    .digest('hex')
    .slice(0, 24)
}

/** Default importance by kind; explicit callers may override. */
export function defaultImportance(kind) {
  switch (kind) {
    case 'working': return 0.8
    case 'episodic': return 0.4
    case 'procedural': return 0.8
    default: return 0.6
  }
}

/** Short title derived from the memory body. */
export function defaultTitle(text) {
  return text.length > 72 ? `${text.slice(0, 72)}…` : text
}

/**
 * Build one canonical record row. `source` carries optional provenance:
 * `{ sessionId, turn, seq }`.
 */
export function buildRecord(input) {
  const kind = isKind(input.kind) ? input.kind : 'semantic'
  const text = cleanText(input.text)
  const scope = input.scope ?? 'workspace'
  const scopeKey = input.scopeKey ?? 'unknown'
  const now = Date.now()
  return {
    id: input.id ?? recordId(kind, scope, scopeKey, text),
    kind,
    scope,
    scopeKey,
    title: input.title ? cleanText(input.title, 200) : defaultTitle(text),
    body: text,
    tags: cleanTags(input.tags),
    sourceSession: input.source?.sessionId ?? null,
    sourceTurn: Number.isInteger(input.source?.turn) ? input.source.turn : null,
    sourceSeq: Number.isInteger(input.source?.seq) ? input.source.seq : null,
    importance: clamp01(input.importance ?? defaultImportance(kind)),
    confidence: clamp01(input.confidence ?? 0.7),
    status: input.status ?? 'active',
    supersedes: input.supersedes ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    lastUsedAt: input.lastUsedAt ?? null,
    useCount: Number.isInteger(input.useCount) ? input.useCount : 0,
  }
}

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.5
  return n < 0 ? 0 : n > 1 ? 1 : n
}
