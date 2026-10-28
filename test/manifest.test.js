import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The manifest is what DSH's app-boot checks before it imports any plugin code:
 * when `package.json.engines.dsh` is absent it validates every
 * `@deepseek-ai/dsh*` peer range instead, and a mismatch refuses the whole
 * bundle layer ("Incompatible plugin ... blocked"). 0.3.3 declared the range in
 * a non-manifest place (`dsh.engines.dsh`) while pinning the rc.2 peers, so the
 * host 0.2.1-rc.3 upgrade refused to load the plugin. These tests pin the
 * manifest contract that fixed it.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Version tuple used by the assertion below; enough to compare SemVer pre-releases. */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value))
  if (match === null) throw new Error(`not a semantic version: ${value}`)
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease }
}

function comparePart(left, right) {
  const leftNumber = /^\d+$/.test(left)
  const rightNumber = /^\d+$/.test(right)
  if (leftNumber && rightNumber) return Number(left) - Number(right)
  if (leftNumber) return -1 // numeric identifiers sort before alphanumeric ones
  if (rightNumber) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function compareVersion(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1 // a release sorts after its pre-releases
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const order = comparePart(leftPart, rightPart)
    if (order !== 0) return order < 0 ? -1 : 1
  }
  return 0
}

/** Evaluate the `>=lower <upper` subset of SemVer ranges this manifest uses. */
function satisfiesRange(version, range) {
  const comparators = String(range).trim().split(/\s+/)
  assert.ok(comparators.length > 0, `empty range: ${range}`)
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator)
    assert.ok(match !== null, `unsupported comparator: ${comparator}`)
    const order = compareVersion(version, match[2])
    switch (match[1] ?? '=') {
      case '>=': return order >= 0
      case '<=': return order <= 0
      case '>': return order > 0
      case '<': return order < 0
      default: return order === 0
    }
  })
}

test('manifest declares engines.dsh where DSH app-boot reads it', () => {
  assert.equal(typeof manifest.engines?.node, 'string')
  assert.equal(typeof manifest.engines?.dsh, 'string', 'package.json engines.dsh must be a string range')
  // The legacy 0.3.x placement is not a manifest field; keeping it in sync is a trap.
  assert.equal(manifest.dsh?.engines, undefined, 'engines.dsh belongs to package.json.engines, not dsh.engines')
})

test('engines.dsh admits the current 0.2.1-rc.3 runtime and loops in rc.4+', () => {
  const range = manifest.engines.dsh
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2']) {
    assert.equal(satisfiesRange(version, range), true, `expected ${range} to admit ${version}`)
  }
  for (const version of ['0.2.1-rc.2', '0.1.0', '0.3.0']) {
    assert.equal(satisfiesRange(version, range), false, `expected ${range} to reject ${version}`)
  }
})

test('DSH peer dependencies follow the declared runtime line', () => {
  const peers = manifest.peerDependencies ?? {}
  assert.equal(peers['@deepseek-ai/cordis'], '~4.0.5')
  const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  assert.deepEqual(dshPeers.map(([name]) => name).sort(), [
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-tools',
  ])
  for (const [name, range] of dshPeers) {
    // engines.dsh decides alone, but a stale peer pin misleads the installer and
    // breaks the fallback path when engines.dsh is ever dropped.
    assert.equal(range, '0.2.1-rc.3', `${name} must track the current DSH runtime`)
  }
})

test('bundle and client entry points stay wired to existing files', () => {
  assert.equal(manifest.dsh?.manifestVersion, 1)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(existsSync(join(root, 'cordis.patch.yml')), true)
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(existsSync(join(root, manifest.main)), true)
  assert.equal(manifest.exports?.['./client'], './lib/client.js')
  assert.equal(existsSync(join(root, 'lib/client.js')), true)
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.deepEqual(manifest.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-locale',
  ])
})
