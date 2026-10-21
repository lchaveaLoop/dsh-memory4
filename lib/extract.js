import { normalizeText } from './core/text.js'

const REMEMBER_CUE = /(记住|记下|记一下|别忘了|不要忘记|以后都|以后要|今后都|我们约定|约定好|规则是|务必|remember|don't forget)/i
const PREFERENCE_CUE = /(我喜欢|我偏好|我习惯|我更愿意|我们使用|我们默认|默认使用|默认用|prefer|i like|i prefer)/i
const DECISION_CUE = /(决定|确定用|就按|采用|方案定为|定了|最终选择|decided|we will use|chosen)/i
const ERROR_CUE = /(报错|错误|失败|异常|崩溃|超时|error|failed|failure|crash|timeout)/i
const FIX_CUE = /(修复|解决|改为|改用|换成|绕开|规避|fix|fixed|resolved|workaround)/i

function sentences(text) {
  return normalizeText(text)
    .split(/[。！？!?；;]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 6)
}

function firstMatchingSentence(texts, cue) {
  for (const text of texts) {
    for (const sentence of sentences(text)) {
      if (cue.test(sentence)) return sentence
    }
  }
  return null
}

function dedupe(candidates) {
  const seen = new Set()
  const out = []
  for (const candidate of candidates) {
    const key = normalizeText(candidate.text)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push({ ...candidate, text: key })
  }
  return out
}

/**
 * Rule-based candidate extraction (zero model calls).
 *
 * @param {object} options
 * @param {Array<{role: string, text: string}>} options.messages recent messages, oldest first
 * @param {{kind?: string}} [options.reason] turn/end reason
 * @param {number} [options.toolCount] tool calls observed in the turn
 * @param {number} [options.maxPerTurn]
 * @returns {Array<{kind: string, text: string, tags: string[], importance: number, confidence: number}>}
 */
export function extractCandidates(options) {
  const messages = options?.messages ?? []
  const maxPerTurn = Math.max(0, Math.min(20, Number(options?.maxPerTurn ?? 3)))
  if (maxPerTurn === 0) return []
  const userTexts = messages.filter((message) => message.role === 'user').map((message) => message.text)
  const assistantTexts = messages.filter((message) => message.role === 'assistant').map((message) => message.text)
  const toolTexts = messages.filter((message) => message.role === 'tool').map((message) => message.text)
  const candidates = []

  const remembered = firstMatchingSentence(userTexts.slice(-3), REMEMBER_CUE)
  if (remembered !== null) {
    candidates.push({ kind: 'semantic', text: `用户要求记住: ${remembered}`, tags: ['explicit'], importance: 0.85, confidence: 0.9 })
  }
  const preference = firstMatchingSentence(userTexts.slice(-3), PREFERENCE_CUE)
  if (preference !== null) {
    candidates.push({ kind: 'semantic', text: `用户偏好: ${preference}`, tags: ['preference'], importance: 0.7, confidence: 0.8 })
  }
  const decision = firstMatchingSentence(userTexts.slice(-3), DECISION_CUE)
  if (decision !== null) {
    candidates.push({ kind: 'semantic', text: `已定决策: ${decision}`, tags: ['decision'], importance: 0.8, confidence: 0.8 })
  }

  const errorText = firstMatchingSentence([...assistantTexts.slice(-2), ...toolTexts.slice(-2)], ERROR_CUE)
  const fixText = firstMatchingSentence([...assistantTexts.slice(-2), ...userTexts.slice(-2)], FIX_CUE)
  if (errorText !== null && fixText !== null) {
    candidates.push({ kind: 'episodic', text: `问题与处理: ${errorText} → ${fixText}`, tags: ['lesson', 'fix'], importance: 0.65, confidence: 0.7 })
  }

  const completed = options?.reason?.kind === undefined || options.reason.kind === 'complete' || options.reason.kind === 'completed'
  const lastUser = userTexts.at(-1) ?? ''
  const lastAssistant = assistantTexts.at(-1) ?? ''
  const toolCount = Number(options?.toolCount ?? 0)
  if (completed && lastAssistant.length >= 40 && (toolCount > 0 || lastUser.length >= 10)) {
    candidates.push({
      kind: 'episodic',
      text: `任务: ${lastUser.slice(0, 160)}；结果: ${lastAssistant.slice(0, 220)}`,
      tags: ['turn'],
      importance: 0.35,
      confidence: 0.6,
    })
  }

  return dedupe(candidates).slice(0, maxPerTurn)
}

export { REMEMBER_CUE, PREFERENCE_CUE, DECISION_CUE, ERROR_CUE, FIX_CUE }
