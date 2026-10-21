import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { openMemoryStore } from '../lib/store/sqlite.js'
import { registerTools } from '../lib/tools.js'

function makeCtx() {
  const tools = []
  return {
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    logger: { warn() {}, debug() {} },
    toolsList: tools,
  }
}

function makeSession(cwd = 'D:\\Work\\A') {
  return { header: { id: 's1', cwd } }
}

test('tools write, search, read, pin and forget within scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-tools-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const ctx = makeCtx()
    const config = Config({})
    registerTools(ctx, store, config)
    const byName = (name) => ctx.toolsList.find((tool) => tool.name === name)
    assert.deepEqual(ctx.toolsList.map((tool) => tool.name), ['memory_write', 'memory_search', 'memory_read', 'memory_forget', 'memory_pin'])
    const exec = { agent: { session: makeSession() } }

    const writeText = await byName('memory_write').execute({ text: '发布窗口是每周三', kind: 'semantic', pin: true }, exec)
    assert.match(writeText, /Saved memory/)

    const searchText = await byName('memory_search').execute({ query: '发布窗口' }, exec)
    assert.match(searchText, /Matching memories/)
    assert.match(searchText, /发布窗口是每周三/)

    const id = store.search({ text: '发布窗口', scopes: [{ scope: 'workspace', key: 'D:\\Work\\A' }] })[0].id
    const readText = await byName('memory_read').execute({ id }, exec)
    assert.match(readText, /kind=semantic/)

    const pinText = await byName('memory_pin').execute({ text: '回答使用简体中文' }, exec)
    assert.match(pinText, /Pinned/)

    const forgetText = await byName('memory_forget').execute({ id }, exec)
    assert.match(forgetText, /Forgot memory/)
    assert.equal(store.get(id), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_write redacts credentials before saving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-redact-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const ctx = makeCtx()
    registerTools(ctx, store, Config({}))
    const tool = ctx.toolsList.find((item) => item.name === 'memory_write')
    const text = await tool.execute({ text: 'deploy token=abc12345 and api_key: sk-abcdefghijklmnop' }, { agent: { session: makeSession() } })
    assert.match(text, /redacted/)
    const saved = store.list({ scopes: [{ scope: 'workspace', key: 'D:\\Work\\A' }] })
    assert.equal(saved.length, 1)
    assert.ok(!saved[0].body.includes('abc12345'))
    assert.ok(!saved[0].body.includes('sk-abcdefghijklmnop'))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
