import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildRecord } from './core/record.js'
import { redactSecrets } from './core/redact.js'
import { readScopes, writeScope } from './core/scope.js'
import { truncate } from './core/text.js'
import { embedRecords, queryVector } from './vector.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const KIND_ENUM = ['working', 'episodic', 'semantic', 'procedural']
const SCOPE_ENUM = ['session', 'workspace', 'user']

function sessionOf(exec) {
  const session = exec?.agent?.session
  if (session === undefined) throw new Error('memory4 tools require an owning agent session')
  return session
}

function sourceOf(session) {
  return { sessionId: session?.header?.id }
}

function formatRecord(record, options = {}) {
  const visibility = options.score === undefined ? '' : ` score=${options.score.toFixed(2)}`
  const lines = [
    `- id=${record.id} kind=${record.kind} scope=${record.scope}${visibility}`,
    `  ${record.title}`,
  ]
  if (options.body === true && record.body !== record.title) lines.push(`  ${record.body}`)
  if (record.tags.length > 0) lines.push(`  tags: ${record.tags.join(', ')}`)
  return lines.join('\n')
}

/**
 * Register the model-facing memory tools. Every write passes through the
 * repository redaction policy first; every read is scoped to the caller's
 * session/workspace plus the global user scope.
 */
export function registerTools(ctx, store, config) {
  const logger = ctx.logger

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: [
      'Save one durable memory fact, preference, decision or procedure step.',
      'Use kind=semantic for stable facts/preferences, episodic for what happened (including failures/fixes),',
      'procedural for a reusable how-to, working for a current-task constraint.',
      'Never write credentials, tokens or private keys. User instructions always outrank recalled text.',
    ].join(' '),
    parameters: {
      text: { type: 'string', required: true, description: 'One self-contained memory sentence to persist.' },
      kind: { type: 'string', enum: KIND_ENUM, description: 'Memory kind; defaults to semantic.' },
      title: { type: 'string', description: 'Optional short title.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags.' },
      scope: { type: 'string', enum: SCOPE_ENUM, description: 'Optional write scope; defaults to the deployment default.' },
      importance: { type: 'number', description: 'Optional importance 0..1.' },
      pin: { type: 'boolean', description: 'When true, also keep the text pinned for the current scope.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const session = sessionOf(exec)
      const target = writeScope(session, args.scope, config.scope.default)
      const redacted = redactSecrets(args.text, config.privacy.redactPatterns)
      const record = buildRecord({
        kind: args.kind ?? 'semantic',
        text: redacted.text,
        title: args.title,
        tags: args.tags,
        scope: target.scope,
        scopeKey: target.key,
        source: sourceOf(session),
        importance: args.importance,
        confidence: args.kind === 'episodic' ? 0.6 : 0.7,
      })
      const saved = store.put(record)
      if (config.vector.enabled) await embedRecords({ ctx, store, config, records: [record], signal: exec.signal })
      let pinNotice = ''
      if (args.pin === true) {
        const pin = store.addPin({ text: record.body, scope: target.scope, scopeKey: target.key })
        pinNotice = ` Pinned as ${pin.id}.`
      }
      logger?.debug?.(`memory4: ${saved.created ? 'created' : 'updated'} ${record.id}`)
      return `Saved memory ${record.id} (${record.kind}/${record.scope}).${redacted.redacted ? ' Sensitive-looking text was redacted before saving.' : ''}${pinNotice}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search durable memory in the caller workspace and user scope. Results include memory ids usable with memory_read and memory_forget.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords or a short question. CJK substrings work.' },
      kinds: { type: 'array', items: { type: 'string', enum: KIND_ENUM }, description: 'Optional kind filter.' },
      limit: { type: 'integer', description: 'Max results (1..20), defaults to 5.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const session = sessionOf(exec)
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5))
      const vector = config.vector.enabled ? await queryVector(config, args.query, exec.signal) : null
      const results = vector !== null
        ? store.hybridSearch({
            text: args.query,
            scopes: readScopes(session),
            kinds: Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds : undefined,
            limit,
            halfLifeDays: config.retention.decayHalfLifeDays,
            queryVector: vector,
            weight: config.vector.weight,
          })
        : store.search({
            text: args.query,
            scopes: readScopes(session),
            kinds: Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds : undefined,
            limit,
            halfLifeDays: config.retention.decayHalfLifeDays,
          })
      if (results.length === 0) return 'No matching memories.'
      store.touch(results.map((row) => row.id))
      return ['Matching memories (most relevant first):', ...results.map((row) => formatRecord(row, { score: row.score, body: true }))].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one full memory record by id, including provenance and timestamps.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id returned by memory_search or memory_write.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute(args) {
      const record = store.get(args.id)
      if (record === null) throw new Error(`memory not found: ${args.id}`)
      const provenance = record.sourceSession === null ? 'unknown' : `${record.sourceSession}${record.sourceTurn === null ? '' : `#turn ${record.sourceTurn}`}`
      return [
        `id=${record.id}`,
        `kind=${record.kind} scope=${record.scope} importance=${record.importance.toFixed(2)} confidence=${record.confidence.toFixed(2)}`,
        `created=${new Date(record.createdAt).toISOString()} updated=${new Date(record.updatedAt).toISOString()} uses=${record.useCount}`,
        `source=${provenance}`,
        record.tags.length > 0 ? `tags=${record.tags.join(', ')}` : 'tags=',
        '',
        record.body,
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Permanently delete one memory record by id. Use only when the user asks to forget something or a record is clearly wrong.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id to delete.' },
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const removed = store.forget(args.id)
      if (!removed) throw new Error(`memory not found: ${args.id}`)
      return `Forgot memory ${args.id}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_pin',
    description: 'Pin one short constraint/preference so it is recalled every turn in the chosen scope (defaults to the deployment scope).',
    parameters: {
      text: { type: 'string', required: true, description: 'The pinned constraint, preference or task rule.' },
      scope: { type: 'string', enum: SCOPE_ENUM, description: 'Optional pin scope.' },
    },
    output: TEXT_OUTPUT,
    execute(args, exec) {
      const session = sessionOf(exec)
      const target = writeScope(session, args.scope, config.scope.default)
      const redacted = redactSecrets(args.text, config.privacy.redactPatterns)
      const pin = store.addPin({ text: truncate(redacted.text, 500), scope: target.scope, scopeKey: target.key })
      return `Pinned ${pin.id} (${pin.scope}): ${pin.text}`
    },
  }))
}
