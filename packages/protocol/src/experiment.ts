import { z } from 'zod';
import {
  Ablation,
  BudgetConfig,
  Condition,
  EvolutionConfig,
  FeatureFlags,
  ModelConfig,
  PolicyConfig,
  RewardConfig,
} from './config.ts';
import { GenomeConstraints } from './genome.ts';

export const STREAM_KINDS = ['stationary', 'abrupt', 'gradual', 'recurring'] as const;

export const StreamSpec = z
  .object({
    kind: z.enum(STREAM_KINDS),
    tasks: z.number().int().positive(),
    seed: z.number().int().default(1),
    /** Category mixes per phase; required for abrupt/gradual/recurring. */
    phases: z
      .array(z.object({ id: z.string(), mix: z.record(z.string(), z.number().nonnegative()) }).strict())
      .min(1),
    split: z.enum(['train', 'validation', 'test', 'transfer']).default('train'),
    /** Families excluded from this stream (held-out for transfer). */
    excludeFamilies: z.array(z.string()).default([]),
  })
  .strict();
export type StreamSpec = z.infer<typeof StreamSpec>;

export const ConditionSpec = z
  .object({
    id: z.string(),
    condition: Condition,
    preset: z.string(),
    policy: PolicyConfig.optional(),
    evolution: EvolutionConfig.partial().optional(),
    ablations: z.array(Ablation).default([]),
    features: FeatureFlags.partial().optional(),
    /** Overrides the preset's constitutional constraint set Ω (I-§62, II-§63), e.g. `verifierRequiredFor: [security]`. */
    constraints: GenomeConstraints.partial().optional(),
  })
  .strict();

/** Build §63 + research II-§35/§67. Frozen (hashed) when the experiment locks. */
export const ExperimentConfig = z
  .object({
    experiment: z.object({ name: z.string(), description: z.string().default(''), hypotheses: z.array(z.string()).default([]) }).strict(),
    stream: StreamSpec,
    conditions: z.array(ConditionSpec).min(1),
    repetitions: z.number().int().positive().default(1),
    controls: z
      .object({
        model: ModelConfig,
        budget: BudgetConfig.default(BudgetConfig.parse({})),
        reward: RewardConfig.default(RewardConfig.parse({})),
        features: FeatureFlags.default(FeatureFlags.parse({})),
        /** Hard ceiling across the whole experiment (all conditions × repetitions). */
        maxTotalUsd: z.number().positive().default(5),
      })
      .strict(),
    metrics: z.array(z.string()).default(['CR', 'SR', 'CPS', 'AHL', 'SC', 'lifetimeTokens']),
    /**
     * Pre-registered paired comparisons (condition ids, a − b). Absent = the default: EvoOrg minus every other
     * condition on cumulative reward.
     */
    comparisons: z.array(z.object({ a: z.string(), b: z.string() }).strict()).optional(),
  })
  .strict();
export type ExperimentConfig = z.infer<typeof ExperimentConfig>;
export type ExperimentConfigInput = z.input<typeof ExperimentConfig>;
