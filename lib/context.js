import { readScopes } from './core/scope.js'
import { truncate } from './core/text.js'

/** Recursively collect text from provider-neutral message content blocks. */
export function collectText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).filter(Boolean).join('\n')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (value.content !== undefined) return collectText(value.content, depth + 1)
    if (value.value !== undefined) return collectText(value.value, depth + 1)
  }
  return ''
}

/** Recent non-memory messages, oldest first. */
export function recentMessages(session, limit = 8) {
  let messages = []
  try {
    messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
  } catch {
    messages = []
  }
  const out = []
  for (let index = messages.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind === 'memory4') continue
    if (message?.role !== 'user' && message?.role !== 'assistant' && message?.role !== 'tool') continue
    const rawText = collectText(message?.content) || (typeof message?.text === 'string' ? message.text : '')
    const text = rawText.replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    out.unshift({ role: message.role, text })
  }
  return out
}

/** Read the working state exposed by the harness: goal, todos and pins. */
export function readWorkingState(ctx, store, session) {
  let goal = null
  try {
    goal = ctx.sessionProjections?.stateOf(session, 'goal')?.current ?? null
  } catch {
    goal = null
  }
  let todos = []
  try {
    const state = ctx.sessionProjections?.stateOf(session, 'todos')
    if (Array.isArray(state)) todos = state
  } catch {
    todos = []
  }
  let pins = []
  try {
    pins = store.listPins(readScopes(session))
  } catch {
    pins = []
  }
  return { goal, todos, pins, recent: recentMessages(session, 6) }
}

/** Render a compact four-section handoff card. */
export function renderHandoff(state, maxChars = 1600) {
  const lines = []
  const goalObjective = typeof state?.goal?.objective === 'string' ? state.goal.objective : ''
  const goalStatus = typeof state?.goal?.status === 'string' ? state.goal.status : ''
  lines.push(`## Goal${goalStatus.length > 0 ? ` (${goalStatus})` : ''}`)
  lines.push(goalObjective.length > 0 ? `- ${truncate(goalObjective, 200)}` : '- (no persisted goal)')

  lines.push('## Open tasks')
  const open = (state?.todos ?? []).filter((todo) => todo?.status !== 'completed')
  lines.push(open.length === 0 ? '- (none)' : '')
  for (const todo of open.slice(0, 8)) lines.push(`- [${todo.status}] ${truncate(todo.content, 120)}`)

  lines.push('## Pinned constraints')
  lines.push((state?.pins ?? []).length === 0 ? '- (none)' : '')
  for (const pin of (state?.pins ?? []).slice(0, 6)) lines.push(`- ${truncate(pin.text, 160)}`)

  lines.push('## Recent activity')
  const recent = state?.recent ?? []
  lines.push(recent.length === 0 ? '- (none)' : '')
  for (const message of recent.slice(-4)) lines.push(`- ${message.role}: ${truncate(message.text, 160)}`)

  let text = lines.join('\n')
  if (text.length > maxChars) text = `${truncate(text, maxChars)}\n…`
  return text
}
