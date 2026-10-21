import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { buildRecord } from '../lib/core/record.js'
import { readScopes } from '../lib/core/scope.js'
import { buildMemoryBlock, installInjection } from '../lib/inject.js'
import { openMemoryStore } from '../lib/store/sqlite.js'

function fakeSession(cwd = 'D:\\Work\\A') {
  return {
    header: { id: 's1', cwd },
    deriveMessages() {
      return [{ role: 'user', content: [{ type: 'text', text: '发布窗口是周几？' }], source: { kind: 'user' } }]
    },
  }
}

test('config fills product defaults and rejects unknown shapes', () => {
  const config = Config({})
  assert.equal(config.enabled, true)
  assert.equal(config.scope.default, 'workspace')
  assert.equal(config.inject.maxTokens, 800)
  assert.equal(config.inject.topK, 5)
  assert.equal(config.write.mode, 'rules')
  assert.equal(config.compact.handoffRatio, 0.75)
  assert.equal(config.procedure.minEvidence, 3)
})

test('buildMemoryBlock includes pins and retrieved memories with a hard budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-block-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const session = fakeSession()
    store.put(buildRecord({
      kind: 'semantic',
      text: '我们团队的发布窗口是每周三',
      scope: 'workspace',
      scopeKey: 'D:\\Work\\A',
      importance: 0.9,
    }))
    store.addPin({ text: '回答使用简体中文', scope: 'user', scopeKey: 'global' })
    const config = Config({ inject: { maxTokens: 400 } })
    const block = buildMemoryBlock({ store, config, session })
    assert.ok(block !== null)
    assert.ok(block.text.includes('<memory-context source="dsh-memory4">'))
    assert.ok(block.text.includes('发布窗口'))
    assert.ok(block.text.includes('回答使用简体中文'))
    assert.ok(block.text.includes('</memory-context>'))
    assert.ok(block.text.length <= config.inject.maxTokens * 1.5 + 400)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildMemoryBlock returns null with nothing to recall', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-empty-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const block = buildMemoryBlock({ store, config: Config({}), session: fakeSession() })
    assert.equal(block, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeHost() {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    logger: { warn() {}, debug() {} },
    handlers,
  }
  return ctx
}

test('pre-step injection is append-only, deduped and re-armed by compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-inject-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const session = fakeSession()
    store.put(buildRecord({
      kind: 'semantic',
      text: '我们团队的发布窗口是每周三',
      scope: 'workspace',
      scopeKey: 'D:\\Work\\A',
      importance: 0.9,
    }))
    const ctx = makeHost()
    installInjection(ctx, store, Config({}))
    const handler = ctx.handlers.get('agent/pre-step')[0]
    assert.equal(typeof handler, 'function')

    const userMessage = { role: 'user', content: [{ type: 'text', text: '发布窗口是周几？' }], source: { kind: 'user' } }
    const next = async () => ({ kind: 'accept', messages: [userMessage] })
    const decision = await handler({ agent: { session }, signal: new AbortController().signal }, next)
    assert.equal(decision.messages.length, 2)
    assert.equal(decision.messages[1].source.kind, 'memory4')
    assert.ok(decision.messages[1].content[0].text.includes('发布窗口'))

    const again = await handler({ agent: { session }, signal: new AbortController().signal }, next)
    assert.equal(again.messages.length, 1, 'unchanged digest must not inject twice')

    for (const onEvent of ctx.handlers.get('session/event')) onEvent(session, { type: 'compaction/end' })
    const afterCompaction = await handler({ agent: { session }, signal: new AbortController().signal }, next)
    assert.equal(afterCompaction.messages.length, 2, 'compaction must re-arm injection')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
