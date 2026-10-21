import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildRecord } from '../lib/core/record.js'
import { redactSecrets } from '../lib/core/redact.js'
import { rankCandidates } from '../lib/core/rank.js'
import { readScopes, writeScope, workspaceKeyOf } from '../lib/core/scope.js'
import { truncate } from '../lib/core/text.js'

test('record identity is stable and kind/scope aware', () => {
  const a = buildRecord({ kind: 'semantic', text: 'Release window is Wednesday', scope: 'workspace', scopeKey: 'D:\\A' })
  const b = buildRecord({ kind: 'semantic', text: '  Release   window is Wednesday ', scope: 'workspace', scopeKey: 'D:\\A' })
  const c = buildRecord({ kind: 'episodic', text: 'Release window is Wednesday', scope: 'workspace', scopeKey: 'D:\\A' })
  assert.equal(a.id, b.id)
  assert.notEqual(a.id, c.id)
  assert.equal(a.title, 'Release window is Wednesday')
  assert.deepEqual(a.tags, [])
})

test('tags are normalized and deduped', () => {
  const record = buildRecord({ text: 'x', tags: [' Release ', 'release', 'CI', 42, ''] })
  assert.deepEqual(record.tags, ['ci', 'release'])
})

test('secret redaction covers common credential shapes', () => {
  assert.equal(redactSecrets('api_key: sk-abcdefghijklmnop').redacted, true)
  assert.ok(redactSecrets('api_key: sk-abcdefghijklmnop').text.includes('[REDACTED'))
  assert.equal(redactSecrets('token=abc12345').redacted, true)
  assert.equal(redactSecrets('the release window is Wednesday').redacted, false)
  const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
  assert.ok(redactSecrets(block).text.includes('[REDACTED_PRIVATE_KEY]'))
})

test('ranking prefers lexical, important and recent records', () => {
  const now = Date.now()
  const rows = [
    { id: 'a', bm25: -5, importance: 0.9, updatedAt: now, useCount: 0 },
    { id: 'b', bm25: -0.1, importance: 0.1, updatedAt: now - 200 * 86_400_000, useCount: 0 },
    { id: 'c', bm25: null, importance: 0.5, updatedAt: now, useCount: 10 },
  ]
  const ranked = rankCandidates(rows, { now, halfLifeDays: 30 })
  assert.equal(ranked[0].id, 'a')
  assert.ok(ranked.every((row) => row.score >= 0 && row.score <= 1))
})

test('scope resolution uses session header cwd and explicit scopes', () => {
  const session = { header: { id: 'sess-1', cwd: 'D:\\Work\\Project' } }
  assert.equal(workspaceKeyOf(session), 'D:\\Work\\Project')
  assert.deepEqual(writeScope(session, 'user', 'workspace'), { scope: 'user', key: 'global' })
  assert.deepEqual(writeScope(session, 'session', 'workspace'), { scope: 'session', key: 'sess-1' })
  assert.deepEqual(writeScope(session, undefined, 'workspace'), { scope: 'workspace', key: 'D:\\Work\\Project' })
  const scopes = readScopes(session)
  assert.deepEqual(scopes.map((scope) => scope.scope), ['user', 'workspace', 'session'])
})

test('truncate respects code points', () => {
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate('abc', 4), 'abc')
})

test('store persists records, searches CJK and English, and forgets', async () => {
  const { openMemoryStore } = await import('../lib/store/sqlite.js')
  const dir = mkdtempSync(join(tmpdir(), 'memory4-store-'))
  const filePath = join(dir, 'memory.db')
  const store = openMemoryStore({ filePath })
  try {
    const session = { header: { id: 's1', cwd: 'D:\\Work\\A' } }
    const scopes = readScopes(session)
    const cjk = buildRecord({
      kind: 'semantic',
      text: '我们团队的发布窗口是每周三',
      scope: 'workspace',
      scopeKey: 'D:\\Work\\A',
      importance: 0.9,
    })
    const english = buildRecord({
      kind: 'episodic',
      text: 'The deployment failed because the token expired; we fixed it by rotating the key',
      scope: 'workspace',
      scopeKey: 'D:\\Work\\A',
    })
    store.put(cjk)
    store.put(english)
    store.put(buildRecord({ text: 'global preference: concise answers', scope: 'user', scopeKey: 'global' }))
    store.put(buildRecord({ text: 'other workspace fact', scope: 'workspace', scopeKey: 'D:\\Work\\B' }))

    assert.equal(store.get(cjk.id).body, '我们团队的发布窗口是每周三')
    assert.equal(store.get(cjk.id).importance, 0.9)

    const cjkHits = store.search({ text: '发布窗口', scopes, limit: 5 })
    assert.ok(cjkHits.some((row) => row.id === cjk.id), 'CJK substring search should hit')
    const enHits = store.search({ text: 'deployment failed token', scopes, limit: 5 })
    assert.ok(enHits.some((row) => row.id === english.id), 'English query should hit')
    assert.ok(!enHits.some((row) => row.scopeKey === 'D:\\Work\\B'), 'other workspace must not leak')

    const userHits = store.search({ text: 'concise answers', scopes, limit: 5 })
    assert.equal(userHits.length, 1)
    assert.equal(userHits[0].scope, 'user')

    store.touch([cjk.id])
    assert.equal(store.get(cjk.id).useCount, 1)

    assert.equal(store.forget(english.id), true)
    assert.equal(store.get(english.id), null)
    assert.equal(store.forget('missing'), false)

    const stats = store.stats()
    assert.equal(stats.total, 3)
    assert.equal(stats.tokenizer, 'trigram')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pins are scoped and removable', async () => {
  const { openMemoryStore } = await import('../lib/store/sqlite.js')
  const dir = mkdtempSync(join(tmpdir(), 'memory4-pins-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const pin = store.addPin({ text: 'Always answer in Chinese', scope: 'user', scopeKey: 'global' })
    const pins = store.listPins([{ scope: 'user', key: 'global' }])
    assert.equal(pins.length, 1)
    assert.equal(pins[0].text, 'Always answer in Chinese')
    assert.equal(store.removePin(pin.id), true)
    assert.equal(store.listPins([{ scope: 'user', key: 'global' }]).length, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('episodic retention archives stale records without deleting them', async () => {
  const { openMemoryStore } = await import('../lib/store/sqlite.js')
  const dir = mkdtempSync(join(tmpdir(), 'memory4-retention-'))
  const store = openMemoryStore({ filePath: join(dir, 'memory.db') })
  try {
    const now = Date.now()
    const old = buildRecord({
      kind: 'episodic',
      text: 'old episode from last year',
      scope: 'workspace',
      scopeKey: 'D:\\Work\\A',
      createdAt: now - 400 * 86_400_000,
      updatedAt: now - 400 * 86_400_000,
    })
    const fresh = buildRecord({ kind: 'episodic', text: 'fresh episode', scope: 'workspace', scopeKey: 'D:\\Work\\A' })
    store.put(old)
    store.put(fresh)

    const archived = store.archiveEpisodicBefore(now - 180 * 86_400_000)
    assert.equal(archived, 1)
    assert.equal(store.get(old.id).status, 'archived')
    assert.equal(store.get(fresh.id).status, 'active')
    const active = store.list({ scopes: [{ scope: 'workspace', key: 'D:\\Work\\A' }], limit: 10 })
    assert.equal(active.length, 1)
    assert.equal(store.stats().archived, 1)
    assert.equal(store.stats().total, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
