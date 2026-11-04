import { GENOME_SCHEMA_VERSION, OrganizationGenome, type Edge } from '@orgworld/protocol';
import { presetGenome, roleVocabulary, validateGenome } from '@orgworld/core';
import { taskBrief, type OrgRunner, type TaskSpec } from '@orgworld/runtime';

function schemaFor(roleIds: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      agents: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, roleId: { type: 'string', enum: roleIds } }, required: ['id', 'roleId'] } },
      edges: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string', enum: ['delegate', 'review', 'inform'] } }, required: ['from', 'to', 'kind'] } },
      entry: { type: 'string' },
    },
    required: ['agents', 'edges', 'entry'],
  };
}

export interface DesignOptions {
  /**
   * The organization this baseline is compared against (the condition's preset). The designer uses its role
   * vocabulary (research library + its roles), its policies, and at least its size, and falls back to it when a
   * design is invalid. Default: specialist-pool, which reproduces the original B3 setup exactly.
   */
  base?: OrganizationGenome;
  maxAgents?: number;
}

/**
 * Baseline B3 "per-task adaptive organization" (research II-§23 B4 / III B3, conflict C-04): a designer call builds a
 * fresh organization for this task from the same role vocabulary; nothing persists across tasks. If the design is
 * invalid the fallback is recorded (ANOMALY_DETECTED) — never silently substituted.
 */
export async function designForTask(runner: OrgRunner, spec: TaskSpec, opts: DesignOptions = {}): Promise<OrganizationGenome> {
  const base = opts.base ?? presetGenome('specialist-pool');
  const maxAgents = opts.maxAgents ?? Math.max(5, base.agents.length);
  const vocab = roleVocabulary(base);
  const byId = new Map(vocab.map((r) => [r.id, r]));
  const roles = vocab.map((r) => `${r.id}: ${r.objective} [${r.capabilities.join(', ')}]`).join('\n');
  const submitters = vocab.filter((r) => r.capabilities.includes('submit')).map((r) => r.id);
  const json = (await runner.controllerCall(
    'design organization for task',
    `You design small AI agent organizations. Choose agents (each with a role id from the library), directed communication edges, and the entry agent (who receives the task and must be able to submit: give it one of these roles: ${submitters.join(', ')}). Use 1 to ${maxAgents} agents. Fewer agents cost less.`,
    `${taskBrief(spec)}\n\nROLE LIBRARY:\n${roles}\n\nReply JSON {agents:[{id, roleId}], edges:[{from,to,kind}], entry}.`,
    schemaFor([...byId.keys()]),
  )) as { agents?: Array<{ id: string; roleId: string }>; edges?: Edge[]; entry?: string } | null;
  try {
    if (!json?.agents?.length || !json.entry) throw new Error('empty design');
    const agents = json.agents.slice(0, maxAgents).map((a, i) => ({ id: (a.id || `d${i}`).replace(/[^a-z0-9_]/gi, '_').slice(0, 32), name: byId.get(a.roleId)?.name ?? a.roleId, roleId: a.roleId }));
    const ids = new Set(agents.map((a) => a.id));
    const roleIds = [...new Set(agents.map((a) => a.roleId))];
    const g = OrganizationGenome.parse({
      schemaVersion: GENOME_SCHEMA_VERSION,
      id: `design_${spec.kind === 'bench' ? spec.task.id.replace('#', '_') : 'objective'}_${Date.now().toString(36)}`,
      name: 'Per-task design',
      preset: 'designer',
      generation: 0,
      parentId: null,
      createdBy: 'designer',
      roles: roleIds.map((r) => byId.get(r)!).filter(Boolean),
      agents,
      edges: (json.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).filter((e, i, arr) => arr.findIndex((x) => x.from === e.from && x.to === e.to) === i),
      teams: [],
      entryAgentId: json.entry,
      policies: { ...base.policies },
      constraints: { minAgents: 1, maxAgents, verifierRequiredFor: [], protectEntry: true },
    });
    const v = validateGenome(g);
    if (!v.ok) throw new Error(v.errors.join('; '));
    return g;
  } catch (err) {
    runner.emit1({ type: 'ANOMALY_DETECTED', actorId: 'controller', payload: { kind: 'designer-invalid', detail: `designer output invalid (${err instanceof Error ? err.message : String(err)}); fell back to ${base.preset}` } });
    return structuredClone(base);
  }
}
