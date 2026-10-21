import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { buildRecord } from './core/record.js'
import { redactSecrets } from './core/redact.js'
import { approveSkill, rejectSkill } from './procedure.js'
import { readScopes, writeScope } from './core/scope.js'
import { truncate } from './core/text.js'
import { reflectNow } from './distill.js'
import { parseMemoryMarkdown, recordsToMarkdown } from './markdown.js'
import { embedRecords, queryVector } from './vector.js'

function sessionOf(invocation) {
  return invocation?.agent?.session
}

function ok(text) {
  return { kind: 'success', text }
}

function fail(text) {
  return { kind: 'error', text }
}

function formatRecordRow(record, index) {
  const score = record.score === undefined ? '' : ` score=${record.score.toFixed(2)}`
  return `${index + 1}. ${record.id} [${record.kind}]${score}\n   ${truncate(record.title, 180)}`
}

function statusText(store, config) {
  const stats = store.stats()
  const kinds = Object.entries(stats.byKind).map(([kind, count]) => `${kind}=${count}`).join(' ') || 'none'
  const scopes = Object.entries(stats.byScope).map(([scope, count]) => `${scope}=${count}`).join(' ') || 'none'
  return [
    'dsh-memory4 status',
    `  store: ${stats.filePath}`,
    `  tokenizer: ${stats.tokenizer}`,
    `  records: ${stats.total} (${kinds})`,
    `  archived: ${stats.archived}`,
    `  scopes: ${scopes}`,
    `  pins: ${stats.pins}`,
    `  vectors: ${stats.vectors} (vector ${config.vector.enabled ? 'on' : 'off'}${config.vector.enabled ? `, ${config.vector.model}` : ''})`,
    `  recall: topK=${config.inject.topK} maxTokens=${config.inject.maxTokens} trigger=${config.inject.trigger}`,
    `  write: mode=${config.write.mode} maxPerTurn=${config.write.maxPerTurn}`,
    `  reflect: enabled=${config.reflect.enabled} auto=${config.reflect.auto} days=${config.reflect.days}`,
    `  procedure: enabled=${config.procedure.enabled} minEvidence=${config.procedure.minEvidence} target=${config.procedure.target}`,
  ].join('\n')
}

async function runMemoryCommand(ctx, store, config, invocation) {
  const session = sessionOf(invocation)
  const raw = String(invocation?.rawInput ?? '').trim()
  const [subcommand = 'help', ...rest] = raw.length === 0 ? ['status'] : raw.split(/\s+/)
  const argument = rest.join(' ').trim()
  const scopes = readScopes(session)

  switch (subcommand) {
    case 'status':
      return ok(statusText(store, config))

    case 'search': {
      if (argument.length === 0) return fail('Usage: /memory search <query>')
      const vector = config.vector.enabled ? await queryVector(config, argument) : null
      const results = vector !== null
        ? store.hybridSearch({
            text: argument,
            scopes,
            limit: 10,
            halfLifeDays: config.retention.decayHalfLifeDays,
            queryVector: vector,
            weight: config.vector.weight,
          })
        : store.search({
            text: argument,
            scopes,
            limit: 10,
            halfLifeDays: config.retention.decayHalfLifeDays,
          })
      if (results.length === 0) return ok('No matching memories.')
      store.touch(results.map((row) => row.id))
      return ok(['Matching memories:', ...results.map(formatRecordRow)].join('\n'))
    }

    case 'list': {
      const kinds = ['working', 'episodic', 'semantic', 'procedural'].includes(argument) ? [argument] : undefined
      const rows = store.list({ scopes, kinds, limit: 20 })
      if (rows.length === 0) return ok('No memories in scope.')
      return ok(['Recent memories:', ...rows.map(formatRecordRow)].join('\n'))
    }

    case 'forget': {
      if (argument.length === 0) return fail('Usage: /memory forget <id>')
      return store.forget(argument) ? ok(`Forgot memory ${argument}.`) : fail(`Memory not found: ${argument}`)
    }

    case 'pin': {
      if (argument.length === 0) return fail('Usage: /memory pin <text>')
      if (session === undefined) return fail('This command needs an owning session to resolve the pin scope.')
      const target = writeScope(session, undefined, config.scope.default)
      const redacted = redactSecrets(argument, config.privacy.redactPatterns)
      const pin = store.addPin({ text: truncate(redacted.text, 500), scope: target.scope, scopeKey: target.key })
      return ok(`Pinned ${pin.id} (${pin.scope}): ${pin.text}`)
    }

    case 'pins': {
      const pins = store.listPins(scopes)
      if (pins.length === 0) return ok('No pinned memories in scope.')
      return ok(['Pinned memories:', ...pins.map((pin, index) => `${index + 1}. ${pin.id} (${pin.scope})\n   ${pin.text}`)].join('\n'))
    }

    case 'export': {
      const directory = join(dirname(store.filePath), 'exports')
      mkdirSync(directory, { recursive: true })
      const format = argument.toLowerCase() === 'md' || argument.toLowerCase() === 'markdown' ? 'md' : 'json'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const payload = store.exportAll()
      if (format === 'md') {
        const target = join(directory, `memory4-export-${stamp}.md`)
        writeFileSync(target, recordsToMarkdown({ ...payload, config }), 'utf8')
        return ok(`Exported memory to ${target}`)
      }
      const target = join(directory, `memory4-export-${stamp}.json`)
      writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8')
      return ok(`Exported memory to ${target}`)
    }

    case 'import': {
      if (argument.length === 0) return fail('Usage: /memory import <file>')
      let text
      try {
        const info = statSync(argument)
        if (info.size > 2 * 1024 * 1024) return fail('Import file is too large (max 2 MB).')
        text = readFileSync(argument, 'utf8')
      } catch (error) {
        return fail(`Cannot read ${argument}: ${error instanceof Error ? error.message : String(error)}`)
      }
      let items = []
      let payload = null
      try { payload = JSON.parse(text) } catch { payload = null }
      if (payload !== null && Array.isArray(payload.records)) {
        items = payload.records
          .filter((record) => record !== null && typeof record === 'object' && typeof (record.body ?? record.text) === 'string')
          .map((record) => ({ kind: record.kind, text: record.body ?? record.text, tags: record.tags }))
      } else {
        items = parseMemoryMarkdown(text)
      }
      if (items.length === 0) return fail('No importable memory records found in the file.')
      const target = session === undefined
        ? { scope: 'user', key: 'global' }
        : writeScope(session, undefined, config.scope.default)
      let created = 0
      let updated = 0
      let skipped = 0
      const written = []
      for (const item of items.slice(0, 500)) {
        const redacted = redactSecrets(item.text, config.privacy.redactPatterns)
        const value = redacted.text.trim()
        if (value.length < 6) { skipped += 1; continue }
        const record = buildRecord({
          kind: item.kind,
          text: value,
          tags: item.tags,
          scope: target.scope,
          scopeKey: target.key,
          source: { sessionId: session?.header?.id },
          importance: 0.7,
          confidence: 0.6,
        })
        const existed = store.get(record.id) !== null
        store.put(record)
        written.push(record)
        if (existed) updated += 1
        else created += 1
      }
      if (config.vector.enabled && written.length > 0) {
        await embedRecords({ ctx, store, config, records: written })
      }
      store.addAudit('memory/import', null, 'user', `${argument} created=${created} updated=${updated} skipped=${skipped}`)
      return ok(`Imported memory: created ${created}, updated ${updated}, skipped ${skipped}.`)
    }

    case 'reindex': {
      if (!config.vector.enabled) return fail('Vector retrieval is disabled (set vector.enabled=true first).')
      const records = store.adminList({ limit: 200 })
      const embedded = await embedRecords({ ctx, store, config, records })
      store.addAudit('memory/reindex', null, 'user', `embedded=${embedded}/${records.length}`)
      return ok(`Embedded ${embedded}/${records.length} record(s) with ${config.vector.model}. Run again for more if the store is larger.`)
    }

    case 'reflect': {
      const days = Number(argument) > 0 ? Number(argument) : config.reflect.days
      const result = await reflectNow({ ctx, store, config, session, days, force: true })
      return result.ok
        ? ok(`Reflection created ${result.created} lesson(s), skipped ${result.skipped} (from ${result.episodes} episodes; ${result.provider}/${result.model}).`)
        : fail(`Reflection skipped: ${result.reason}`)
    }

    case 'skills': {
      const [action = 'list', name = ''] = argument.split(/\s+/).filter(Boolean)
      if (action === 'approve') {
        if (name.length === 0) return fail('Usage: /memory skills approve <name>')
        const result = approveSkill({
          store,
          config,
          name,
          workspace: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
        })
        return result.ok ? ok(`Approved skill ${result.name} -> ${result.targetPath}`) : fail(result.reason)
      }
      if (action === 'reject') {
        if (name.length === 0) return fail('Usage: /memory skills reject <name>')
        const result = rejectSkill({ store, name })
        return result.ok ? ok(`Rejected skill ${result.name}.`) : fail(result.reason)
      }
      const skills = store.listSkills(50)
      if (skills.length === 0) return ok('No generated skills yet. Repeating the same successful tool sequence enough times creates a draft.')
      return ok([
        'Generated skills (drafts require approval):',
        ...skills.map((skill, index) => `${index + 1}. ${skill.name} [${skill.status}] evidence=${skill.evidence}\n   ${skill.description}\n   draft: ${skill.draftPath}${skill.targetPath === null ? '' : `\n   active: ${skill.targetPath}`}`),
        '',
        'Approve with: /memory skills approve <name>',
      ].join('\n'))
    }

    case 'prune': {
      const days = Number(argument) > 0 ? Number(argument) : config.retention.episodicDays
      const cutoff = Date.now() - days * 86_400_000
      const archived = store.archiveEpisodicBefore(cutoff)
      if (archived > 0) store.addAudit('memory/retention-archive', null, 'user', `archived ${archived} episodic record(s) older than ${days}d`)
      return ok(`Archived ${archived} episodic record(s) older than ${days} day(s).`)
    }

    case 'log': {
      const limit = Math.max(1, Math.min(100, Number(argument) || 20))
      const rows = store.listAudit(limit)
      if (rows.length === 0) return ok('No audit records yet.')
      return ok(['Recent memory activity:', ...rows.map((row) => `${new Date(row.createdAt).toISOString()} ${row.action} ${row.recordId ?? ''} ${row.detail ?? ''}`.trim())].join('\n'))
    }

    case 'help':
    default:
      return ok([
        'Usage: /memory <subcommand>',
        '  status              show store and policy status',
        '  search <query>      search memories in scope',
        '  list [kind]         list recent memories (working|episodic|semantic|procedural)',
        '  forget <id>         delete one memory record',
        '  pin <text>          pin a constraint/preference',
        '  pins                list pinned memories',
        '  skills [list|approve <name>|reject <name>]  manage generated SKILL.md drafts',
        '  prune [days]        archive stale episodic memories (default retention.episodicDays)',
        '  reflect [days]      distill recent episodes into semantic lessons (LLM)',
        '  export [json|md]    export all memories (default JSON)',
        '  import <file>       import a JSON export or Markdown memory file',
        '  reindex             embed existing memories (vector.enabled required)',
        '  log [n]             show recent automatic memory activity',
        '',
        'Also: /remember <text>  save a semantic memory explicitly.',
      ].join('\n'))
  }
}

async function runRememberCommand(ctx, store, config, invocation) {
  const session = sessionOf(invocation)
  if (session === undefined) return fail('This command needs an owning session.')
  const raw = String(invocation?.rawInput ?? '').trim()
  if (raw.length === 0) return fail('Usage: /remember <text to remember>')
  const target = writeScope(session, undefined, config.scope.default)
  const redacted = redactSecrets(raw, config.privacy.redactPatterns)
  const record = buildRecord({
    kind: 'semantic',
    text: redacted.text,
    scope: target.scope,
    scopeKey: target.key,
    source: { sessionId: session?.header?.id },
    importance: 0.75,
    confidence: 0.9,
  })
  store.put(record)
  if (config.vector.enabled) await embedRecords({ ctx, store, config, records: [record] })
  return ok(`Saved memory ${record.id} (semantic/${record.scope}).${redacted.redacted ? ' Sensitive-looking text was redacted.' : ''}`)
}

/** Register `/memory` and `/remember` for every composed human-command adapter. */
export function registerCommands(ctx, store, config) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('dsh-memory4/memory'),
      name: 'memory',
      description: 'Inspect, search, pin, forget or export durable memories',
      handler: (invocation) => runMemoryCommand(ctx, store, config, invocation),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('dsh-memory4/remember'),
      name: 'remember',
      description: 'Save an explicit semantic memory',
      handler: (invocation) => runRememberCommand(ctx, store, config, invocation),
    })
  }, 'memory4 commands')
}
