import { z } from 'zod';
import { RunConfig } from './config.ts';
import { Mutation, MutationProposal, OrganizationGenome, Capability, Team } from './genome.ts';
import { EVENT_SCHEMA_VERSION } from './versions.ts';

/* ---------------- shared sub-schemas ---------------- */

export const CALL_CATEGORIES = ['task', 'controller', 'validation', 'probe'] as const;
export const CallCategory = z.enum(CALL_CATEGORIES);
export type CallCategory = z.infer<typeof CallCategory>;

export const Usage = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    cacheCreationTokens: z.number().int().nonnegative().default(0),
  })
  .strict();
export type Usage = z.infer<typeof Usage>;

export const MESSAGE_KINDS = [
  'DIRECT_MESSAGE',
  'BROADCAST',
  'QUESTION',
  'ANSWER',
  'PROPOSAL',
  'CHALLENGE',
  'EVIDENCE',
  'REVIEW_REQUEST',
  'REVIEW_RESPONSE',
  'DELEGATION',
  'STATUS_UPDATE',
] as const;
export const MessageKind = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKind>;

export const ARTIFACT_KINDS = [
  'code',
  'tests',
  'test_report',
  'review',
  'research_note',
  'plan',
  'proposal',
  'hypothesis',
  'decision_record',
  'risk_report',
  'evaluation',
  'note',
] as const;
export const ArtifactKind = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const AGENT_STATUSES = [
  'idle',
  'thinking',
  'working',
  'communicating',
  'meeting',
  'reviewing',
  'waiting',
  'blocked',
  'failed',
  'removed',
] as const;
export const AgentStatus = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const MemoryScope = z.enum(['private', 'team', 'org']);
export const MemoryKind = z.enum(['episodic', 'semantic', 'decision', 'failure']);
/** Build §15: never store a lesson without where it came from. */
export const Provenance = z
  .object({
    runId: z.string(),
    taskId: z.string().nullable(),
    genomeId: z.string(),
    sourceEventIds: z.array(z.string()).min(1),
    evidenceArtifactIds: z.array(z.string()).default([]),
    outcome: z.string().optional(),
  })
  .strict();

const id = z.string().min(1);
const nid = z.string().nullable();
const rec = z.record(z.string(), z.unknown());

/* ---------------- payloads ---------------- */

export const EventPayloads = {
  RUN_CREATED: z.object({ config: RunConfig }).strict(),
  RUN_STARTED: z.object({}).strict(),
  RUN_PAUSED: z.object({ reason: z.string().optional() }).strict(),
  RUN_RESUMED: z.object({}).strict(),
  RUN_COMPLETED: z.object({ summary: rec }).strict(),
  /** `infrastructure: true` = the model service failed (outage, auth, bad config), not the agents; see C-19. */
  RUN_FAILED: z.object({ error: z.string(), infrastructure: z.boolean().optional() }).strict(),

  ORGANIZATION_INSTANTIATED: z.object({ genome: OrganizationGenome, reason: z.string() }).strict(),
  PHASE_CHANGED: z
    .object({ phaseIndex: z.number().int(), phaseId: z.string(), mix: z.record(z.string(), z.number()) })
    .strict(),

  AGENT_CREATED: z
    .object({
      agentId: id,
      name: z.string(),
      roleId: z.string(),
      roleName: z.string(),
      roleObjective: z.string(),
      capabilities: z.array(Capability),
      modelProvider: z.string(),
      modelName: z.string(),
      generation: z.number().int(),
      teamId: z.string().optional(),
    })
    .strict(),
  AGENT_REMOVED: z.object({ agentId: id, reason: z.string() }).strict(),
  AGENT_STATUS_CHANGED: z
    .object({ agentId: id, status: AgentStatus, activity: z.string().max(160), taskId: nid.optional() })
    .strict(),
  AGENT_FAILED: z
    .object({ agentId: id, error: z.string(), recovery: z.enum(['retry', 'reassign', 'abort', 'continue']) })
    .strict(),

  TASK_CREATED: z
    .object({
      taskId: id,
      parentId: nid,
      title: z.string(),
      objective: z.string(),
      source: z.enum(['bench', 'objective', 'subtask']),
      category: z.string().optional(),
      family: z.string().optional(),
      taskIndex: z.number().int().optional(),
      phaseId: z.string().optional(),
      split: z.enum(['train', 'validation', 'test', 'transfer']).optional(),
      publicCheckCount: z.number().int().optional(),
      priority: z.number().int().optional(),
    })
    .strict(),
  TASK_ASSIGNED: z.object({ taskId: id, agentId: id, byAgentId: nid }).strict(),
  TASK_STARTED: z.object({ taskId: id }).strict(),
  TASK_COMPLETED: z
    .object({
      taskId: id,
      success: z.boolean(),
      score: z.number(),
      submittedArtifactId: nid,
      submittedBy: nid,
      forced: z.boolean(),
    })
    .strict(),
  TASK_FAILED: z.object({ taskId: id, reason: z.string(), score: z.number() }).strict(),

  MESSAGE_SENT: z
    .object({
      messageId: id,
      from: id,
      to: z.array(id).min(1),
      kind: MessageKind,
      content: z.string().max(8000),
      taskId: nid,
      artifactIds: z.array(z.string()).default([]),
      decisionId: z.string().optional(),
      meetingId: z.string().optional(),
      tokenCost: z.number().int().nonnegative(),
    })
    .strict(),
  MESSAGE_RECEIVED: z.object({ messageId: id, agentId: id }).strict(),

  MEETING_CREATED: z
    .object({
      meetingId: id,
      convenerId: id,
      participants: z.array(id).min(2),
      reason: z.string(),
      agenda: z.string(),
      taskId: nid,
      inputArtifactIds: z.array(z.string()).default([]),
    })
    .strict(),
  MEETING_STARTED: z.object({ meetingId: id }).strict(),
  MEETING_ENDED: z
    .object({ meetingId: id, outcome: z.string(), decisionIds: z.array(z.string()), tokenCost: z.number().int() })
    .strict(),

  ARTIFACT_CREATED: z
    .object({
      artifactId: id,
      kind: ArtifactKind,
      title: z.string().max(200),
      taskId: nid,
      authorId: id,
      content: z.string().max(262_144),
      contentHash: z.string(),
      parents: z.array(z.string()).default([]),
      /** Agents that can see this artifact at creation time (author + task-visible). Knowledge spreads only via messages/meetings. */
      visibleTo: z.array(z.string()),
    })
    .strict(),

  EXPERIMENT_STARTED: z
    .object({ experimentRunId: id, taskId: id, agentId: id, artifactId: id, kind: z.literal('public_checks') })
    .strict(),
  EXPERIMENT_COMPLETED: z
    .object({
      experimentRunId: id,
      taskId: id,
      agentId: id,
      passed: z.number().int(),
      failed: z.number().int(),
      total: z.number().int(),
      durationMs: z.number(),
      timedOut: z.boolean(),
      output: z.string().max(8000),
      reportArtifactId: z.string(),
    })
    .strict(),

  DECISION_CREATED: z
    .object({
      decisionId: id,
      question: z.string(),
      options: z.array(z.string()).min(2),
      proposerId: id,
      recommendation: z.string(),
      evidence: z.array(z.string()),
      policy: z.string(),
      participants: z.array(id),
      taskId: nid,
    })
    .strict(),
  VOTE_CAST: z
    .object({ decisionId: id, agentId: id, option: z.string(), rationale: z.string().max(1000), weight: z.number() })
    .strict(),
  DECISION_COMPLETED: z
    .object({
      decisionId: id,
      chosen: z.string(),
      confidence: z.number().min(0).max(1),
      policy: z.string(),
      tally: z.record(z.string(), z.number()),
      rationale: z.string(),
      opposition: z.array(z.string()),
    })
    .strict(),

  MEMORY_WRITTEN: z
    .object({
      memoryId: id,
      scope: MemoryScope,
      kind: MemoryKind,
      ownerAgentId: z.string().optional(),
      teamId: z.string().optional(),
      content: z.string().max(4000),
      provenance: Provenance,
    })
    .strict(),
  MEMORY_RETRIEVED: z
    .object({
      agentId: id,
      query: z.string(),
      itemIds: z.array(z.string()),
      latencyMs: z.number(),
      deniedItemIds: z.array(z.string()).default([]),
    })
    .strict(),
  BELIEF_UPDATED: z
    .object({
      agentId: id,
      beliefId: id,
      claim: z.string().max(500),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string()),
    })
    .strict(),
  RELATIONSHIP_UPDATED: z
    .object({
      from: id,
      to: id,
      field: z.enum(['trust', 'agreementRate', 'reviewAccuracy', 'delegationSuccess']),
      delta: z.number(),
      value: z.number(),
      causeEventId: id,
    })
    .strict(),

  MODEL_CALL_STARTED: z
    .object({
      callId: id,
      agentId: nid,
      taskId: nid,
      category: CallCategory,
      purpose: z.string(),
      provider: z.string(),
      model: z.string(),
    })
    .strict(),
  MODEL_CALL_COMPLETED: z
    .object({
      callId: id,
      agentId: nid,
      taskId: nid,
      category: CallCategory,
      provider: z.string(),
      model: z.string(),
      usage: Usage,
      costUsd: z.number().nonnegative(),
      latencyMs: z.number().nonnegative(),
      samplingControlled: z.boolean(),
    })
    .strict(),
  MODEL_CALL_FAILED: z.object({ callId: id, agentId: nid, taskId: nid, error: z.string() }).strict(),

  BUDGET_UPDATED: z
    .object({
      scope: z.enum(['task', 'run']),
      taskId: nid,
      tokensUsed: z.number().int().nonnegative(),
      tokensLimit: z.number().int().nullable(),
      callsUsed: z.number().int().nonnegative(),
      callsLimit: z.number().int().nullable(),
      usdUsed: z.number().nonnegative(),
      usdLimit: z.number().nullable(),
    })
    .strict(),
  BUDGET_EXHAUSTED: z
    .object({ scope: z.enum(['task', 'run', 'agent']), taskId: nid, resource: z.string(), detail: z.string() })
    .strict(),

  ACTION_REJECTED: z.object({ agentId: nid, action: z.string(), reason: z.string(), taskId: nid }).strict(),
  TOOL_INVOKED: z
    .object({
      tool: z.string(),
      group: z.enum(['read', 'write', 'exec']),
      input: rec,
      ok: z.boolean(),
      error: z.string().optional(),
    })
    .strict(),

  EVALUATION_COMPLETED: z
    .object({
      taskId: id,
      evaluator: z.enum(['hidden-tests', 'none', 'agent-review']),
      score: z.number().min(0).max(1),
      passed: z.number().int(),
      total: z.number().int(),
      details: z.string().max(8000),
      artifactId: nid,
    })
    .strict(),
  REWARD_RECORDED: z
    .object({
      taskId: id,
      total: z.number(),
      success: z.boolean(),
      terms: z.record(z.string(), z.number()),
      rewardConfigHash: z.string(),
    })
    .strict(),

  RL_STATE_OBSERVED: z.object({ policyKind: z.string(), taskId: nid, features: rec }).strict(),
  RL_ACTION_SELECTED: z
    .object({
      policyKind: z.string(),
      label: z.enum(['random baseline', 'heuristic policy', 'bandit policy', 'trained RL policy']),
      taskId: nid,
      candidates: z.array(z.object({ id: z.string(), score: z.number() }).strict()),
      chosen: z.string(),
    })
    .strict(),

  EVOLUTION_TRIGGERED: z
    .object({ trigger: z.string(), taskIndex: z.number().int(), generation: z.number().int() })
    .strict(),
  DIAGNOSIS_RECORDED: z.object({ diagnosis: rec }).strict(),
  MUTATION_PROPOSED: z.object({ proposal: MutationProposal }).strict(),
  MUTATION_VALIDATED: z
    .object({
      proposalId: id,
      method: z.enum(['paired-reexecution', 'skipped-ablation']),
      incumbentScore: z.number().nullable(),
      candidateScore: z.number().nullable(),
      margin: z.number(),
      bufferTaskIds: z.array(z.string()),
      accepted: z.boolean(),
      /** Counterfactual re-executions run as separate shadow runs; their cost is attributed here (III Control 4). */
      shadowRunIds: z.array(z.string()).default([]),
      cost: z
        .object({ tokens: z.number().nonnegative(), calls: z.number().int().nonnegative(), usd: z.number().nonnegative() })
        .strict()
        .default({ tokens: 0, calls: 0, usd: 0 }),
    })
    .strict(),
  MUTATION_REJECTED: z.object({ proposalId: id, reason: z.string() }).strict(),
  ORGANIZATION_MUTATED: z
    .object({
      proposalId: nid,
      fromGenomeId: id,
      toGenomeId: id,
      generation: z.number().int(),
      mutation: Mutation,
      genome: OrganizationGenome,
    })
    .strict(),
  ORGANIZATION_ROLLED_BACK: z
    .object({ fromGenomeId: id, toGenomeId: id, reason: z.string(), genome: OrganizationGenome })
    .strict(),
  ROLE_CHANGED: z.object({ agentId: id, fromRoleId: z.string(), toRoleId: z.string() }).strict(),
  TEAM_CREATED: z.object({ team: Team }).strict(),
  TEAM_DISSOLVED: z.object({ teamId: id }).strict(),

  PROBE_EVALUATED: z
    .object({ probeId: id, purpose: z.string(), genomeId: id, taskId: id, score: z.number() })
    .strict(),
  ANOMALY_DETECTED: z.object({ kind: z.string(), detail: z.string() }).strict(),
  CONTAMINATION_RECORDED: z.object({ source: z.string(), action: z.string(), detail: z.string() }).strict(),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];
export type PayloadOf<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;
export type PayloadInputOf<T extends EventType> = z.input<(typeof EventPayloads)[T]>;

/* ---------------- envelope ---------------- */

export const EventEnvelope = z
  .object({
    eventId: id,
    runId: id,
    sequence: z.number().int().positive(),
    timestamp: z.string(),
    type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
    actorId: z.string().nullable(),
    payload: z.unknown(),
    causedBy: z.string().nullable(),
    correlationId: z.string().nullable(),
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  })
  .strict();

export type OrgEvent<T extends EventType = EventType> = {
  [K in T]: {
    eventId: string;
    runId: string;
    sequence: number;
    timestamp: string;
    type: K;
    actorId: string | null;
    payload: PayloadOf<K>;
    causedBy: string | null;
    correlationId: string | null;
    schemaVersion: typeof EVENT_SCHEMA_VERSION;
  };
}[T];

/** What a producer hands to the store; the store assigns eventId/sequence/timestamp. */
export type EventDraft<T extends EventType = EventType> = {
  [K in T]: {
    type: K;
    actorId: string | null;
    payload: PayloadInputOf<K>;
    causedBy?: string | null;
    correlationId?: string | null;
  };
}[T];

export class EventValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: unknown,
  ) {
    super(message);
    this.name = 'EventValidationError';
  }
}

/** Validates envelope + type-specific payload; returns the parsed (defaults applied) event. */
export function parseEvent(raw: unknown): OrgEvent {
  const env = EventEnvelope.safeParse(raw);
  if (!env.success) throw new EventValidationError('Invalid event envelope', env.error.issues);
  const schema = EventPayloads[env.data.type];
  const payload = schema.safeParse(env.data.payload);
  if (!payload.success)
    throw new EventValidationError(`Invalid payload for ${env.data.type}`, payload.error.issues);
  return { ...env.data, payload: payload.data } as OrgEvent;
}

export function parsePayload<T extends EventType>(type: T, payload: unknown): PayloadOf<T> {
  const r = EventPayloads[type].safeParse(payload);
  if (!r.success) throw new EventValidationError(`Invalid payload for ${type}`, r.error.issues);
  return r.data as PayloadOf<T>;
}
