import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const CLIENT = 'D:\\Projects\\dsh-memory4\\lib\\client.js'

test('client bundle follows the ModuleLoader factory contract', () => {
  const source = readFileSync(CLIENT, 'utf8')
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id:\s*"dsh-memory4"/)
  assert.match(source, /factory:\s*\(require\)\s*=>/)
  assert.match(source, /require\("react"\)/)
  assert.match(source, /exports\.apply\s*=\s*apply/)
  assert.match(source, /exports\.inject\s*=\s*inject/)
  assert.match(source, /settings\.section/)
  assert.match(source, /return module\.exports/)
  assert.match(source, /\/api\/memory4\/records/)
})
