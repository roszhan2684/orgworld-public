import { z } from 'zod';
import { OrganizationGenome } from './genome.ts';

export const PROVIDERS = ['claude-cli', 'anthropic-api', 'ollama', 'scripted'] as const;
/** Providers that cost money. They are refused unless paid cognition is explicitly allowed (see cognition/spend-guard). */
export const PAID_PROVIDERS: readonly string[] = ['claude-cli', 'anthropic-api'];
export const ProviderId = z.enum(PROVIDERS);
export type ProviderId = z.infer<typeof ProviderId>;

/** USD per million tokens, copied from the provider's published price list (never guessed). */
export const PricingCard = z
  .object({
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative(),
    cacheWritePerMTok: z.number().nonnegative(),
  })
  .strict();
export const ModelPricing = PricingCard.extend({
  /** Second rate card for prompts above a size threshold (e.g. Claude Haiku 5.5 above 100,000 prompt tokens). */
  longContext: PricingCard.extend({ aboveInputTokens: z.number().int().positive() }).strict().optional(),
}).strict();
export type ModelPricing = z.infer<typeof ModelPricing>;

export const ModelConfig = z
  .object({
    provider: ProviderId,
    model: z.string().min(1),
    /** Only honoured by providers with samplingControlled=true (conflict C-07). */
    temperature: z.number().min(0).max(1).optional(),
    /** Only honoured by providers that support it (ollama). */
    seed: z.number().int().optional(),
    maxOutputTokensPerCall: z.number().int().positive().default(2048),
    /** Paid API providers: price per model id. Required by anthropic-api so budgets are enforced in USD. */
    pricing: z.record(z.string(), ModelPricing).optional(),
  })
  .strict();
export type ModelConfig = z.infer<typeof ModelConfig>;

/** Compute controls C1–C3 (III §4) + build §35. */
export const BudgetConfig = z
  .object({
    perTask: z
      .object({
        maxTokens: z.number().int().positive().default(60_000),
        maxCalls: z.number().int().positive().default(20),
        maxUsd: z.number().positive().default(0.25),
        /** A call is refused when remaining tokens < reserve (C-11). */
        reserveTokens: z.number().int().nonnegative().default(2_500),
      })
      .strict()
      .default({ maxTokens: 60_000, maxCalls: 20, maxUsd: 0.25, reserveTokens: 2_500 }),
    perRun: z
      .object({
        maxTokens: z.number().int().positive().optional(),
        maxCalls: z.number().int().positive().optional(),
        maxUsd: z.number().positive().optional(),
        maxWallClockMs: z.number().int().positive().optional(),
        maxToolCalls: z.number().int().positive().optional(),
      })
      .strict()
      .default({}),
    maxAgents: z.number().int().positive().default(16),
    maxConcurrentAgents: z.number().int().positive().default(1),
  })
  .strict();
export type BudgetConfig = z.infer<typeof BudgetConfig>;

/**
 * Default = research objective R_t − λ·C_t − μ·s_t (II-§7, III); see conflict C-03.
 * Build §36 extra terms are available but zero unless configured.
 */
export const RewardConfig = z
  .object({
    taskQuality: z.number().default(1),
    /** λ: penalty per 1,000 total tokens consumed by the task (all categories attributed to it). */
    lambdaCostPer1kTokens: z.number().min(0).default(0),
    /** μ: penalty per structural change applied before this task. */
    muStructural: z.number().min(0).default(0),
    verification: z.number().default(0),
    coordinationPer10Messages: z.number().min(0).default(0),
    /** Score ≥ threshold counts as task success. */
    successThreshold: z.number().min(0).max(1).default(1),
  })
  .strict();
export type RewardConfig = z.infer<typeof RewardConfig>;

export const FeatureFlags = z
  .object({
    crossTaskMemory: z.boolean().default(false),
    relationships: z.boolean().default(false),
    meetings: z.boolean().default(true),
    decisions: z.boolean().default(true),
    beliefs: z.boolean().default(true),
  })
  .strict();
export type FeatureFlags = z.infer<typeof FeatureFlags>;

export const ABLATIONS = [
  'no-persistence', // A1
  'no-role-evolution', // A2
  'no-membership-evolution', // A3
  'no-topology-evolution', // A4
  'no-history', // A5
  'no-validation', // A6
  'no-rollback', // A7
  'frozen-after-phase-1',
  'no-policy',
] as const;
export const Ablation = z.enum(ABLATIONS);

export const EvolutionConfig = z
  .object({
    enabled: z.boolean().default(false),
    trigger: z
      .object({ kind: z.literal('periodic'), everyK: z.number().int().positive().default(20) })
      .strict()
      .default({ kind: 'periodic', everyK: 20 }),
    /** Build §91: no mutation before enough evidence. */
    minTasksBeforeFirst: z.number().int().nonnegative().default(20),
    historyWindow: z.number().int().positive().default(30),
    /** Replay buffer B (II-§11): recent tasks + historical validation tasks (I-§45). */
    bufferRecent: z.number().int().nonnegative().default(4),
    bufferHistorical: z.number().int().nonnegative().default(2),
    /** Acceptance margin δ in F(O′,B) > F(O,B) + δ. */
    delta: z.number().min(0).default(0.05),
    /** λ_F: cost weight in validation fitness F (per 1k tokens). */
    fitnessCostPer1kTokens: z.number().min(0).default(0.002),
    mutationSet: z.enum(['paper1', 'extended']).default('paper1'),
    proposer: z.enum(['heuristic', 'llm', 'both', 'random']).default('heuristic'),
    maxProposalsPerTrigger: z.number().int().positive().default(2),
    rollback: z
      .object({
        enabled: z.boolean().default(true),
        window: z.number().int().positive().default(10),
        dropThreshold: z.number().min(0).max(1).default(0.2),
      })
      .strict()
      .default({ enabled: true, window: 10, dropThreshold: 0.2 }),
  })
  .strict();
export type EvolutionConfig = z.infer<typeof EvolutionConfig>;

export const PolicyConfig = z
  .object({
    kind: z.enum(['none', 'random', 'heuristic', 'thompson']).default('none'),
    /** Genome variant ids the per-task policy chooses among. */
    candidates: z.array(z.string()).default([]),
  })
  .strict();
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export const CONDITIONS = [
  'single-agent', // B0
  'fixed-generalist', // B1
  'fixed-specialist', // B2
  'per-task-adaptive', // B3
  'agentconductor-style', // B4 (not implemented — C-05)
  'metagen-style', // B5 (not implemented — C-05)
  'tacomas-style', // B6 Part III (not implemented — C-05)
  'oracle', // B6 Part II (synthetic only)
  'random-evolution', // B7
  'evoorg', // B8
  'objective', // product mode, not a research condition
] as const;
export const Condition = z.enum(CONDITIONS);
export type Condition = z.infer<typeof Condition>;

export const Seeds = z
  .object({
    benchmark: z.number().int().default(1),
    taskOrder: z.number().int().default(1),
    organization: z.number().int().default(1),
    mutation: z.number().int().default(1),
  })
  .strict();

export const RunConfig = z
  .object({
    runId: z.string(),
    mode: z.enum(['sandbox', 'experiment']),
    kind: z.enum(['objective', 'stream']),
    condition: Condition,
    label: z.string().optional(),
    objective: z.string().optional(),
    streamId: z.string().optional(),
    experimentId: z.string().optional(),
    genome: OrganizationGenome,
    model: ModelConfig,
    budget: BudgetConfig,
    reward: RewardConfig,
    seeds: Seeds,
    features: FeatureFlags,
    ablations: z.array(Ablation).default([]),
    evolution: EvolutionConfig,
    policy: PolicyConfig,
    versions: z.record(z.string(), z.union([z.string(), z.number()])),
    environment: z.record(z.string(), z.string()),
  })
  .strict();
export type RunConfig = z.infer<typeof RunConfig>;
export type RunConfigInput = z.input<typeof RunConfig>;
