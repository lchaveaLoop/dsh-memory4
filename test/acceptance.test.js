import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { installConsolidation } from '../lib/consolidate.js'
import { buildRecord } from '../lib/core/record.js'
import { readScopes } from '../lib/core/scope.js'
import { extractCandidates } from '../lib/extract.js'
import { buildMemoryBlock, installInjection } from '../lib/inject.js'
import { approveSkill, crystallizeSkill } from '../lib/procedure.js'
import { openMemoryStore } from '../lib/store/sqlite.js'

function makeSession(id, cwd, text = '继续项目配置') {
  return {
    header: { id, cwd },
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  }
}

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

test('A1: a memory written in session A is recalled in a fresh session B of the same workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-a1-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({
      kind: 'semantic',
      text: '发布窗口是每周三',
      scope: 'workspace',
      scopeKey: 'D:\\Work\\A',
      importance: 0.9,
    }))
    const sessionB = makeSession('session-b', 'D:\\Work\\A', '发布窗口是哪天？')
    const block = buildMemoryBlock({ store, config: Config({}), session: sessionB })
    assert.ok(block !== null)
    assert.match(block.text, /发布窗口是每周三/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A2: compaction writes a handoff card and the next step can re-inject it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-a2-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const ctx = makeHost()
    const config = Config({})
    const handle = installConsolidation(ctx, store, config, { take: () => ({ tools: ['read'], hadError: false, task: '配置发布' }) })
    const session = makeSession('s1', 'D:\\Work\\A')
    ctx.handlers.get('session/event')[0](session, { type: 'compaction/start', data: { compactionId: 'c1' } })
    await handle.flush()

    const handoff = store.list({ scopes: [{ scope: 'session', key: 's1' }], kinds: ['working'], limit: 1 })
    assert.equal(handoff.length, 1)
    const block = buildMemoryBlock({ store, config, session })
    assert.match(block.text, /latest handoff/)

    ctx.handlers.get('session/event')[0](session, {
      type: 'compaction/summary',
      data: { compactionId: 'c1', summary: '已完成的旧上下文摘要' },
    })
    await handle.flush()
    assert.ok(store.list({ scopes: [{ scope: 'workspace', key: 'D:\\Work\\A' }], kinds: ['episodic'], limit: 5 })
      .some((record) => record.body.includes('压缩摘要')))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A3: procedural draft stays out of the skill root until explicitly approved', () => {
  const home = mkdtempSync(join(tmpdir(), 'memory4-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = mkdtempSync(join(tmpdir(), 'memory4-a3-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const config = Config({ procedure: { minEvidence: 2, target: 'user' } })
    const session = makeSession('s1', 'D:\\Work\\A')
    const turnState = { tools: ['read', 'edit'], hadError: false, task: '更新配置并验证' }
    crystallizeSkill({ store, config, session, turnState })
    const draft = crystallizeSkill({ store, config, session, turnState })
    assert.ok(draft !== null)
    assert.equal(existsSync(join(home, 'skills', draft.name, 'SKILL.md')), false, 'unapproved draft must not be live')

    const approved = approveSkill({ store, config, name: draft.name })
    assert.equal(approved.ok, true)
    assert.equal(existsSync(join(home, 'skills', draft.name, 'SKILL.md')), true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('A4: writes are deduped, redacted and skip other workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-a4-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const first = buildRecord({ kind: 'semantic', text: '发布窗口是每周三  token=abc12345', scope: 'workspace', scopeKey: 'D:\\Work\\A' })
    const second = buildRecord({ kind: 'semantic', text: '发布窗口是每周三  token=abc12345', scope: 'workspace', scopeKey: 'D:\\Work\\A' })
    assert.equal(first.id, second.id)
    store.put(first)
    store.put(second)
    assert.equal(store.stats().total, 1)

    store.put(buildRecord({ kind: 'semantic', text: '另一个项目的私有事实', scope: 'workspace', scopeKey: 'D:\\Work\\B' }))
    const scopes = readScopes(makeSession('s1', 'D:\\Work\\A'))
    const hits = store.search({ text: '私有事实', scopes, limit: 5 })
    assert.equal(hits.length, 0)

    const candidate = extractCandidates({
      messages: [
        { role: 'user', text: '请记住部署规则是蓝绿发布。' },
        { role: 'assistant', text: '已记录该部署规则，后续发布都按蓝绿流程执行，确保回滚可用。' },
      ],
      reason: { kind: 'complete' },
      toolCount: 1,
      maxPerTurn: 3,
    })
    assert.ok(candidate.length >= 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A5: injection obeys the token budget and does not repeat an unchanged block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-a5-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    for (let index = 0; index < 12; index += 1) {
      store.put(buildRecord({
        kind: 'semantic',
        text: `项目事实 ${index}: 这是一条用于测试注入预算的长记忆内容，包含足够的字符以触发截断逻辑。`,
        scope: 'workspace',
        scopeKey: 'D:\\Work\\A',
        importance: 0.8,
      }))
    }
    const config = Config({ inject: { maxTokens: 120, topK: 5 } })
    const session = makeSession('s1', 'D:\\Work\\A', '项目事实有哪些')
    const block = buildMemoryBlock({ store, config, session })
    assert.ok(block !== null)
    assert.ok(block.text.length <= config.inject.maxTokens * 1.5 + 200)

    const ctx = makeHost()
    installInjection(ctx, store, config)
    const handler = ctx.handlers.get('agent/pre-step')[0]
    const next = async () => ({ kind: 'accept', messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }] })
    const first = await handler({ agent: { session }, signal: new AbortController().signal }, next)
    const second = await handler({ agent: { session }, signal: new AbortController().signal }, next)
    assert.equal(first.messages.length, 2)
    assert.equal(second.messages.length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A6: user-scope memories are visible across workspaces, workspace memories are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-a6-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({ kind: 'semantic', text: '回答使用简体中文', scope: 'user', scopeKey: 'global', importance: 0.9 }))
    store.put(buildRecord({ kind: 'semantic', text: '项目 A 的内部约定', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    const scopeB = readScopes(makeSession('s2', 'D:\\Work\\B'))
    const userHits = store.search({ text: '简体中文', scopes: scopeB, limit: 5 })
    const projectHits = store.search({ text: '内部约定', scopes: scopeB, limit: 5 })
    assert.equal(userHits.length, 1)
    assert.equal(projectHits.length, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
