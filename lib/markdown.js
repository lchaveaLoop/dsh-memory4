const KIND_ORDER = ['working', 'episodic', 'semantic', 'procedural']

function groupByKind(records) {
  const groups = new Map(KIND_ORDER.map((kind) => [kind, []]))
  for (const record of records) {
    if (!groups.has(record.kind)) groups.set(record.kind, [])
    groups.get(record.kind).push(record)
  }
  return groups
}

/** Human-readable Markdown dump of the memory database. */
export function recordsToMarkdown(input) {
  const records = Array.isArray(input?.records) ? input.records : []
  const pins = Array.isArray(input?.pins) ? input.pins : []
  const skills = Array.isArray(input?.skills) ? input.skills : []
  const lines = [
    '# dsh-memory4 export',
    '',
    `- exportedAt: ${input?.exportedAt ?? new Date().toISOString()}`,
    `- records: ${records.length}`,
    `- pins: ${pins.length}`,
    '',
  ]
  const groups = groupByKind(records)
  for (const [kind, group] of groups) {
    if (group.length === 0) continue
    lines.push(`## ${kind} (${group.length})`, '')
    for (const record of group) {
      lines.push(`- [${record.kind}:${record.id}] ${record.body}`)
      const meta = []
      if (record.scope) meta.push(`scope: ${record.scope}`)
      if (Array.isArray(record.tags) && record.tags.length > 0) meta.push(`tags: ${record.tags.join(', ')}`)
      if (Number.isFinite(record.importance)) meta.push(`importance: ${Number(record.importance).toFixed(2)}`)
      if (meta.length > 0) lines.push(`  - ${meta.join(' | ')}`)
    }
    lines.push('')
  }
  if (pins.length > 0) {
    lines.push(`## pins (${pins.length})`, '')
    for (const pin of pins) lines.push(`- ${pin.text}`)
    lines.push('')
  }
  if (skills.length > 0) {
    lines.push(`## skills (${skills.length})`, '')
    for (const skill of skills) lines.push(`- ${skill.name} [${skill.status}] evidence=${skill.evidence}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Parse the record bullets produced by {@link recordsToMarkdown} (and plain
 * `- [kind] text` / `- text` bullets) back into importable items.
 */
export function parseMemoryMarkdown(text) {
  const items = []
  const lines = String(text ?? '').split(/\r?\n/)
  let section = ''
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/)
    if (heading !== null) {
      section = heading[1].toLowerCase().split(/[\s(]/)[0]
      continue
    }
    if (section === 'pins' || section === 'skills') continue
    const tagged = line.match(/^\s*[-*]\s*\[([a-z]+)(?::[a-z0-9_-]+)?\]\s*(.+?)\s*$/i)
    if (tagged !== null) {
      const kind = tagged[1].toLowerCase()
      if (KIND_ORDER.includes(kind) && tagged[2].length > 0) items.push({ kind, text: tagged[2] })
      continue
    }
    const plain = line.match(/^\s*[-*]\s+(.+?)\s*$/)
    if (plain !== null) {
      const value = plain[1]
      if (value.startsWith('exportedAt:') || value.startsWith('records:') || value.startsWith('pins:')) continue
      if (value.startsWith('scope:') || value.startsWith('tags:') || value.startsWith('importance:')) continue
      if (value.length >= 6) items.push({ kind: 'semantic', text: value })
    }
  }
  return items
}
