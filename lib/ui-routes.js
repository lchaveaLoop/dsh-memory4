import { redactSecrets } from './core/redact.js'
import { approveSkill, rejectSkill } from './procedure.js'
import { reflectNow } from './distill.js'
import { recordsToMarkdown } from './markdown.js'
import { queryVector } from './vector.js'

const PREFIX = '/api/memory4'
const MAX_BODY_BYTES = 64 * 1024
const MAX_TEXT_CHARS = 500
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/

/** True for an IPv4/IPv6 loopback socket address. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  if (value === '::1') return true
  return /^127\./.test(value)
}

/** Trust fence for the local Settings page: loopback socket and loopback Host. */
function isTrustedRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  return hostname === 'localhost' || isLoopbackAddress(hostname)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function limitOf(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(200, Math.floor(parsed)))
}

function configSummary(config) {
  return {
    scopeDefault: config.scope.default,
    injectMaxTokens: config.inject.maxTokens,
    injectTopK: config.inject.topK,
    writeMode: config.write.mode,
    autoPromote: config.write.autoPromote,
    procedureTarget: config.procedure.target,
    episodicDays: config.retention.episodicDays,
    vectorEnabled: config.vector.enabled,
    vectorModel: config.vector.model,
    reflectEnabled: config.reflect.enabled,
    reflectAuto: config.reflect.auto,
  }
}

function makeHandler(ctx, store, config) {
  return async (req, res) => {
    try {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { error: 'forbidden: loopback only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === `${PREFIX}/status`) {
        const skills = store.listSkills(100)
        sendJson(res, 200, {
          store: store.stats(),
          skills: {
            total: skills.length,
            drafts: skills.filter((skill) => skill.status === 'draft').length,
            active: skills.filter((skill) => skill.status === 'active').length,
          },
          audit: store.listAudit(5),
          config: configSummary(config),
          dataDir: store.filePath,
        })
        return
      }

      if (method === 'GET' && path === `${PREFIX}/records`) {
        const query = url.searchParams.get('query') ?? ''
        const kind = url.searchParams.get('kind') ?? ''
        const limit = limitOf(url.searchParams.get('limit'), 50)
        const vector = config.vector.enabled && query.length > 0 ? await queryVector(config, query) : null
        const records = vector !== null
          ? store.hybridAdminList({
              text: query,
              kinds: kind.length > 0 ? [kind] : undefined,
              limit,
              halfLifeDays: config.retention.decayHalfLifeDays,
              queryVector: vector,
              weight: config.vector.weight,
            })
          : store.adminList({
              text: query,
              kinds: kind.length > 0 ? [kind] : undefined,
              limit,
              halfLifeDays: config.retention.decayHalfLifeDays,
            })
        sendJson(res, 200, { records })
        return
      }

      if (method === 'GET' && path === `${PREFIX}/skills`) {
        sendJson(res, 200, { skills: store.listSkills(100) })
        return
      }

      if (method === 'GET' && path === `${PREFIX}/log`) {
        sendJson(res, 200, { entries: store.listAudit(limitOf(url.searchParams.get('limit'), 20)) })
        return
      }

      if (method === 'GET' && path === `${PREFIX}/export`) {
        const payload = { ...store.exportAll(), config: configSummary(config) }
        if (url.searchParams.get('format') === 'md') {
          sendText(res, 200, 'text/markdown; charset=utf-8', recordsToMarkdown(payload))
          return
        }
        sendJson(res, 200, payload)
        return
      }

      if (method === 'POST') {
        const body = await readJsonBody(req)

        if (path === `${PREFIX}/forget`) {
          const id = typeof body.id === 'string' ? body.id : ''
          if (id.length === 0) {
            sendJson(res, 400, { error: 'expected { id }' })
            return
          }
          if (!store.forget(id)) {
            sendJson(res, 404, { error: `memory not found: ${id}` })
            return
          }
          store.addAudit('memory/ui-forget', id, 'ui', null)
          sendJson(res, 200, { ok: true, id })
          return
        }

        if (path === `${PREFIX}/pin`) {
          const raw = typeof body.text === 'string' ? body.text.trim() : ''
          if (raw.length === 0) {
            sendJson(res, 400, { error: 'expected { text }' })
            return
          }
          const scope = body.scope === 'workspace' ? 'workspace' : 'user'
          const scopeKey = scope === 'workspace' ? String(body.cwd ?? '') : 'global'
          if (scope === 'workspace' && scopeKey.length === 0) {
            sendJson(res, 400, { error: 'workspace pin requires { cwd }' })
            return
          }
          const redacted = redactSecrets(raw.slice(0, MAX_TEXT_CHARS), config.privacy.redactPatterns)
          const pin = store.addPin({ text: redacted.text, scope, scopeKey })
          store.addAudit('memory/ui-pin', pin.id, 'ui', pin.text.slice(0, 120))
          sendJson(res, 200, { ok: true, pin })
          return
        }

        if (path === `${PREFIX}/skills/approve` || path === `${PREFIX}/skills/reject`) {
          const name = typeof body.name === 'string' ? body.name : ''
          if (!SKILL_NAME.test(name)) {
            sendJson(res, 400, { error: 'expected { name } (kebab-case)' })
            return
          }
          if (path.endsWith('/approve')) {
            const result = approveSkill({
              store,
              config,
              name,
              workspace: typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : undefined,
            })
            if (!result.ok) {
              sendJson(res, 400, { error: result.reason })
              return
            }
            sendJson(res, 200, result)
            return
          }
          const result = rejectSkill({ store, name })
          if (!result.ok) {
            sendJson(res, 400, { error: result.reason })
            return
          }
          sendJson(res, 200, result)
          return
        }
        if (path === `${PREFIX}/reflect`) {
          const days = Number(body.days) > 0 ? Number(body.days) : config.reflect.days
          const result = await reflectNow({ ctx, store, config, days, force: true })
          if (!result.ok) {
            sendJson(res, 400, { error: result.reason })
            return
          }
          store.addAudit('memory/ui-reflect', null, 'ui', `days=${days} created=${result.created} skipped=${result.skipped}`)
          sendJson(res, 200, result)
          return
        }
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      ctx.logger?.warn?.('memory4: ui route failed: %o', error)
      try {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      } catch {
        /* response already closed */
      }
    }
  }
}

/**
 * Register the local Settings-page HTTP API. The route is optional: profiles
 * without a Web host (headless/SDK) simply skip it.
 */
export function registerUiRoutes(ctx, store, config) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer', false) : false
  if (webServer === false || webServer === undefined || webServer === null) return
  const handler = makeHandler(ctx, store, config)
  ctx.effect(() => {
    const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler })
    return () => dispose()
  }, 'memory4: settings ui routes')
}
