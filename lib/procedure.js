import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildRecord } from './core/record.js'
import { normalizeText, truncate } from './core/text.js'
import { userSkillRoot, skillDraftRoot } from './home.js'

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 6)
}

/** Turn a tool name/task hint into a filesystem-safe skill directory name. */
export function slugifySkillName(value, suffix = '') {
  const base = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const name = `${base.length > 0 ? base : 'workflow'}${suffix.length > 0 ? `-${suffix}` : ''}`
  return NAME_RE.test(name) ? name : `workflow-${shortHash(name)}`
}

/**
 * Observe the session log and remember each turn's tool sequence. The
 * evidence is taken synchronously at `turn/end` so async consolidation never
 * races a later turn.
 */
export function createTurnTracker(ctx) {
  const perSession = new Map()

  ctx.on('session/event', (session, event) => {
    const key = session?.header?.id ?? 'unknown'
    if (event?.type === 'turn/start') {
      perSession.set(key, { tools: [], hadError: false, task: '' })
      return
    }
    if (event?.type === 'user/message') {
      const state = perSession.get(key)
      if (state === undefined) return
      const content = event.data?.content
      const text = Array.isArray(content)
        ? content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ')
        : ''
      if (state.task.length === 0 && text.length > 0) state.task = normalizeText(text).slice(0, 300)
      return
    }
    if (event?.type === 'tool/call') {
      const state = perSession.get(key)
      if (state === undefined) return
      const name = event.data?.name
      if (typeof name === 'string' && !state.tools.includes(name)) state.tools.push(name)
      return
    }
    if (event?.type === 'tool/result') {
      const state = perSession.get(key)
      if (state === undefined) return
      if (event.data?.error !== undefined) state.hadError = true
    }
  })

  return {
    take(session) {
      const key = session?.header?.id ?? 'unknown'
      const state = perSession.get(key) ?? null
      perSession.delete(key)
      return state
    },
  }
}

export function renderSkillDraft(skill) {
  const lines = [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    `whenToUse: ${JSON.stringify(skill.whenToUse)}`,
    '---',
    '',
    `# ${skill.description}`,
    '',
    '## When to use',
    skill.whenToUse,
    '',
    '## Steps',
    ...skill.tools.map((tool, index) => `${index + 1}. Run \`${tool}\` and verify its result before continuing.`),
    '',
    '## Verification',
    '- Confirm every step completed without tool errors.',
    '- Re-run the verification commands named by the task before reporting success.',
    '',
    '## Evidence',
    `- Observed ${skill.evidence} successful turns with the same tool sequence.`,
    `- Latest task sample: ${truncate(skill.sample, 300)}`,
    '',
  ]
  return lines.join('\n')
}

/**
 * Crystallize a repeated successful tool sequence into a draft SKILL.md.
 * Drafts never enter the live skill catalog until `/memory skills approve`.
 */
export function crystallizeSkill(options) {
  const { store, config, session, turnState } = options
  if (!config.procedure.enabled) return null
  if (turnState === null || turnState.tools.length < 2 || turnState.hadError) return null

  const signature = turnState.tools.join('>')
  const evidence = store.bumpSkillEvidence(signature, turnState.task)
  if (evidence.count < config.procedure.minEvidence) return null

  const name = slugifySkillName(turnState.tools[0], shortHash(signature))
  const existing = store.getSkill(name)
  if (existing !== null && existing.status !== 'rejected') return null

  const draftPath = join(skillDraftRoot(), name, 'SKILL.md')
  mkdirSync(dirname(draftPath), { recursive: true })
  const content = renderSkillDraft({
    name,
    description: `Reusable workflow: ${turnState.tools.join(' → ')}`,
    whenToUse: turnState.task.length > 0 ? turnState.task : 'Use when a task follows the same tool sequence.',
    tools: turnState.tools,
    evidence: evidence.count,
    sample: turnState.task,
  })
  writeFileSync(draftPath, content, 'utf8')
  store.upsertSkill({
    name,
    description: `Reusable workflow: ${turnState.tools.join(' → ')}`,
    draftPath,
    evidence: evidence.count,
  })
  store.addAudit('skill/drafted', null, 'memory4', `${name} (evidence=${evidence.count})`)

  let autoApproved = false
  if (config.write?.autoPromote === true) {
    const approved = approveSkill({
      store,
      config,
      name,
      workspace: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
    })
    autoApproved = approved.ok === true
    if (autoApproved) store.addAudit('skill/auto-approved', null, 'memory4', `${name} -> ${approved.targetPath}`)
  }

  // A procedural memory record makes the draft discoverable through search.
  const record = buildRecord({
    kind: 'procedural',
    text: `待审批技能 ${name}: ${turnState.task.slice(0, 300)}`,
    title: `Skill draft: ${name}`,
    tags: ['skill', autoApproved ? 'active' : 'draft', name],
    scope: 'workspace',
    scopeKey: session?.header?.cwd ?? 'unknown',
    importance: 0.7,
    confidence: 0.6,
    source: { sessionId: session?.header?.id },
    status: autoApproved ? 'active' : 'draft',
  })
  store.put(record)
  return { name, draftPath, evidence: evidence.count, autoApproved }
}

/** Approve a draft and copy it into a skill root scanned by dsh-skill-filesystem. */
export function approveSkill(options) {
  const { store, config, name, workspace } = options
  const skill = store.getSkill(name)
  if (skill === null) return { ok: false, reason: `skill not found: ${name}` }
  if (skill.status !== 'draft') return { ok: false, reason: `skill is not a draft: ${name} (${skill.status})` }
  const targetRoot = config.procedure.target === 'project' && typeof workspace === 'string' && workspace.length > 0
    ? join(workspace, '.agents', 'skills')
    : userSkillRoot()
  const targetPath = join(targetRoot, name, 'SKILL.md')
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(skill.draftPath, targetPath)
  store.setSkillStatus(name, 'active', targetPath)
  store.addAudit('skill/approved', null, 'user', `${name} -> ${targetPath}`)
  return { ok: true, name, targetPath }
}

/** Reject a draft; the file stays on disk for inspection but is not copied. */
export function rejectSkill(options) {
  const { store, name } = options
  const skill = store.getSkill(name)
  if (skill === null) return { ok: false, reason: `skill not found: ${name}` }
  store.setSkillStatus(name, 'rejected', null)
  store.addAudit('skill/rejected', null, 'user', name)
  return { ok: true, name }
}
