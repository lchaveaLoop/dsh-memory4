/**
 * Deterministic candidate ranking.
 *
 * Retrieval is FTS5 first (BM25); the final order mixes lexical relevance with
 * importance, recency and actual use so a pinned project convention can beat a
 * slightly better keyword hit from a stale note.
 */

function recencyScore(updatedAt, now, halfLifeDays) {
  if (!Number.isFinite(updatedAt)) return 0
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
  const halfLife = Math.max(1, halfLifeDays)
  return Math.exp((-Math.LN2 * ageDays) / halfLife)
}

function lexicalScore(bm25) {
  if (!Number.isFinite(bm25)) return 0
  // SQLite FTS5 bm25(): lower (more negative) is better.
  const positive = Math.max(0, -bm25)
  return positive / (positive + 1)
}

/**
 * @param {Array<object>} candidates record rows, optionally with `bm25`
 * @param {{ now?: number, halfLifeDays?: number }} [options]
 * @returns {Array<object>} new array sorted best-first with `score` attached
 */
export function rankCandidates(candidates, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const halfLifeDays = Number.isFinite(options.halfLifeDays) ? options.halfLifeDays : 30
  const ranked = candidates.map((row) => {
    const lexical = lexicalScore(row.bm25)
    const importance = clamp01(row.importance, 0.5)
    const recency = recencyScore(row.updatedAt, now, halfLifeDays)
    const usage = Math.min(1, Math.log1p(Math.max(0, row.useCount ?? 0)) / Math.log(11))
    const score = 0.55 * lexical + 0.25 * importance + 0.12 * recency + 0.08 * usage
    return { ...row, score: Number(score.toFixed(4)) }
  })
  ranked.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
  return ranked
}

function clamp01(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return n < 0 ? 0 : n > 1 ? 1 : n
}
