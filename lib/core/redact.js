/**
 * Conservative secret scrubbing applied before any memory text is persisted.
 *
 * The goal is to stop the most common accidental credential copies while
 * never turning normal prose into redaction noise. Deployments can add custom
 * regular expressions through `privacy.redactPatterns`.
 */

const DEFAULT_RULES = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  {
    name: 'known-token-prefix',
    pattern: /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replace: '[REDACTED_TOKEN]',
  },
  {
    name: 'assignment',
    pattern: /\b((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|cookie)\s*[:=]\s*)([^\s,;'"]{4,})/gi,
    replace: '$1[REDACTED]',
  },
]

function customRule(source) {
  try {
    if (typeof source !== 'string' || source.trim().length === 0) return null
    return { name: 'custom', pattern: new RegExp(source, 'g'), replace: '[REDACTED]' }
  } catch {
    return null
  }
}

/**
 * @param {string} text raw memory text
 * @param {string[]} [extraPatterns] deployment-provided regex sources
 * @returns {{ text: string, redacted: boolean }}
 */
export function redactSecrets(text, extraPatterns = []) {
  let value = String(text ?? '')
  let redacted = false
  const rules = [...DEFAULT_RULES, ...extraPatterns.map(customRule).filter(Boolean)]
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(value)) {
      rule.pattern.lastIndex = 0
      value = value.replace(rule.pattern, rule.replace)
      redacted = true
    }
  }
  return { text: value, redacted }
}
