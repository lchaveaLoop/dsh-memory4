import z from '@deepseek-ai/schemastery'

/**
 * Deployment configuration for dsh-memory4.
 *
 * All values are optional; the defaults below are the product policy. The
 * profile patch layer may override any field by row id (`memory4`), and the
 * user layer always wins because it composes later.
 */
const Config = z.object({
  enabled: z.boolean().default(true),

  scope: z.object({
    default: z.union([
      z.const('session'),
      z.const('workspace'),
      z.const('user'),
    ]).default('workspace'),
  }).default({}),

  inject: z.object({
    maxTokens: z.number().step(1).min(0).max(8000).default(800),
    topK: z.number().step(1).min(0).max(50).default(5),
    trigger: z.union([
      z.const('always'),
      z.const('on-user-message'),
      z.const('on-novel-task'),
    ]).default('always'),
    includeWorking: z.boolean().default(true),
    includeEpisodic: z.boolean().default(true),
    includeSemantic: z.boolean().default(true),
    includeProcedural: z.boolean().default(false),
    recentLimit: z.number().step(1).min(0).max(50).default(3),
  }).default({}),

  write: z.object({
    mode: z.union([
      z.const('off'),
      z.const('rules'),
      z.const('llm'),
      z.const('hybrid'),
    ]).default('rules'),
    maxPerTurn: z.number().step(1).min(0).max(20).default(3),
    requireApprovalFor: z.array(z.string()).default(['skill']),
    autoPromote: z.boolean().default(false),
    distillProvider: z.string().default(''),
    distillModel: z.string().default(''),
    distillMaxTokens: z.number().step(1).min(64).max(4096).default(900),
    distillTimeoutMs: z.number().step(1).min(1000).max(120000).default(20000),
  }).default({}),

  reflect: z.object({
    enabled: z.boolean().default(false),
    auto: z.boolean().default(true),
    days: z.number().step(1).min(1).max(90).default(7),
    intervalHours: z.number().step(1).min(1).max(720).default(24),
    minEpisodes: z.number().step(1).min(1).max(100).default(3),
    maxItems: z.number().step(1).min(1).max(20).default(5),
    maxTokens: z.number().step(1).min(64).max(4096).default(1600),
  }).default({}),

  vector: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    apiKeyEnv: z.string().default('DSH_MEMORY4_EMBEDDING_KEY'),
    model: z.string().default('text-embedding-3-small'),
    dimensions: z.number().step(1).min(8).max(8192).default(1536),
    timeoutMs: z.number().step(1).min(1000).max(120000).default(15000),
    weight: z.number().min(0).max(1).default(0.35),
    topK: z.number().step(1).min(1).max(100).default(20),
  }).default({}),

  compact: z.object({
    handoffRatio: z.number().min(0).max(1).default(0.75),
    captureOnCompaction: z.boolean().default(true),
    handoffMaxTokens: z.number().step(1).min(0).max(2000).default(400),
  }).default({}),

  procedure: z.object({
    enabled: z.boolean().default(true),
    minEvidence: z.number().step(1).min(1).max(20).default(3),
    target: z.union([
      z.const('user'),
      z.const('project'),
    ]).default('user'),
  }).default({}),

  retention: z.object({
    episodicDays: z.number().step(1).min(1).max(3650).default(180),
    decayHalfLifeDays: z.number().min(1).default(30),
  }).default({}),

  privacy: z.object({
    redactPatterns: z.array(z.string()).default([]),
    excludeGlobs: z.array(z.string()).default([]),
  }).default({}),

  tools: z.object({
    enabled: z.boolean().default(true),
  }).default({}),

  store: z.object({
    path: z.string().default(''),
  }).default({}),
})

export { Config }
