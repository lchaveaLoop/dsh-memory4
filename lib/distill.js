import { buildRecord, KINDS } from './core/record.js'
import { redactSecrets } from './core/redact.js'
import { writeScope } from './core/scope.js'
import { truncate } from './core/text.js'
import { recentMessages } from './context.js'
import { llmAvailable, parseJsonPayload, resolveModelTarget, streamText } from './llm.js'
import { embedRecords } from './vector.js'

const DISTILL_PROMPT = `你是 DSH memory4 的记忆提炼器。阅读最近一轮对话，输出最多 %MAX% 条值得长期保存的记忆。
只输出 JSON 数组，不要解释。每项格式：
{"kind":"semantic|episodic|procedural|working","text":"一句自包含的中文或原文语言记忆","tags":["小写标签"],"importance":0.0到1.0,"confidence":0.0到1.0}
规则：
- 只保存稳定事实、用户偏好、已定决策、失败教训或可复用流程；不要保存寒暄与临时闲聊。
- 不要写入密钥、Token、密码、私钥等敏感信息。
- 每条 text 必须能脱离上下文独立理解，不超过 200 字。
对话：
%DIALOG%`

const REFLECT_PROMPT = `你是 DSH memory4 的反思整理器。阅读最近的“情景记忆”，提炼最多 %MAX% 条跨会话可复用的教训或结论。
输出格式（必须严格遵守）：
- 只输出一个 JSON 对象，形如 {"lessons":[{"text":"一句可复用结论","tags":["小写标签"]}]}
- 不要在 JSON 前后输出任何解释、Markdown 代码块或标题
- 如果没有可提炼的结论，输出 {"lessons":[]}
- 结论要具体、可执行、去重；不要复述原始任务流水
- 不要写入密钥、Token、密码等敏感信息
- 每条不超过 160 字
情景记忆：
%EPISODES%`

function clamp01(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return number < 0 ? 0 : number > 1 ? 1 : number
}

function normalizeKind(value) {
  return KINDS.includes(value) ? value : 'semantic'
}

function cleanTags(value) {
  if (!Array.isArray(value)) return []
  return value.filter((tag) => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim().toLowerCase()).slice(0, 8)
}

/** Normalize the many shapes a model may use for a candidate list. */
function normalizeCandidateList(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object') {
    for (const key of ['candidates', 'items', 'memories', 'data', 'results', 'lessons']) {
      if (Array.isArray(parsed[key])) return parsed[key]
    }
    if (typeof parsed.text === 'string') return [parsed]
  }
  return null
}

/** Normalize the many shapes a model may use for a lessons list. */
function normalizeLessons(parsed) {
  if (parsed === null || parsed === undefined) return null
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => (typeof item === 'string' ? { text: item } : item))
      .filter((item) => item !== null && typeof item === 'object')
  }
  if (typeof parsed === 'object') {
    for (const key of ['lessons', 'items', 'memories', 'results', 'data']) {
      if (Array.isArray(parsed[key])) return normalizeLessons(parsed[key])
    }
    if (typeof parsed.text === 'string') return [parsed]
  }
  return null
}

/** Last-resort extraction: bullet or numbered lines from a prose reply. */
function lessonsFromText(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*•]|\d+[.)、])\s+(.+?)\s*$/)
    if (match === null) continue
    const value = match[1].replace(/^["'`]+|["'`]+$/g, '').trim()
    if (value.length < 6) continue
    if (/^(?:name|tags|text|json|lessons|scope|importance)\b/i.test(value) && value.length < 40) continue
    out.push({ text: value })
    if (out.length >= 8) break
  }
  return out.length > 0 ? out : null
}

/**
 * Ask the routed model to distill the just-finished turn into memory candidates.
 * Returns null when LLM distillation is unavailable or unusable, so the caller
 * can fall back to deterministic rules.
 */
export async function distillCandidates(options) {
  const { ctx, config, session } = options
  if (!llmAvailable(ctx)) return null
  const target = resolveModelTarget(config, session, ctx)
  if (target === null) return null
  const dialog = recentMessages(session, 12)
    .map((message) => `${message.role}: ${truncate(message.text, 400)}`)
    .join('\n')
  if (dialog.trim().length === 0) return null
  const prompt = DISTILL_PROMPT
    .replace('%MAX%', String(Math.max(1, config.write.maxPerTurn)))
    .replace('%DIALOG%', dialog)
  const result = await streamText(ctx, target, prompt, {
    maxTokens: config.write.distillMaxTokens,
    timeoutMs: config.write.distillTimeoutMs,
    sessionId: session?.header?.id,
    purpose: 'memory4-distill',
    signal: options.signal,
  })
  if (result.error !== undefined) {
    ctx.logger?.warn?.('memory4: LLM distillation failed, falling back to rules: %s', result.error)
    return null
  }
  const parsed = parseJsonPayload(result.text)
  const list = normalizeCandidateList(parsed)
  if (list === null) return null
  const candidates = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || typeof item.text !== 'string') continue
    const redacted = redactSecrets(item.text, config.privacy.redactPatterns)
    const text = redacted.text.trim()
    if (text.length < 6) continue
    candidates.push({
      kind: normalizeKind(item.kind),
      text,
      tags: ['llm', ...cleanTags(item.tags)],
      importance: clamp01(item.importance, 0.6),
      confidence: clamp01(item.confidence, 0.7),
    })
  }
  return candidates.length > 0 ? candidates.slice(0, config.write.maxPerTurn) : null
}

/**
 * Reflect over recent episodic memories and persist the distilled lessons as
 * semantic memories. Returns a structured result; never throws for expected
 * provider problems.
 */
export async function reflectNow(options) {
  const { ctx, store, config, session } = options
  if (!llmAvailable(ctx)) return { ok: false, reason: 'LLM service unavailable' }
  const target = resolveModelTarget(config, session, ctx)
  if (target === null) return { ok: false, reason: 'no provider/model target (set write.distillProvider/Model or route one request)' }
  const days = Number(options.days) > 0 ? Number(options.days) : config.reflect.days
  const cutoff = Date.now() - days * 86_400_000
  const episodes = store.adminList({ kinds: ['episodic'], limit: 200, halfLifeDays: 3650 })
    .filter((record) => record.updatedAt >= cutoff)
  if (episodes.length === 0) return { ok: false, reason: 'no episodic memories in the reflection window' }
  if (options.force !== true && episodes.length < config.reflect.minEpisodes) {
    return { ok: false, reason: `not enough episodic memories (${episodes.length}/${config.reflect.minEpisodes})` }
  }
  const prompt = REFLECT_PROMPT
    .replace('%MAX%', String(Math.max(1, config.reflect.maxItems)))
    .replace('%EPISODES%', episodes.slice(0, 30).map((record) => `- ${truncate(record.body, 280)}`).join('\n'))
  const result = await streamText(ctx, target, prompt, {
    maxTokens: config.reflect.maxTokens,
    timeoutMs: config.write.distillTimeoutMs,
    sessionId: session?.header?.id,
    purpose: 'memory4-reflect',
    signal: options.signal,
  })
  if (result.error !== undefined) return { ok: false, reason: result.error }
  let lessons = normalizeLessons(parseJsonPayload(result.text))
  let repaired = false
  if (lessons === null) {
    const repairPrompt = `下面是一段模型输出。请严格改写成 JSON 对象：{"lessons":[{"text":"一句可复用结论","tags":["标签"]}]}。
只输出 JSON，不要 Markdown 代码块、不要解释；如果没有结论，输出 {"lessons":[]}。
原输出：
${truncate(result.text, 4000)}`
    const repairedResult = await streamText(ctx, target, repairPrompt, {
      maxTokens: config.reflect.maxTokens,
      timeoutMs: config.write.distillTimeoutMs,
      sessionId: session?.header?.id,
      signal: options.signal,
    })
    if (repairedResult.error === undefined) {
      lessons = normalizeLessons(parseJsonPayload(repairedResult.text))
      repaired = lessons !== null
    }
  }
  if (lessons === null) lessons = lessonsFromText(result.text)
  if (lessons === null) {
    store.addAudit('memory/reflection-parse-failed', null, 'memory4', truncate(result.text, 1000))
    return { ok: false, reason: `model output was not a lessons array (${truncate(result.text.replace(/\s+/g, ' '), 120)})` }
  }
  if (repaired) store.addAudit('memory/reflection-repair', null, 'memory4', 'repaired a non-JSON reflection reply')

  const targetScope = session?.header?.cwd
    ? writeScope(session, 'workspace', 'workspace')
    : writeScope(session, 'user', 'user')
  let created = 0
  let skipped = 0
  const written = []
  for (const item of lessons.slice(0, config.reflect.maxItems)) {
    if (item === null || typeof item !== 'object' || typeof item.text !== 'string') { skipped += 1; continue }
    const redacted = redactSecrets(item.text, config.privacy.redactPatterns)
    const text = redacted.text.trim()
    if (text.length < 6) { skipped += 1; continue }
    const record = buildRecord({
      kind: 'semantic',
      text,
      title: `反思: ${truncate(text, 60)}`,
      tags: ['reflection', ...cleanTags(item.tags)],
      scope: targetScope.scope,
      scopeKey: targetScope.key,
      source: { sessionId: session?.header?.id },
      importance: 0.75,
      confidence: 0.75,
    })
    const existed = store.get(record.id) !== null
    store.put(record)
    if (existed) skipped += 1
    else { created += 1; written.push(record) }
  }
  store.addAudit('memory/reflection', null, 'memory4', `days=${days} episodes=${episodes.length} created=${created} skipped=${skipped}`)
  store.setMeta('last_reflection_at', String(Date.now()))
  if (written.length > 0 && config.vector.enabled) {
    await embedRecords({ ctx, store, config, records: written })
  }
  return { ok: true, created, skipped, episodes: episodes.length, provider: target.provider, model: target.model }
}
