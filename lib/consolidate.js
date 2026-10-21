import { buildRecord } from './core/record.js'
import { redactSecrets } from './core/redact.js'
import { workspaceKeyOf, writeScope } from './core/scope.js'
import { readWorkingState, recentMessages, renderHandoff } from './context.js'
import { extractCandidates } from './extract.js'
import { crystallizeSkill } from './procedure.js'
import { truncate } from './core/text.js'
import { distillCandidates, reflectNow } from './distill.js'
import { embedRecords } from './vector.js'

function dedupeCandidates(candidates) {
  const seen = new Set()
  const out = []
  for (const candidate of candidates) {
    const key = candidate.text.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

/**
 * Automatic write policy and compaction integration.
 *
 * Everything runs off the append-only session event feed: `turn/end` extracts
 * candidates from the just-finished turn, `compaction/start` snapshots the
 * working state into a handoff card before the host summarizes, and
 * `compaction/summary` stores the resulting summary as an episodic record.
 */
export function installConsolidation(ctx, store, config, tracker) {
  const chains = new Map()
  const logger = ctx.logger

  function enqueue(session, task) {
    const key = session?.header?.id ?? 'unknown'
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch((error) => logger?.warn?.('memory4: consolidation failed: %o', error))
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key)
      })
    chains.set(key, next)
  }

  function writeCandidate(session, candidate) {
    const redacted = redactSecrets(candidate.text, config.privacy.redactPatterns)
    if (redacted.text.trim().length === 0) return null
    const target = candidate.kind === 'episodic'
      ? writeScope(session, 'workspace', 'workspace')
      : writeScope(session, undefined, config.scope.default)
    const record = buildRecord({
      kind: candidate.kind,
      text: redacted.text,
      tags: candidate.tags,
      scope: target.scope,
      scopeKey: target.key,
      source: { sessionId: session?.header?.id },
      importance: candidate.importance,
      confidence: candidate.confidence,
    })
    const saved = store.put(record)
    store.addAudit('memory/auto-write', record.id, 'memory4', `${candidate.kind}/${saved.created ? 'created' : 'updated'}`)
    return record
  }

  function onTurnEnd(session, event) {
    if (config.write.mode === 'off') return
    const turnState = tracker?.take?.(session) ?? null
    const reason = event?.data?.reason
    enqueue(session, async () => {
      const messages = recentMessages(session, 10)
      const rules = extractCandidates({
        messages,
        reason,
        toolCount: Array.isArray(turnState?.tools) ? turnState.tools.length : 0,
        maxPerTurn: config.write.maxPerTurn,
      })
      let candidates = rules
      if (config.write.mode === 'llm' || config.write.mode === 'hybrid') {
        const distilled = await distillCandidates({ ctx, config, session })
        if (distilled !== null) {
          candidates = config.write.mode === 'llm'
            ? distilled
            : dedupeCandidates([...rules, ...distilled]).slice(0, config.write.maxPerTurn)
        } else if (config.write.mode === 'llm') {
          candidates = rules
        }
      }

      const written = []
      for (const candidate of candidates) {
        const record = writeCandidate(session, candidate)
        if (record !== null) written.push(record)
      }
      crystallizeSkill({ store, config, session, turnState })

      if (written.length > 0 && config.vector.enabled) {
        await embedRecords({ ctx, store, config, records: written })
      }
      await maybeAutoReflect(session)
    })
  }

  async function maybeAutoReflect(session) {
    if (!config.reflect.enabled || !config.reflect.auto) return
    const lastAttempt = Number(store.getMeta('last_reflection_attempt_at') ?? 0)
    const interval = config.reflect.intervalHours * 3_600_000
    if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < interval) return
    store.setMeta('last_reflection_attempt_at', String(Date.now()))
    const result = await reflectNow({ ctx, store, config, session, days: config.reflect.days })
    if (!result.ok) logger?.debug?.('memory4: reflection skipped: %s', result.reason)
  }

  function onCompactionStart(session, event) {
    if (!config.compact.captureOnCompaction) return
    let handoff = ''
    try {
      const state = readWorkingState(ctx, store, session)
      handoff = renderHandoff(state, Math.max(200, config.compact.handoffMaxTokens * 2))
    } catch (error) {
      logger?.warn?.('memory4: handoff snapshot failed: %o', error)
      return
    }
    enqueue(session, () => {
      const redacted = redactSecrets(handoff, config.privacy.redactPatterns)
      const target = writeScope(session, 'session', 'session')
      const record = buildRecord({
        kind: 'working',
        text: redacted.text,
        title: `Handoff before compaction ${event?.data?.compactionId ?? ''}`.trim(),
        tags: ['handoff', 'compaction'],
        scope: target.scope,
        scopeKey: target.key,
        source: { sessionId: session?.header?.id },
        importance: 0.95,
        confidence: 0.95,
      })
      const saved = store.put(record)
      store.addAudit('memory/compaction-handoff', record.id, 'memory4', `compaction=${event?.data?.compactionId ?? 'unknown'} ${saved.created ? 'created' : 'updated'}`)
    })
  }

  function onCompactionSummary(session, event) {
    if (!config.compact.captureOnCompaction) return
    const summary = typeof event?.data?.summary === 'string' ? event.data.summary : ''
    if (summary.trim().length === 0) return
    enqueue(session, async () => {
      const redacted = redactSecrets(summary, config.privacy.redactPatterns)
      const record = buildRecord({
        kind: 'episodic',
        text: `压缩摘要: ${truncate(redacted.text, 1800)}`,
        title: `Compaction summary ${event?.data?.compactionId ?? ''}`.trim(),
        tags: ['compaction', 'summary'],
        scope: 'workspace',
        scopeKey: workspaceKeyOf(session),
        source: { sessionId: session?.header?.id },
        importance: 0.5,
        confidence: 0.7,
      })
      const saved = store.put(record)
      store.addAudit('memory/compaction-episode', record.id, 'memory4', `compaction=${event?.data?.compactionId ?? 'unknown'} ${saved.created ? 'created' : 'updated'}`)
      if (config.vector.enabled) await embedRecords({ ctx, store, config, records: [record] })
    })
  }

  ctx.on('session/event', (session, event) => {
    try {
      switch (event?.type) {
        case 'turn/end':
          onTurnEnd(session, event)
          break
        case 'compaction/start':
          onCompactionStart(session, event)
          break
        case 'compaction/summary':
          onCompactionSummary(session, event)
          break
        default:
          break
      }
    } catch (error) {
      logger?.warn?.('memory4: session-event consolidation failed: %o', error)
    }
  })

  return {
    flush() {
      return Promise.allSettled([...chains.values()])
    },
  }
}
