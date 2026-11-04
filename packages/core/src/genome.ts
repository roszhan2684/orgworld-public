import {
  EXPLORATORY_MUTATIONS,
  OrganizationGenome,
  PAPER1_MUTATIONS,
  type Capability,
  type Mutation,
  type RoleDescriptor,
} from '@orgworld/protocol';
import { hashObject, newId, stableStringify } from './util.ts';

export class MutationError extends Error {
  constructor(
    message: string,
    public readonly reasons: string[],
  ) {
    super(message);
    this.name = 'MutationError';
  }
}

export interface GenomeValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function roleOf(g: OrganizationGenome, agentId: string): RoleDescriptor | undefined {
  const a = g.agents.find((x) => x.id === agentId);
  return a ? g.roles.find((r) => r.id === a.roleId) : undefined;
}

export function capabilitiesOf(g: OrganizationGenome, agentId: string): Capability[] {
  return roleOf(g, agentId)?.capabilities ?? [];
}

export function canSubmit(g: OrganizationGenome, agentId: string): boolean {
  if (!g.agents.some((a) => a.id === agentId)) return false;
  switch (g.policies.submit) {
    case 'any':
      return true;
    case 'entry':
      return agentId === g.entryAgentId;
    case 'capability':
      return capabilitiesOf(g, agentId).includes('submit');
  }
}

export function hasEdge(g: OrganizationGenome, from: string, to: string): boolean {
  return g.edges.some((e) => e.from === from && e.to === to);
}

export function outNeighbors(g: OrganizationGenome, id: string): string[] {
  return g.edges.filter((e) => e.from === id).map((e) => e.to);
}

export function reachableFrom(g: OrganizationGenome, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const q = [start];
  while (q.length) {
    const cur = q.shift()!;
    for (const n of outNeighbors(g, cur)) if (!seen.has(n)) (seen.add(n), q.push(n));
  }
  return seen;
}

/** Structural invariants + constitutional constraint set Ω. */
export function validateGenome(g: OrganizationGenome): GenomeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = OrganizationGenome.safeParse(g);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings };
  const agentIds = new Set<string>();
  for (const a of g.agents) {
    if (agentIds.has(a.id)) errors.push(`duplicate agent id ${a.id}`);
    agentIds.add(a.id);
    if (!g.roles.some((r) => r.id === a.roleId)) errors.push(`agent ${a.id} references unknown role ${a.roleId}`);
  }
  const roleIds = new Set<string>();
  for (const r of g.roles) {
    if (roleIds.has(r.id)) errors.push(`duplicate role id ${r.id}`);
    roleIds.add(r.id);
  }
  const edgeKeys = new Set<string>();
  for (const e of g.edges) {
    if (!agentIds.has(e.from) || !agentIds.has(e.to)) errors.push(`edge ${e.from}->${e.to} references unknown agent`);
    if (e.from === e.to) errors.push(`self-loop edge on ${e.from}`);
    const k = `${e.from}->${e.to}`;
    if (edgeKeys.has(k)) errors.push(`duplicate edge ${k}`);
    edgeKeys.add(k);
  }
  if (!agentIds.has(g.entryAgentId)) errors.push(`entry agent ${g.entryAgentId} does not exist`);
  const c = g.constraints;
  if (g.agents.length < c.minAgents) errors.push(`Ω: fewer than minAgents (${c.minAgents})`);
  if (g.agents.length > c.maxAgents) errors.push(`Ω: more than maxAgents (${c.maxAgents})`);
  if (g.policies.submit === 'capability' && !g.agents.some((a) => capabilitiesOf(g, a.id).includes('submit')))
    errors.push('no agent can submit (submit policy = capability, no agent has submit capability)');
  if (agentIds.has(g.entryAgentId)) {
    const reach = reachableFrom(g, g.entryAgentId);
    if (c.verifierRequiredFor.length > 0 && ![...reach].some((id) => capabilitiesOf(g, id).includes('review')))
      errors.push(`Ω: a reviewer must be reachable from the entry agent (verifierRequiredFor=${c.verifierRequiredFor.join(',')})`);
    for (const a of g.agents) if (!reach.has(a.id)) warnings.push(`agent ${a.id} is unreachable from entry ${g.entryAgentId}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function isMutationAllowed(m: Mutation, set: 'paper1' | 'extended', ablations: readonly string[] = []): string | null {
  if (set === 'paper1' && !(PAPER1_MUTATIONS as readonly string[]).includes(m.type) && m.type !== 'ROLLBACK')
    return `${m.type} is exploratory and not in the paper1 mutation set (conflict C-02)`;
  if (!(PAPER1_MUTATIONS as readonly string[]).includes(m.type) && !(EXPLORATORY_MUTATIONS as readonly string[]).includes(m.type))
    return `unknown mutation ${m.type}`;
  if (ablations.includes('no-role-evolution') && m.type === 'CHANGE_ROLE') return 'ablation no-role-evolution';
  if (ablations.includes('no-membership-evolution') && (m.type === 'ADD_AGENT' || m.type === 'REMOVE_AGENT'))
    return 'ablation no-membership-evolution';
  if (ablations.includes('no-topology-evolution') && (m.type === 'ADD_EDGE' || m.type === 'REMOVE_EDGE'))
    return 'ablation no-topology-evolution';
  return null;
}

function ensureRole(roles: RoleDescriptor[], role: RoleDescriptor): RoleDescriptor[] {
  const existing = roles.find((r) => r.id === role.id);
  if (!existing) return [...roles, role];
  if (stableStringify(existing) !== stableStringify(role))
    throw new MutationError(`role id ${role.id} already exists with different content`, ['role content mismatch']);
  return roles;
}

function pruneRoles(g: OrganizationGenome): OrganizationGenome {
  const used = new Set(g.agents.map((a) => a.roleId));
  return { ...g, roles: g.roles.filter((r) => used.has(r.id)) };
}

/**
 * Pure: returns a NEW genome (generation+1, parentId = old id). Never mutates the input.
 * Throws MutationError if the mutation is malformed or the result violates invariants/Ω.
 */
export function applyMutation(g: OrganizationGenome, m: Mutation, opts: { createdBy: string; id?: string }): OrganizationGenome {
  let next: OrganizationGenome = structuredClone(g);
  const has = (id: string) => next.agents.some((a) => a.id === id);
  switch (m.type) {
    case 'ADD_AGENT': {
      if (has(m.agent.id)) throw new MutationError(`agent ${m.agent.id} already exists`, ['duplicate agent']);
      if (m.role) {
        if (m.role.id !== m.agent.roleId) throw new MutationError('role.id must equal agent.roleId', ['role mismatch']);
        next.roles = ensureRole(next.roles, m.role);
      } else if (!next.roles.some((r) => r.id === m.agent.roleId))
        throw new MutationError(`unknown role ${m.agent.roleId} and no descriptor supplied`, ['unknown role']);
      next.agents.push(m.agent);
      // Default wiring (documented): entry delegates to the new agent and it reports back.
      next.edges.push({ from: next.entryAgentId, to: m.agent.id, kind: 'delegate' }, { from: m.agent.id, to: next.entryAgentId, kind: 'inform' });
      break;
    }
    case 'REMOVE_AGENT': {
      if (!has(m.agentId)) throw new MutationError(`agent ${m.agentId} not found`, ['missing agent']);
      if (next.constraints.protectEntry && m.agentId === next.entryAgentId)
        throw new MutationError('Ω: entry agent is protected', ['protected entry']);
      next.agents = next.agents.filter((a) => a.id !== m.agentId);
      next.edges = next.edges.filter((e) => e.from !== m.agentId && e.to !== m.agentId);
      next.teams = next.teams.map((t) => ({ ...t, members: t.members.filter((x) => x !== m.agentId) }));
      break;
    }
    case 'CHANGE_ROLE': {
      const a = next.agents.find((x) => x.id === m.agentId);
      if (!a) throw new MutationError(`agent ${m.agentId} not found`, ['missing agent']);
      if (a.roleId === m.role.id) throw new MutationError('agent already has this role', ['no-op']);
      next.roles = ensureRole(next.roles, m.role);
      a.roleId = m.role.id;
      break;
    }
    case 'ADD_EDGE': {
      if (!has(m.edge.from) || !has(m.edge.to)) throw new MutationError('edge endpoint missing', ['missing agent']);
      if (hasEdge(next, m.edge.from, m.edge.to)) throw new MutationError('edge already exists', ['duplicate edge']);
      next.edges.push(m.edge);
      break;
    }
    case 'REMOVE_EDGE': {
      if (!hasEdge(next, m.from, m.to)) throw new MutationError('edge not found', ['missing edge']);
      next.edges = next.edges.filter((e) => !(e.from === m.from && e.to === m.to));
      break;
    }
    case 'CREATE_TEAM':
      if (next.teams.some((t) => t.id === m.team.id)) throw new MutationError('team exists', ['duplicate team']);
      next.teams.push(m.team);
      break;
    case 'DISSOLVE_TEAM':
      if (!next.teams.some((t) => t.id === m.teamId)) throw new MutationError('team not found', ['missing team']);
      next.teams = next.teams.filter((t) => t.id !== m.teamId);
      break;
    case 'CHANGE_DECISION_METHOD':
      next.policies = { ...next.policies, decision: m.policy };
      break;
    case 'CHANGE_SUBMIT_POLICY':
      next.policies = { ...next.policies, submit: m.submit };
      break;
    case 'ROLLBACK':
      throw new MutationError('ROLLBACK is applied by the controller from the archived genome, not via applyMutation', ['use rollback']);
  }
  next = pruneRoles(next);
  next = { ...next, id: opts.id ?? newId('genome'), generation: g.generation + 1, parentId: g.id, createdBy: opts.createdBy };
  const v = validateGenome(next);
  if (!v.ok) throw new MutationError(`mutation ${m.type} produces an invalid organization: ${v.errors.join('; ')}`, v.errors);
  return next;
}

export interface GenomeDiff {
  agentsAdded: string[];
  agentsRemoved: string[];
  roleChanges: Array<{ agentId: string; from: string; to: string }>;
  edgesAdded: string[];
  edgesRemoved: string[];
  /** Structural churn units (I-§35): agents added + removed + role changes + edge changes. */
  churn: number;
}

export function diffGenomes(a: OrganizationGenome, b: OrganizationGenome): GenomeDiff {
  const aIds = new Set(a.agents.map((x) => x.id));
  const bIds = new Set(b.agents.map((x) => x.id));
  const agentsAdded = [...bIds].filter((x) => !aIds.has(x));
  const agentsRemoved = [...aIds].filter((x) => !bIds.has(x));
  const roleChanges: GenomeDiff['roleChanges'] = [];
  for (const ag of b.agents) {
    const old = a.agents.find((x) => x.id === ag.id);
    if (old && old.roleId !== ag.roleId) roleChanges.push({ agentId: ag.id, from: old.roleId, to: ag.roleId });
  }
  const ek = (g: OrganizationGenome) => new Set(g.edges.map((e) => `${e.from}->${e.to}`));
  const ea = ek(a),
    eb = ek(b);
  const edgesAdded = [...eb].filter((x) => !ea.has(x));
  const edgesRemoved = [...ea].filter((x) => !eb.has(x));
  return {
    agentsAdded,
    agentsRemoved,
    roleChanges,
    edgesAdded,
    edgesRemoved,
    churn: agentsAdded.length + agentsRemoved.length + roleChanges.length + edgesAdded.length + edgesRemoved.length,
  };
}

/** Content hash ignoring identity/lineage fields: two genomes with the same structure hash equal. */
export function genomeStructureHash(g: OrganizationGenome): string {
  const { id: _id, generation: _g, parentId: _p, createdBy: _c, name: _n, ...structure } = g;
  return hashObject(structure);
}
