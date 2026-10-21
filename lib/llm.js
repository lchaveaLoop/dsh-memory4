import { BlockAssembler } from '@deepseek-ai/dsh-llm'

/**
 * Resolve the LLM seam without a Cordis `inject` declaration. `ctx.get(name,
 * false)` is the supported optional-service accessor; a direct `ctx.llm`
 * property read throws "cannot get property ... without inject".
 */
function llmServiceOf(ctx) {
  if (typeof ctx?.get === 'function') {
    const service = ctx.get('llm', false)
    if (service !== undefined && service !== null) return service
  }
  return ctx?.llm
}

/** True when the composed host exposes the LLM seam. */
export function llmAvailable(ctx) {
  return typeof llmServiceOf(ctx)?.stream === 'function'
}

/**
 * Resolve the provider/model pair used by memory distillation. Explicit config
 * wins; otherwise the session's latest routed request header is reused; for the
 * Settings page (no owning session) the latest live session route is reused.
 */
export function resolveModelTarget(config, session, ctx) {
  const provider = config?.write?.distillProvider ?? ''
  const model = config?.write?.distillModel ?? ''
  if (provider.length > 0 && model.length > 0) return { provider, model, source: 'config' }
  try {
    const routed = session?.requestHeader?.()?.config
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model, source: 'route' }
  } catch {
    /* no routed request yet */
  }
  try {
    const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions', false) : undefined
    const live = typeof sessions?.list === 'function' ? sessions.list() : []
    for (let index = live.length - 1; index >= 0; index -= 1) {
      const routed = live[index]?.requestHeader?.()?.config
      if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model, source: 'live-session' }
    }
  } catch {
    /* session registry unavailable */
  }
  return null
}

/**
 * One auxiliary text-only model call. Never throws for provider errors; returns
 * `{ text: '', error }` so callers can degrade to deterministic rules.
 */
export async function streamText(ctx, target, prompt, options = {}) {
  const llm = llmServiceOf(ctx)
  if (typeof llm?.stream !== 'function') return { text: '', error: 'LLM service unavailable' }
  const assembler = new BlockAssembler()
  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000
  const timer = setTimeout(() => controller.abort(new Error('memory4: llm timeout')), timeoutMs)
  const signal = options.signal !== undefined
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  try {
    const streamOptions = {
      provider: target.provider,
      model: target.model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      }],
      maxTokens: Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 512,
      signal,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    }
    for await (const chunk of llm.stream(streamOptions)) assembler.push(chunk)
    const blocks = assembler.blocks()
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length === 0) return { text: '', error: 'empty model output' }
    return { text, error: undefined }
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Collect balanced top-level JSON object/array snippets from arbitrary model text. */
function collectJsonSnippets(text) {
  const snippets = []
  const stack = []
  let inString = false
  let escaped = false
  let start = -1
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      if (stack.length === 0) start = index
      stack.push(char)
      continue
    }
    if (char === '}' || char === ']') {
      if (stack.length === 0) continue
      const open = stack.pop()
      const matches = (char === '}' && open === '{') || (char === ']' && open === '[')
      if (!matches) {
        stack.length = 0
        start = -1
        continue
      }
      if (stack.length === 0 && start >= 0) {
        snippets.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return snippets
}

function payloadRank(value) {
  if (Array.isArray(value)) return 2
  if (value !== null && typeof value === 'object') {
    for (const key of ['lessons', 'candidates', 'items', 'memories', 'data', 'results']) {
      if (Array.isArray(value[key])) return 3
    }
    return 1
  }
  return 0
}

/**
 * Extract the most useful JSON payload from a model reply.
 *
 * Models frequently wrap JSON in prose or code fences, emit an array instead of
 * the requested object, or return one of several common envelopes. This scans
 * balanced snippets and prefers an object carrying a known list field.
 */
export function parseJsonPayload(text) {
  if (typeof text !== 'string') return null
  const value = text.trim()
  if (value.length === 0) return null
  try {
    return JSON.parse(value)
  } catch {
    /* not pure JSON */
  }
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced !== null) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      /* fall through to balanced scanning */
    }
  }
  const parsed = []
  for (const snippet of collectJsonSnippets(value)) {
    try {
      parsed.push(JSON.parse(snippet))
    } catch {
      /* skip malformed snippet */
    }
  }
  parsed.sort((a, b) => payloadRank(b) - payloadRank(a))
  return parsed[0] ?? null
}
