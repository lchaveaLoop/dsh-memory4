import { Config } from './config.js'
import { registerCommands } from './commands.js'
import { installConsolidation } from './consolidate.js'
import { defaultDbPath } from './home.js'
import { installInjection } from './inject.js'
import { createTurnTracker } from './procedure.js'
import { openMemoryStore } from './store/sqlite.js'
import { registerTools } from './tools.js'
import { registerUiRoutes } from './ui-routes.js'

/** Cordis plugin name used by Loader diagnostics. */
const name = 'memory4'

/** Capability services required by the host plane. */
const inject = ['tools', 'commands', 'sessionProjections']

/**
 * Apply the four-in-one memory host plane: open the local store, register the
 * model-facing tools and human commands, install per-step recall, then wire the
 * automatic write policy (turn/end extraction + compaction handoff) and the
 * procedural-memory crystallizer.
 *
 * @param {object} ctx Cordis context
 * @param {object} rawConfig composed entry config (profile/user layers)
 */
function apply(ctx, rawConfig) {
  const config = Config(rawConfig ?? {})
  if (!config.enabled) return

  const filePath = config.store.path.length > 0 ? config.store.path : defaultDbPath()
  const store = openMemoryStore({ filePath, logger: ctx.logger })
  ctx.effect(() => () => store.close(), 'memory4 store')

  const cutoff = Date.now() - config.retention.episodicDays * 86_400_000
  const archived = store.archiveEpisodicBefore(cutoff)
  if (archived > 0) {
    store.addAudit('memory/retention-archive', null, 'memory4', `startup archived ${archived} episodic record(s) older than ${config.retention.episodicDays}d`)
    ctx.logger?.debug?.(`memory4: archived ${archived} stale episodic records`)
  }

  const tracker = createTurnTracker(ctx)

  if (config.tools.enabled) registerTools(ctx, store, config)
  registerCommands(ctx, store, config)
  installInjection(ctx, store, config)
  installConsolidation(ctx, store, config, tracker)
  registerUiRoutes(ctx, store, config)

  ctx.logger?.debug?.(`memory4: ready at ${filePath}`)
}

export { Config, apply, inject, name }
