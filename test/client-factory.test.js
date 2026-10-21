import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT = 'D:\\Projects\\dsh-memory4\\lib\\client.js'

test('client bundle factory exports apply/inject and registers a settings section', () => {
  const source = readFileSync(CLIENT, 'utf8')
  let loaded
  const sandbox = {
    window: { __ModuleLoader__: { load: (options) => { loaded = options } } },
    console,
  }
  vm.runInNewContext(source, sandbox)
  assert.ok(loaded, 'ModuleLoader.load should be called')
  assert.equal(loaded.id, 'dsh-memory4')
  assert.equal(typeof loaded.factory, 'function')

  const React = {
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    createElement: () => ({}),
  }
  const exported = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual([...exported.inject], ['slots', 'locale'])

  let registered
  const ctx = {
    effect(fn) { return fn() },
    locale: {
      register: () => () => {},
      bind: () => () => '记忆',
    },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        registered = { options, component }
        return () => {}
      },
    },
  }
  exported.apply(ctx)
  assert.ok(registered, 'settings section should be registered')
  assert.equal(registered.options.name, 'settings.section')
  assert.equal(registered.options.id, 'memory4')
  assert.equal(typeof registered.options.label(), 'string')
  assert.equal(typeof registered.component, 'function')
})
