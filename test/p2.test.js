import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { distillCandidates, reflectNow } from '../lib/distill.js'
import { buildRecord } from '../lib/core/record.js'
import { buildMemoryBlock } from '../lib/inject.js'
import { parseJsonPayload } from '../lib/llm.js'
import { parseMemoryMarkdown, recordsToMarkdown } from '../lib/markdown.js'
import { openMemoryStore } from '../lib/store/sqlite.js'
import { embedText, embedRecords } from '../lib/vector.js'

function makeSession(messages = [{ role: 'user', text: '请记住发布窗口是每周三' }]) {
  return {
    header: { id: 's1', cwd: 'D:\\Work\\A' },
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
    deriveMessages: () => messages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: message.text }],
      source: { kind: message.role === 'user' ? 'user' : 'model' },
    })),
  }
}

function llmHost(payloadText) {
  const host = {
    logger: { warn() {}, debug() {} },
  }
  host.llm = {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payloadText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payloadText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  host.get = (name) => (name === 'llm' ? host.llm : undefined)
  return host
}

function llmHostSequence(payloads) {
  const host = {
    logger: { warn() {}, debug() {} },
    calls: 0,
  }
  host.llm = {
    async *stream() {
      const index = Math.min(host.calls, payloads.length - 1)
      host.calls += 1
      const payloadText = payloads[index]
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payloadText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payloadText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  host.get = (name) => (name === 'llm' ? host.llm : undefined)
  return host
}

function llmHostScript(script) {
  const host = {
    logger: { warn() {}, debug() {} },
    calls: 0,
  }
  host.llm = {
    async *stream() {
      const index = Math.min(host.calls, script.length - 1)
      host.calls += 1
      const item = script[index]
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: item.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: item.text } }
      yield { type: 'finish', reason: { kind: item.finish ?? 'stop' } }
    },
  }
  host.get = (name) => (name === 'llm' ? host.llm : undefined)
  return host
}

test('parseJsonPayload tolerates prose, fences, arrays and envelopes', () => {
  assert.deepEqual(parseJsonPayload('{"lessons":[{"text":"a"}]}'), { lessons: [{ text: 'a' }] })
  assert.deepEqual(parseJsonPayload('说明\n```json\n{"lessons":[{"text":"b"}]}\n```\n结束'), { lessons: [{ text: 'b' }] })
  assert.deepEqual(parseJsonPayload('前言 [{"text":"c"}] 后文'), [{ text: 'c' }])
  assert.deepEqual(parseJsonPayload('{"foo":1} 然后 {"lessons":[{"text":"d"}]}'), { lessons: [{ text: 'd' }] })
  assert.equal(parseJsonPayload('没有 JSON'), null)
})

test('config exposes LLM distillation, reflection and vector defaults', () => {
  const config = Config({})
  assert.equal(config.write.distillMaxTokens, 900)
  assert.equal(config.reflect.enabled, false)
  assert.equal(config.reflect.days, 7)
  assert.equal(config.reflect.maxTokens, 1600)
  assert.equal(config.vector.enabled, false)
  assert.equal(config.vector.dimensions, 1536)
  assert.equal(config.vector.weight, 0.35)
})

test('LLM distillation parses candidates and degrades when no target exists', async () => {
  const payload = JSON.stringify([{ kind: 'semantic', text: '发布窗口是每周三', tags: ['release'], importance: 0.8, confidence: 0.9 }])
  const ctx = llmHost(payload)
  const config = Config({ write: { mode: 'llm' } })
  const candidates = await distillCandidates({ ctx, config, session: makeSession() })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].kind, 'semantic')
  assert.match(candidates[0].text, /发布窗口/)
  assert.ok(candidates[0].tags.includes('llm'))

  const noRoute = { header: { id: 's2', cwd: 'D:\\Work\\A' }, deriveMessages: () => [] }
  assert.equal(await distillCandidates({ ctx, config, session: noRoute }), null)
})

test('LLM seam is acquired through ctx.get, not a direct ctx.llm property', async () => {
  const payload = JSON.stringify([{ kind: 'semantic', text: '通过 get 访问 LLM 服务', tags: [] }])
  const host = llmHost(payload)
  const ctx = {
    get: (name) => (name === 'llm' ? host.llm : undefined),
    logger: { warn() {}, debug() {} },
  }
  assert.equal(Object.hasOwn(ctx, 'llm'), false)
  const candidates = await distillCandidates({ ctx, config: Config({ write: { mode: 'llm' } }), session: makeSession() })
  assert.equal(candidates.length, 1)
  assert.match(candidates[0].text, /LLM/)
})

test('UI-side reflection reuses the latest live session route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-ui-reflect-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({ kind: 'episodic', text: '一次任务失败后修复的记录', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    const host = llmHost(JSON.stringify({ lessons: [{ text: 'UI 反思可以复用活跃会话模型' }] }))
    const ctx = {
      get(name) {
        if (name === 'llm') return host.llm
        if (name === 'sessions') {
          return { list: () => [{ requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) }] }
        }
        return undefined
      },
      logger: { warn() {}, debug() {} },
    }
    const config = Config({ reflect: { enabled: true, minEpisodes: 1 } })
    const result = await reflectNow({ ctx, store, config, session: undefined, days: 7, force: true })
    assert.equal(result.ok, true)
    assert.equal(result.created, 1)
    assert.equal(result.provider, 'deepseek-official')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reflection accepts common envelopes and repairs non-JSON replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-reflect-shapes-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({ kind: 'episodic', text: '发布失败后修复 token 并重试成功', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    const config = Config({ reflect: { enabled: true, minEpisodes: 1 } })

    const itemsEnvelope = await reflectNow({
      ctx: llmHost(JSON.stringify({ items: [{ text: '信封格式 items 也可以' }] })),
      store,
      config,
      session: makeSession(),
      days: 7,
      force: true,
    })
    assert.equal(itemsEnvelope.ok, true)
    assert.equal(itemsEnvelope.created, 1)

    const arrayOfStrings = await reflectNow({
      ctx: llmHost(JSON.stringify(['字符串数组结论一', '字符串数组结论二'])),
      store,
      config,
      session: makeSession(),
      days: 7,
      force: true,
    })
    assert.equal(arrayOfStrings.ok, true)
    assert.ok(arrayOfStrings.created >= 1)

    const repairHost = llmHostSequence([
      '我先解释一下：最近的部署经验是发布前务必检查凭据有效期。',
      JSON.stringify({ lessons: [{ text: '发布前检查凭据有效期' }] }),
    ])
    const repaired = await reflectNow({
      ctx: repairHost,
      store,
      config,
      session: makeSession(),
      days: 7,
      force: true,
    })
    assert.equal(repaired.ok, true)
    assert.equal(repairHost.calls, 2)
    assert.ok(store.listAudit(20).some((entry) => entry.action === 'memory/reflection-repair'))

    const fallbackHost = llmHostSequence([
      '反思如下：\n1. 发布前先确认凭据有效期\n2. 变更窗口固定在每周三',
      '仍然是普通文字，没有 JSON。',
    ])
    const fallback = await reflectNow({
      ctx: fallbackHost,
      store,
      config,
      session: makeSession(),
      days: 7,
      force: true,
    })
    assert.equal(fallback.ok, true)
    assert.ok(fallback.created >= 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reflection salvages complete lessons from a truncated JSON reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-reflect-truncated-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({ kind: 'episodic', text: '截断输出测试', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    const truncated = '{"lessons":[{"text":"第一条结论足够长"},{"text":"第二条结论足够长"},{"text":"第三条被截'
    const ctx = llmHost(truncated)
    const result = await reflectNow({
      ctx,
      store,
      config: Config({ reflect: { enabled: true, minEpisodes: 1 } }),
      session: makeSession(),
      days: 7,
      force: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.created, 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reflection retries with a larger budget after a max-tokens cut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-reflect-length-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({ kind: 'episodic', text: '长度截断测试', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    const host = llmHostScript([
      { text: '{"lessons":[{"text":"第一次被截断的结论足够长"},{"text":"第二', finish: 'max-tokens' },
      { text: '{"lessons":[{"text":"重试后得到的完整结论"}]}', finish: 'stop' },
    ])
    const result = await reflectNow({
      ctx: host,
      store,
      config: Config({ reflect: { enabled: true, minEpisodes: 1 } }),
      session: makeSession(),
      days: 7,
      force: true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.created, 1)
    assert.equal(host.calls, 2)
    assert.ok(store.listAudit(20).some((entry) => entry.action === 'memory/reflection-length-retry'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reflection reports a readable error and audits the raw reply when everything fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-reflect-fail-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({ kind: 'episodic', text: '无法解析输出的测试', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    const ctx = llmHostSequence(['没有任何结构化内容', '仍然没有结构化内容'])
    const result = await reflectNow({
      ctx,
      store,
      config: Config({ reflect: { enabled: true, minEpisodes: 1 } }),
      session: makeSession(),
      days: 7,
      force: true,
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /model output was not a lessons array/)
    assert.ok(store.listAudit(20).some((entry) => entry.action === 'memory/reflection-parse-failed'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reflection distills lessons into semantic memories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-reflect-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    store.put(buildRecord({ kind: 'episodic', text: '部署失败因为 token 过期，后来换成新 token 解决', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    store.put(buildRecord({ kind: 'episodic', text: '发布窗口固定在每周三，用户不希望改动', scope: 'workspace', scopeKey: 'D:\\Work\\A' }))
    const ctx = llmHost(JSON.stringify({ lessons: [{ text: '发布前先检查凭据有效期', tags: ['release'] }] }))
    const config = Config({ reflect: { enabled: true, minEpisodes: 1 } })
    const session = makeSession()
    const result = await reflectNow({ ctx, store, config, session, days: 7, force: true })
    assert.equal(result.ok, true)
    assert.equal(result.created, 1)
    const lessons = store.adminList({ kinds: ['semantic'], limit: 10 })
    assert.ok(lessons.some((record) => record.body.includes('凭据有效期')))
    assert.ok(Number(store.getMeta('last_reflection_at')) > 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('embedding client and vector store degrade and rank hybrid results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-vector-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { data: [{ embedding: [0, 1, 0, 0, 0, 0, 0, 0] }] } },
    })
    const config = Config({
      vector: { enabled: true, baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'test-key', dimensions: 8, model: 'test-embed' },
    })
    const alpha = buildRecord({ kind: 'semantic', text: 'alpha release note', scope: 'workspace', scopeKey: 'D:\\Work\\A' })
    const beta = buildRecord({ kind: 'semantic', text: 'beta deployment note', scope: 'workspace', scopeKey: 'D:\\Work\\A' })
    store.put(alpha)
    store.put(beta)
    store.putVector(alpha.id, [1, 0, 0, 0, 0, 0, 0, 0], 'test-embed')
    store.putVector(beta.id, [0, 1, 0, 0, 0, 0, 0, 0], 'test-embed')
    assert.equal(store.stats().vectors, 2)
    assert.deepEqual(store.getVector(alpha.id).vector, [1, 0, 0, 0, 0, 0, 0, 0])

    const embedding = await embedText(config, 'find beta')
    assert.deepEqual(embedding, [0, 1, 0, 0, 0, 0, 0, 0])
    assert.equal(await embedText(Config({}), 'no vector config'), null)

    const scopes = [{ scope: 'workspace', key: 'D:\\Work\\A' }]
    const hybrid = store.hybridSearch({ text: 'alpha', scopes, limit: 5, queryVector: [0, 1, 0, 0, 0, 0, 0, 0], weight: 1 })
    assert.equal(hybrid[0].id, beta.id)

    const block = buildMemoryBlock({
      store,
      config,
      session: makeSession([{ role: 'user', text: 'alpha note' }]),
      queryText: 'alpha note',
      queryVector: [0, 1, 0, 0, 0, 0, 0, 0],
      vectorWeight: 1,
    })
    assert.ok(block.text.includes('beta deployment note'))

    const written = await embedRecords({ ctx: { logger: { warn() {} } }, store, config, records: [alpha] })
    assert.equal(written, 1)
  } finally {
    globalThis.fetch = originalFetch
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markdown export and import round-trip records', () => {
  const record = buildRecord({ kind: 'semantic', text: '发布窗口是每周三', tags: ['release'], scope: 'workspace', scopeKey: 'D:\\Work\\A' })
  const markdown = recordsToMarkdown({
    exportedAt: '2026-10-21T00:00:00.000Z',
    records: [record],
    pins: [{ text: '回答使用简体中文' }],
    skills: [],
  })
  const items = parseMemoryMarkdown(markdown)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'semantic')
  assert.match(items[0].text, /发布窗口/)
})
