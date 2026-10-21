import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { installConsolidation } from '../lib/consolidate.js'
import { buildRecord } from '../lib/core/record.js'
import { extractCandidates } from '../lib/extract.js'
import { buildMemoryBlock } from '../lib/inject.js'
import { approveSkill, crystallizeSkill, rejectSkill } from '../lib/procedure.js'
import { openMemoryStore } from '../lib/store/sqlite.js'

function makeHost() {
  const handlers = new Map()
  return {
    sessionProjections: { stateOf: () => undefined },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    logger: { warn() {}, debug() {} },
    handlers,
  }
}

function makeSession(messages = []) {
  return {
    header: { id: 's1', cwd: 'D:\\Work\\A' },
    deriveMessages: () => messages,
  }
}

test('rule extraction finds explicit memory, preferences, decisions, failures and episodes', () => {
  const messages = [
    { role: 'user', text: '请记住我们的发布窗口是每周三。另外我喜欢简洁的回答。' },
    { role: 'assistant', text: '部署失败了，因为 token 过期。' },
    { role: 'assistant', text: '已修复：改为先旋转密钥再重试部署。' },
    { role: 'user', text: '我们决定采用方案 B。' },
  ]
  const candidates = extractCandidates({
    messages,
    reason: { kind: 'complete' },
    toolCount: 2,
    maxPerTurn: 10,
  })
  const texts = candidates.map((candidate) => candidate.text).join('\n')
  assert.match(texts, /用户要求记住/)
  assert.match(texts, /用户偏好/)
  assert.match(texts, /已定决策/)
  assert.match(texts, /问题与处理/)
  const kinds = new Set(candidates.map((candidate) => candidate.kind))
  assert.ok(kinds.has('semantic'))
  assert.ok(kinds.has('episodic'))
})

test('extraction respects maxPerTurn and skips empty input', () => {
  const candidates = extractCandidates({ messages: [], reason: { kind: 'complete' }, maxPerTurn: 3 })
  assert.deepEqual(candidates, [])
  const many = extractCandidates({
    messages: [{ role: 'user', text: '请记住 A 规则。请记住 B 规则。请记住 C 规则。' }],
    reason: { kind: 'complete' },
    maxPerTurn: 1,
  })
  assert.equal(many.length, 1)
})

test('turn/end writes memories and compaction captures handoff and summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-consolidate-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const ctx = makeHost()
    const config = Config({ procedure: { minEvidence: 20 } })
    const tracker = { take: () => ({ tools: ['read', 'edit'], hadError: false, task: '发布窗口配置' }) }
    const handle = installConsolidation(ctx, store, config, tracker)
    const onEvent = ctx.handlers.get('session/event')[0]
    const session = makeSession([
      { role: 'user', text: '请记住发布窗口是每周三' },
      { role: 'assistant', text: '已记录发布窗口规则，后续会按每周三安排发布。' },
    ])

    onEvent(session, { type: 'turn/end', data: { reason: { kind: 'complete' } } })
    await handle.flush()
    const afterTurn = store.list({ scopes: [{ scope: 'workspace', key: 'D:\\Work\\A' }], limit: 20 })
    assert.ok(afterTurn.length >= 1)
    assert.ok(afterTurn.some((record) => record.kind === 'semantic' || record.kind === 'episodic'))

    onEvent(session, { type: 'compaction/start', data: { compactionId: 'c1' } })
    await handle.flush()
    const sessionScope = [{ scope: 'session', key: 's1' }]
    const handoffs = store.list({ scopes: sessionScope, kinds: ['working'], limit: 5 })
    assert.equal(handoffs.length, 1)
    assert.match(handoffs[0].body, /Handoff|Goal|Pinned/)

    onEvent(session, { type: 'compaction/summary', data: { compactionId: 'c1', summary: '旧上下文摘要：完成了发布窗口配置。' } })
    await handle.flush()
    const episodes = store.list({ scopes: [{ scope: 'workspace', key: 'D:\\Work\\A' }], kinds: ['episodic'], limit: 20 })
    assert.ok(episodes.some((record) => record.body.includes('压缩摘要')))

    const audit = store.listAudit(50)
    assert.ok(audit.some((row) => row.action === 'memory/auto-write'))
    assert.ok(audit.some((row) => row.action === 'memory/compaction-handoff'))
    assert.ok(audit.some((row) => row.action === 'memory/compaction-episode'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repeated successful tool sequences crystallize a draft skill, then approval copies it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-skill-'))
  const workspace = mkdtempSync(join(tmpdir(), 'memory4-ws-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const config = Config({ procedure: { enabled: true, minEvidence: 2, target: 'project' } })
    const session = makeSession()
    const turnState = { tools: ['read', 'edit'], hadError: false, task: '修改发布窗口配置并验证' }
    assert.equal(crystallizeSkill({ store, config, session, turnState }), null)
    const draft = crystallizeSkill({ store, config, session, turnState })
    assert.ok(draft !== null)
    assert.equal(existsSync(draft.draftPath), true)
    assert.match(readFileSync(draft.draftPath, 'utf8'), /^---\nname: /)
    const stored = store.getSkill(draft.name)
    assert.equal(stored.status, 'draft')
    assert.equal(stored.evidence, 2)

    const approved = approveSkill({ store, config, name: draft.name, workspace })
    assert.equal(approved.ok, true)
    assert.equal(existsSync(approved.targetPath), true)
    assert.ok(approved.targetPath.startsWith(join(workspace, '.agents', 'skills')))
    assert.equal(store.getSkill(draft.name).status, 'active')

    crystallizeSkill({ store, config, session, turnState: { tools: ['write', 'pwsh'], hadError: false, task: '生成文件' } })
    const other = crystallizeSkill({ store, config, session, turnState: { tools: ['write', 'pwsh'], hadError: false, task: '生成文件' } })
    assert.ok(other !== null)
    const rejected = rejectSkill({ store, name: other.name })
    assert.equal(rejected.ok, true)
    assert.equal(store.getSkill(other.name).status, 'rejected')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('latest working handoff is visible to the pre-step block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-handoff-inject-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({
      kind: 'working',
      text: '## Goal\n- 完成发布窗口配置',
      title: 'Handoff before compaction',
      scope: 'session',
      scopeKey: 's1',
      tags: ['handoff'],
      importance: 0.95,
      confidence: 0.95,
    }))
    const session = makeSession([
      { role: 'user', text: '继续完成发布窗口配置', source: { kind: 'user' } },
    ])
    const block = buildMemoryBlock({ store, config: Config({}), session })
    assert.ok(block !== null)
    assert.match(block.text, /latest handoff/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('autoPromote approves a crystallized skill immediately when configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'memory4-autopromote-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = mkdtempSync(join(tmpdir(), 'memory4-autopromote-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const config = Config({
      procedure: { enabled: true, minEvidence: 2, target: 'user' },
      write: { autoPromote: true },
    })
    const session = makeSession()
    const turnState = { tools: ['read', 'edit'], hadError: false, task: '更新配置并验证' }
    crystallizeSkill({ store, config, session, turnState })
    const draft = crystallizeSkill({ store, config, session, turnState })
    assert.ok(draft !== null)
    assert.equal(draft.autoApproved, true)
    assert.equal(store.getSkill(draft.name).status, 'active')
    assert.equal(existsSync(join(home, 'skills', draft.name, 'SKILL.md')), true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
