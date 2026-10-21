import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config, apply, inject, name } from '../lib/index.js'

function makeHost() {
  const tools = []
  const commands = []
  const handlers = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    commands: { register: (command) => { commands.push(command); return () => {} } },
    sessionProjections: { stateOf: () => undefined },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(fn) {
      const value = fn()
      if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
        let step = value.next()
        while (!step.done) step = value.next()
        return step.value
      }
      if (typeof value === 'function') disposers.push(value)
      return value
    },
    logger: { warn() {}, debug() {} },
    toolsList: tools,
    commandsList: commands,
    handlers,
    disposers,
  }
  return ctx
}

test('plugin applies as a host-only bundle and exposes the expected surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-plugin-'))
  const dbPath = join(dir, 'memory.db')
  const ctx = makeHost()
  try {
    assert.equal(name, 'memory4')
    assert.deepEqual(inject, ['tools', 'commands', 'sessionProjections'])
    apply(ctx, Config({ store: { path: dbPath } }))
    assert.equal(existsSync(dbPath), true)
    assert.equal(ctx.toolsList.length, 5)
    assert.equal(ctx.commandsList.length, 2)
    assert.equal(ctx.handlers.get('agent/pre-step').length, 1)
    assert.equal(ctx.handlers.get('session/event').length, 3)

    for (const dispose of ctx.disposers) dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disabled configuration mounts nothing', () => {
  const ctx = makeHost()
  apply(ctx, Config({ enabled: false }))
  assert.equal(ctx.toolsList.length, 0)
  assert.equal(ctx.commandsList.length, 0)
  assert.equal(ctx.handlers.size, 0)
})
