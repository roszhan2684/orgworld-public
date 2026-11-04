import { z } from 'zod';
import { GENOME_SCHEMA_VERSION } from './versions.ts';

/** Primitive capabilities a role may grant. Research II-§16: roles are structured, short descriptors. */
export const CAPABILITIES = [
  'write_code',
  'write_tests',
  'run_checks',
  'review',
  'research',
  'plan',
  'submit',
  'decide',
  'memory',
  'mediate',
] as const;
export const Capability = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof Capability>;

export const ROLE_OBJECTIVE_MAX = 240; // "Do not permit arbitrary 5,000-word role prompts" (II-§16)

export const RoleDescriptor = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    objective: z.string().min(1).max(ROLE_OBJECTIVE_MAX),
    inputTypes: z.array(z.string().max(48)).max(8),
    outputTypes: z.array(z.string().max(48)).max(8),
    capabilities: z.array(Capability).min(1),
  })
  .strict();
export type RoleDescriptor = z.infer<typeof RoleDescriptor>;

export const GenomeAgent = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    roleId: z.string().min(1),
    /** Optional per-agent model override (heterogeneous orgs, I-§67). */
    model: z.string().optional(),
    teamId: z.string().optional(),
  })
  .strict();
export type GenomeAgent = z.infer<typeof GenomeAgent>;

export const EDGE_KINDS = ['delegate', 'review', 'inform'] as const;
export const EdgeKind = z.enum(EDGE_KINDS);
/** A directed communication permission: `from` may send messages to `to`. */
export const Edge = z.object({ from: z.string(), to: z.string(), kind: EdgeKind }).strict();
export type Edge = z.infer<typeof Edge>;

export const DECISION_POLICIES = [
  'DIRECTOR',
  'MAJORITY',
  'WEIGHTED_VOTE',
  'EXPERT_AUTHORITY',
  'CONSENSUS',
  'VETO',
  'EVIDENCE_THRESHOLD',
  'RL_SELECTED',
] as const;
export const DecisionPolicy = z.enum(DECISION_POLICIES);
export type DecisionPolicy = z.infer<typeof DecisionPolicy>;

export const Team = z.object({ id: z.string(), name: z.string(), members: z.array(z.string()) }).strict();

export const GenomePolicies = z
  .object({
    /** Who may submit the final deliverable. */
    submit: z.enum(['entry', 'capability', 'any']).default('capability'),
    decision: DecisionPolicy.default('MAJORITY'),
    maxTurnsPerTask: z.number().int().min(1).max(200).default(24),
    maxActionsPerTurn: z.number().int().min(1).max(8).default(3),
    /** Memory read access by scope. */
    memoryRead: z.enum(['none', 'private', 'team', 'org']).default('org'),
  })
  .strict();

/** Constitutional constraint set Ω (I-§62, II-§63). Mutations violating Ω are rejected. */
export const GenomeConstraints = z
  .object({
    minAgents: z.number().int().min(1).default(1),
    maxAgents: z.number().int().min(1).default(16),
    /** Task categories for which at least one agent with `review` capability must be reachable from the entry agent. */
    verifierRequiredFor: z.array(z.string()).default([]),
    /** Entry agent can never be removed. */
    protectEntry: z.boolean().default(true),
  })
  .strict();

export const OrganizationGenome = z
  .object({
    schemaVersion: z.literal(GENOME_SCHEMA_VERSION),
    id: z.string(),
    name: z.string(),
    preset: z.string(),
    generation: z.number().int().min(0),
    parentId: z.string().nullable(),
    createdBy: z.string(), // 'preset' | 'designer' | mutation id | 'rollback:<id>'
    roles: z.array(RoleDescriptor).min(1),
    agents: z.array(GenomeAgent).min(1),
    edges: z.array(Edge),
    teams: z.array(Team).default([]),
    entryAgentId: z.string(),
    policies: GenomePolicies,
    constraints: GenomeConstraints,
  })
  .strict();
export type OrganizationGenome = z.infer<typeof OrganizationGenome>;
export type OrganizationGenomeInput = z.input<typeof OrganizationGenome>;

/* ---------------- Mutations ---------------- */

/** Paper #1 mutation set (II-§9). */
export const PAPER1_MUTATIONS = ['ADD_AGENT', 'REMOVE_AGENT', 'CHANGE_ROLE', 'ADD_EDGE', 'REMOVE_EDGE'] as const;
/** Additional operators from build §6 — `exploratory`, disabled unless the experiment opts in (conflict C-02). */
export const EXPLORATORY_MUTATIONS = [
  'CREATE_TEAM',
  'DISSOLVE_TEAM',
  'CHANGE_DECISION_METHOD',
  'CHANGE_SUBMIT_POLICY',
  'ROLLBACK',
] as const;

export const Mutation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ADD_AGENT'), agent: GenomeAgent, role: RoleDescriptor.optional() }).strict(),
  z.object({ type: z.literal('REMOVE_AGENT'), agentId: z.string() }).strict(),
  z.object({ type: z.literal('CHANGE_ROLE'), agentId: z.string(), role: RoleDescriptor }).strict(),
  z.object({ type: z.literal('ADD_EDGE'), edge: Edge }).strict(),
  z.object({ type: z.literal('REMOVE_EDGE'), from: z.string(), to: z.string() }).strict(),
  z.object({ type: z.literal('CREATE_TEAM'), team: Team }).strict(),
  z.object({ type: z.literal('DISSOLVE_TEAM'), teamId: z.string() }).strict(),
  z.object({ type: z.literal('CHANGE_DECISION_METHOD'), policy: DecisionPolicy }).strict(),
  z.object({ type: z.literal('CHANGE_SUBMIT_POLICY'), submit: z.enum(['entry', 'capability', 'any']) }).strict(),
  z.object({ type: z.literal('ROLLBACK'), toGenomeId: z.string() }).strict(),
]);
export type Mutation = z.infer<typeof Mutation>;

/** Every proposal carries observed evidence and a falsifiable hypothesis (II-§10, I-§43). */
export const MutationProposal = z
  .object({
    id: z.string(),
    mutation: Mutation,
    proposer: z.enum(['heuristic', 'llm', 'random', 'designer', 'user']),
    evidence: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    hypothesis: z.string().min(1).max(500),
    expectedEffect: z.object({ success: z.number().optional(), costDelta: z.number().optional() }).strict(),
  })
  .strict();
export type MutationProposal = z.infer<typeof MutationProposal>;
