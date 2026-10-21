/** Collapse whitespace so identity and dedupe see one canonical form. */
export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Truncate on a code-point boundary, appending an ellipsis when shortened. */
export function truncate(value, maxChars) {
  const text = String(value ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}
