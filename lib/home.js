import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the Harness home the same way the host does: env first, then ~/.dsh. */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/** Directory owned by this plugin. */
export function memory4Dir() {
  return join(resolveDshHome(), 'memory4')
}

/** Default SQLite file. */
export function defaultDbPath() {
  return join(memory4Dir(), 'memory.db')
}

/** Directory holding generated SKILL.md drafts before approval. */
export function skillDraftRoot() {
  return join(memory4Dir(), 'skills-drafts')
}

/** User-level skill root scanned by `dsh-skill-filesystem` (rank 400). */
export function userSkillRoot() {
  return join(resolveDshHome(), 'skills')
}
