import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { registerCommands } from '../lib/commands.js'
import { buildRecord } from '../lib/core/record.js'
import { openMemoryStore } from '../lib/store/sqlite.js'

function makeCtx() {
  const commands = []
  const ctx = {
    commands: { register: (command) => { commands.push(command); return () => {} } },
    effect(fn) {
      const value = fn()
      if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
        let step = value.next()
        while (!step.done) step = value.next()
        return step.value
      }
      return value
    },
    logger: { warn() {}, debug() {} },
    commandsList: commands,
  }
  return ctx
}

function session() {
  return { header: { id: 's1', cwd: 'D:\\Work\\A' } }
}

test('/remember writes a semantic memory and /memory reports it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-cmd-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const ctx = makeCtx()
    registerCommands(ctx, store, Config({}))
    assert.deepEqual(ctx.commandsList.map((command) => command.name), ['memory', 'remember'])
    const remember = ctx.commandsList.find((command) => command.name === 'remember')
    const memory = ctx.commandsList.find((command) => command.name === 'memory')
    const agent = { session: session() }

    const saved = await remember.handler({ rawInput: '发布窗口是每周三', agent })
    assert.equal(saved.kind, 'success')
    assert.match(saved.text, /Saved memory/)

    const status = await memory.handler({ rawInput: 'status', agent })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /records: 1/)

    const search = await memory.handler({ rawInput: 'search 发布窗口', agent })
    assert.match(search.text, /发布窗口是每周三/)

    const pins = await memory.handler({ rawInput: 'pin 回答使用简体中文', agent })
    assert.equal(pins.kind, 'success')
    const list = await memory.handler({ rawInput: 'pins', agent })
    assert.match(list.text, /回答使用简体中文/)

    const forget = await memory.handler({ rawInput: 'forget missing-id', agent })
    assert.equal(forget.kind, 'error')

    store.put(buildRecord({
      kind: 'episodic',
      text: 'old episode',
      scope: 'workspace',
      scopeKey: 'D:\\Work\\A',
      createdAt: Date.now() - 400 * 86_400_000,
      updatedAt: Date.now() - 400 * 86_400_000,
    }))
    const prune = await memory.handler({ rawInput: 'prune 180', agent })
    assert.match(prune.text, /Archived 1 episodic record/)

    const exportResult = await memory.handler({ rawInput: 'export', agent })
    assert.equal(exportResult.kind, 'success')
    assert.match(exportResult.text, /Exported memory to /)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
