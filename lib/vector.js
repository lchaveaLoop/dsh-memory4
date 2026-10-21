/**
 * Optional OpenAI-compatible embedding support.
 *
 * Vector retrieval is opt-in: without `vector.enabled`, a `baseUrl` and an API
 * key the plugin keeps using the zero-dependency FTS5/BM25 path.
 */

function apiKeyOf(config) {
  const configured = config?.vector?.apiKey ?? ''
  if (configured.trim().length > 0) return configured.trim()
  const envName = config?.vector?.apiKeyEnv ?? ''
  if (envName.length > 0) {
    const fromEnv = process.env[envName]
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  }
  return ''
}

/** Whether embedding calls are configured. */
export function vectorReady(config) {
  return config?.vector?.enabled === true
    && typeof config.vector.baseUrl === 'string' && config.vector.baseUrl.trim().length > 0
    && apiKeyOf(config).length > 0
}

function endpointOf(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

/** Embed one text; null when vector retrieval is not configured. Throws on transport errors. */
export async function embedText(config, text, signal) {
  if (!vectorReady(config)) return null
  const value = String(text ?? '').trim()
  if (value.length === 0) return null
  const controller = new AbortController()
  const timeoutMs = Number(config.vector.timeoutMs) > 0 ? Number(config.vector.timeoutMs) : 15000
  const timer = setTimeout(() => controller.abort(new Error('memory4: embedding timeout')), timeoutMs)
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const response = await fetch(endpointOf(config.vector.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKeyOf(config)}`,
      },
      body: JSON.stringify({
        model: config.vector.model,
        input: value.slice(0, 8000),
        dimensions: config.vector.dimensions,
      }),
      signal: combined,
    })
    if (!response.ok) throw new Error(`embedding HTTP ${response.status}`)
    const payload = await response.json()
    const vector = payload?.data?.[0]?.embedding
    if (!Array.isArray(vector) || vector.length === 0) throw new Error('embedding response has no vector')
    return vector.map((item) => Number(item))
  } finally {
    clearTimeout(timer)
  }
}

/** Best-effort embedding of the given records; returns the number stored. */
export async function embedRecords(options) {
  const { store, config, records, signal } = options
  if (!vectorReady(config) || !Array.isArray(records)) return 0
  let stored = 0
  for (const record of records) {
    if (record === null || typeof record.body !== 'string' || record.body.length === 0) continue
    try {
      const vector = await embedText(config, record.body, signal)
      if (vector !== null) {
        store.putVector(record.id, vector, config.vector.model)
        stored += 1
      }
    } catch (error) {
      options.ctx?.logger?.warn?.('memory4: embedding failed for %s: %o', record.id, error)
    }
  }
  return stored
}

/** Query embedding that degrades to null instead of failing recall. */
export async function queryVector(config, text, signal) {
  if (!vectorReady(config)) return null
  try {
    return await embedText(config, text, signal)
  } catch {
    return null
  }
}
