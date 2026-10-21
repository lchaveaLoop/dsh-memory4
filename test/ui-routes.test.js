import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config } from '../lib/config.js'
import { buildRecord } from '../lib/core/record.js'
import { openMemoryStore } from '../lib/store/sqlite.js'
import { registerUiRoutes } from '../lib/ui-routes.js'

function makeHost(store, config) {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    effect(fn) {
      const value = fn()
      return typeof value === 'function' ? value : () => {}
    },
    logger: { warn() {} },
  }
  registerUiRoutes(ctx, store, config)
  return { route: routes[0], routes }
}

function makeRequest({ method = 'GET', url = '/api/memory4/status', body, remote = '127.0.0.1', host = '127.0.0.1:12345' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.socket = { remoteAddress: remote }
  req.headers = { host }
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    }, 0)
  } else {
    setTimeout(() => req.emit('end'), 0)
  }
  return req
}

function makeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    payload: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? {}
      return this
    },
    end(value) {
      this.payload = typeof value === 'string' ? value : ''
    },
  }
  return res
}

async function call(route, options) {
  const req = makeRequest(options)
  const res = makeResponse()
  await route.handler(req, res)
  let json
  try {
    json = res.payload.length > 0 ? JSON.parse(res.payload) : undefined
  } catch {
    json = undefined
  }
  return { status: res.statusCode, json }
}

test('settings UI routes reject non-loopback requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-ui-auth-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const { route } = makeHost(store, Config({}))
    const result = await call(route, { url: '/api/memory4/status', remote: '10.1.2.3', host: 'example.com' })
    assert.equal(result.status, 403)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings UI routes expose status, records, pin, forget, skills, log and export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-ui-routes-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const record = buildRecord({ kind: 'semantic', text: '发布窗口是每周三', scope: 'workspace', scopeKey: 'D:\\Work\\A' })
    store.put(record)
    const { route } = makeHost(store, Config({}))

    const status = await call(route, { url: '/api/memory4/status' })
    assert.equal(status.status, 200)
    assert.equal(status.json.store.total, 1)
    assert.equal(status.json.config.writeMode, 'rules')

    const records = await call(route, { url: '/api/memory4/records?query=' + encodeURIComponent('发布窗口') })
    assert.equal(records.status, 200)
    assert.equal(records.json.records.length, 1)
    assert.match(records.json.records[0].body, /发布窗口/)

    const pin = await call(route, {
      method: 'POST',
      url: '/api/memory4/pin',
      body: { text: '回答使用简体中文', scope: 'user' },
    })
    assert.equal(pin.status, 200)
    assert.equal(store.listPins([{ scope: 'user', key: 'global' }]).length, 1)

    const forget = await call(route, {
      method: 'POST',
      url: '/api/memory4/forget',
      body: { id: record.id },
    })
    assert.equal(forget.status, 200)
    assert.equal(store.get(record.id), null)

    const missing = await call(route, { method: 'POST', url: '/api/memory4/forget', body: { id: 'nope' } })
    assert.equal(missing.status, 404)

    const skills = await call(route, { url: '/api/memory4/skills' })
    assert.equal(skills.status, 200)
    assert.deepEqual(skills.json.skills, [])

    const badApprove = await call(route, {
      method: 'POST',
      url: '/api/memory4/skills/approve',
      body: { name: '../evil' },
    })
    assert.equal(badApprove.status, 400)

    const log = await call(route, { url: '/api/memory4/log?limit=10' })
    assert.equal(log.status, 200)
    assert.ok(Array.isArray(log.json.entries))

    const exported = await call(route, { url: '/api/memory4/export' })
    assert.equal(exported.status, 200)
    assert.ok(Array.isArray(exported.json.records))
    assert.equal(exported.json.schemaVersion, 3)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings UI routes validate bodies and unknown paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory4-ui-validation-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const { route } = makeHost(store, Config({}))
    const badPin = await call(route, { method: 'POST', url: '/api/memory4/pin', body: {} })
    assert.equal(badPin.status, 400)
    const unknown = await call(route, { url: '/api/memory4/unknown' })
    assert.equal(unknown.status, 404)
    const badMethod = await call(route, { method: 'DELETE', url: '/api/memory4/status' })
    assert.equal(badMethod.status, 404)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
