import { isAbsolute, resolve } from 'node:path'

/** Read the immutable session header, tolerating a missing session. */
export function headerOf(session) {
  return session?.header ?? {}
}

/** Stable session identity, or `"unknown"` for callers without a session. */
export function sessionKeyOf(session) {
  const id = headerOf(session).id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown'
}

/** Stable workspace identity derived from the session's creation cwd. */
export function workspaceKeyOf(session) {
  const cwd = headerOf(session).cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return 'unknown'
  try {
    return isAbsolute(cwd) ? resolve(cwd) : resolve(cwd)
  } catch {
    return cwd
  }
}

/**
 * All scopes visible to one session. Retrieval always includes the global
 * user scope and the session's own workspace; the session scope is visible
 * only to the owning session.
 */
export function readScopes(session) {
  const scopes = [{ scope: 'user', key: 'global' }]
  const workspace = workspaceKeyOf(session)
  if (workspace !== 'unknown') scopes.push({ scope: 'workspace', key: workspace })
  const sessionKey = sessionKeyOf(session)
  if (sessionKey !== 'unknown') scopes.push({ scope: 'session', key: sessionKey })
  return scopes
}

/** Resolve one write target, honoring an explicit scope when supplied. */
export function writeScope(session, explicit, defaultScope = 'workspace') {
  const scope = explicit ?? defaultScope
  if (scope === 'session') return { scope, key: sessionKeyOf(session) }
  if (scope === 'user') return { scope, key: 'global' }
  return { scope: 'workspace', key: workspaceKeyOf(session) }
}

/** Shape used by SQL predicates: `{ scope, key }` -> `{ scope, scopeKey }`. */
export function scopeColumns(scope) {
  return { scope: scope.scope, scopeKey: scope.key }
}
