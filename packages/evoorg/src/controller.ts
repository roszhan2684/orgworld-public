import type { EvolutionConfig, Mutation, MutationProposal, OrganizationGenome, RoleDescriptor } from '@orgworld/protocol';
import { applyMutation, capabilitiesOf, isMutationAllowed, MutationError, newId, reachableFrom, Rng, ROLE_LIBRARY, roleVocabulary, validateGenome } from '@orgworld/core';
import type { CognitionProvider } from '@orgworld/cognition';
import { buildRunConfig, createRun, OrgRunner, type TaskOutcome, type TaskSpec } from '@orgworld/runtime';

export interface HistoryItem {
  index: number;
  spec: TaskSpec;
  outcome: TaskOutcome;
}

/** Category → specialist role in the library (used by the heuristic proposer). */
const SPECIALIST: Record<string, string> = {
  security: 'security_reviewer',
  debugging: 'debugger',
  testing: 'tester',
  refactoring: 'refactorer',
  implementation: 'implementer',
};

export interface Diagnosis {
  window: number;
  failuresByCategory: Record<string, number>;
  tasksByCategory: Record<string, number>;
  successRate: number;
  idleAgents: string[];
  unusedEdges: string[];
  meanTokens: number;
}

export function diagnose(runner: OrgRunner, window: HistoryItem[]): Diagnosis {
  const s = runner.state;
  const failures: Record<string, number> = {};
  const tasks: Record<string, number> = {};
  for (const h of window) {
    const c = h.outcome.category ?? 'objective';
    tasks[c] = (tasks[c] ?? 0) + 1;
    if (!h.outcome.success) failures[c] = (failures[c] ?? 0) + 1;
  }
  const ids = new Set(window.map((h) => h.outcome.taskId));
  const active = new Set<string>();
  const used = new Set<string>();
  for (const m of Object.values(s.messages)) {
    if (!m.taskId || !ids.has(m.taskId)) continue;
    active.add(m.from);
    for (const t of m.to) used.add(`${m.from}->${t}`);
  }
  for (const a of Object.values(s.artifacts)) if (a.taskId && ids.has(a.taskId)) active.add(a.authorId);
  const g = runner.genome;
  return {
    window: window.length,
    failuresByCategory: failures,
    tasksByCategory: tasks,
    successRate: window.length ? window.filter((h) => h.outcome.success).length / window.length : 0,
    idleAgents: g.agents.map((a) => a.id).filter((id) => id !== g.entryAgentId && !active.has(id)),
    unusedEdges: g.edges.map((e) => `${e.from}->${e.to}`).filter((k) => !used.has(k)),
    meanTokens: window.length ? window.reduce((a, h) => a + h.outcome.tokens, 0) / window.length : 0,
  };
}

function propose(m: Mutation, evidence: MutationProposal['evidence'], hypothesis: string, proposer: MutationProposal['proposer'], expected: MutationProposal['expectedEffect'] = {}): MutationProposal {
  return { id: newId('prop'), mutation: m, proposer, evidence, hypothesis, expectedEffect: expected };
}

/** Transparent rule-based proposer (Paper #1 mutation set). Each proposal cites the evidence that triggered it. */
export function heuristicProposals(g: OrganizationGenome, d: Diagnosis): MutationProposal[] {
  const out: MutationProposal[] = [];
  const worst = Object.entries(d.failuresByCategory).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= 2) {
    const [cat, n] = worst;
    const roleId = SPECIALIST[cat];
    const role = roleId ? ROLE_LIBRARY[roleId] : undefined;
    if (role && !g.agents.some((a) => a.roleId === role.id)) {
      const ev = { category: cat, failuresInWindow: n, tasksInWindow: d.tasksByCategory[cat] ?? 0, window: d.window };
      const generalist = g.agents.find((a) => a.id !== g.entryAgentId && (d.idleAgents.includes(a.id) || a.roleId === 'generalist'));
      if (generalist)
        out.push(propose({ type: 'CHANGE_ROLE', agentId: generalist.id, role }, ev, `Making ${generalist.id} a ${role.name} will reduce ${cat} failures (${n}/${d.tasksByCategory[cat]} failed).`, 'heuristic', { success: 0.1 }));
      if (g.agents.length < g.constraints.maxAgents)
        out.push(propose({ type: 'ADD_AGENT', agent: { id: `${role.id}_${g.generation + 1}`, name: role.name, roleId: role.id }, role }, ev, `A dedicated ${role.name} will reduce ${cat} failures.`, 'heuristic', { success: 0.1, costDelta: 0.15 }));
    }
    // A specialist that exists but cannot be reached from the entry agent cannot help.
    const spec = g.agents.find((a) => a.roleId === roleId);
    if (spec && !reachableFrom(g, g.entryAgentId).has(spec.id))
      out.push(propose({ type: 'ADD_EDGE', edge: { from: g.entryAgentId, to: spec.id, kind: 'delegate' } }, { category: cat, failuresInWindow: n }, `Connecting the entry agent to ${spec.id} lets ${cat} work reach the specialist.`, 'heuristic'));
  }
  for (const id of d.idleAgents.slice(0, 1))
    out.push(propose({ type: 'REMOVE_AGENT', agentId: id }, { idleTasks: d.window, window: d.window }, `${id} did no work in the last ${d.window} tasks; removing it lowers coordination cost without hurting success.`, 'heuristic', { costDelta: -0.1 }));
  for (const k of d.unusedEdges.slice(0, 1)) {
    const [from, to] = k.split('->') as [string, string];
    if (from === g.entryAgentId) continue;
    out.push(propose({ type: 'REMOVE_EDGE', from, to }, { unusedInWindow: d.window }, `Edge ${k} was never used in ${d.window} tasks; pruning it simplifies the organization.`, 'heuristic', { costDelta: -0.02 }));
  }
  return out;
}

/**
 * B7 random persistent evolution: a uniformly random valid mutation from the allowed set. `roles` is the role
 * vocabulary of the organization the run started from (see roleVocabulary); default: the research role library.
 */
export function randomProposal(g: OrganizationGenome, rng: Rng, roles: readonly RoleDescriptor[] = Object.values(ROLE_LIBRARY)): MutationProposal {
  const nonEntry = g.agents.filter((a) => a.id !== g.entryAgentId);
  const pairs = g.agents.flatMap((a) => g.agents.filter((b) => b.id !== a.id).map((b) => [a.id, b.id] as const));
  const options: Array<() => Mutation | null> = [
    () => {
      const r = rng.pick(roles);
      return { type: 'ADD_AGENT', agent: { id: `${r.id}_r${rng.int(1e6)}`, name: r.name, roleId: r.id }, role: r };
    },
    () => (nonEntry.length ? { type: 'REMOVE_AGENT', agentId: rng.pick(nonEntry).id } : null),
    () => (nonEntry.length ? { type: 'CHANGE_ROLE', agentId: rng.pick(nonEntry).id, role: rng.pick(roles) as RoleDescriptor } : null),
    () => {
      const free = pairs.filter(([a, b]) => !g.edges.some((e) => e.from === a && e.to === b));
      if (!free.length) return null;
      const [from, to] = rng.pick(free);
      return { type: 'ADD_EDGE', edge: { from, to, kind: 'inform' } };
    },
    () => (g.edges.length ? (({ from, to }) => ({ type: 'REMOVE_EDGE', from, to }) as Mutation)(rng.pick(g.edges)) : null),
  ];
  for (let i = 0; i < 50; i++) {
    const m = rng.pick(options)();
    if (!m) continue;
    try {
      applyMutation(g, m, { createdBy: 'probe' });
      return propose(m, { random: true }, 'Random structural change (baseline B7; no hypothesis).', 'random');
    } catch {
      /* try another */
    }
  }
  throw new Error('no valid random mutation found');
}

export interface ControllerOptions {
  runner: OrgRunner;
  provider: CognitionProvider;
  config: EvolutionConfig;
  ablations: readonly string[];
  seed: number;
  log?: (m: string) => void;
}

/**
 * Stage-3 EvolutionController (ADR-006, research II-§13–§14, I-§41–§47). Runs every K tasks, proposes
 * evidence-backed mutations, validates them by paired re-execution in shadow runs (cost attributed to the parent),
 * accepts only if F(O′,B) > F(O,B) + δ, and rolls back if performance drops after deployment.
 */
export class EvolutionController {
  private readonly rng: Rng;
  private shadowCount = 0;
  private watch: { parent: OrganizationGenome; acceptedAt: number; baseline: number } | null = null;
  /** Role vocabulary fixed from the starting organization, so roles pruned by evolution can still come back. */
  private vocab: RoleDescriptor[] | null = null;
  constructor(private readonly o: ControllerOptions) {
    this.rng = new Rng(o.seed);
    // The schema reserves an LLM proposer but none is implemented; refuse instead of silently running the heuristic.
    if (o.config.enabled && (o.config.proposer === 'llm' || o.config.proposer === 'both'))
      throw new Error(`evolution proposer "${o.config.proposer}" is not implemented in v0.1 (conflict C-20); use "heuristic" or "random"`);
  }

  private get enabled(): boolean {
    return this.o.config.enabled;
  }

  /** Call after each task with the full history so far (history[i] = task i). */
  async afterTask(history: HistoryItem[], phaseIndex: number): Promise<void> {
    if (!this.enabled) return;
    const n = history.length;
    this.vocab ??= roleVocabulary(this.o.runner.genome);
    await this.checkRollback(history);
    const { config: c, ablations } = this.o;
    if (ablations.includes('frozen-after-phase-1') && phaseIndex > 0) return;
    if (n < c.minTasksBeforeFirst || n % c.trigger.everyK !== 0) return;
    const r = this.o.runner;
    r.emit1({ type: 'EVOLUTION_TRIGGERED', actorId: 'controller', payload: { trigger: `periodic every ${c.trigger.everyK}`, taskIndex: n - 1, generation: r.genome.generation } });
    const windowSize = ablations.includes('no-history') ? 1 : c.historyWindow;
    const d = diagnose(r, history.slice(-windowSize));
    r.emit1({ type: 'DIAGNOSIS_RECORDED', actorId: 'controller', payload: { diagnosis: d as unknown as Record<string, unknown> } });
    const random = c.proposer === 'random';
    const proposals = (random ? [randomProposal(r.genome, this.rng, this.vocab)] : heuristicProposals(r.genome, d)).slice(0, c.maxProposalsPerTrigger);
    for (const p of proposals) {
      r.emit1({ type: 'MUTATION_PROPOSED', actorId: 'controller', payload: { proposal: p } });
      const blocked = isMutationAllowed(p.mutation, c.mutationSet, ablations);
      if (blocked) {
        r.emit1({ type: 'MUTATION_REJECTED', actorId: 'controller', payload: { proposalId: p.id, reason: blocked } });
        continue;
      }
      let candidate: OrganizationGenome;
      try {
        candidate = applyMutation(r.genome, p.mutation, { createdBy: p.id });
      } catch (err) {
        r.emit1({ type: 'MUTATION_REJECTED', actorId: 'controller', payload: { proposalId: p.id, reason: err instanceof MutationError ? `invalid: ${err.reasons.join('; ')}` : String(err) } });
        continue;
      }
      const skipValidation = random || ablations.includes('no-validation');
      let accepted = true;
      if (skipValidation) {
        r.emit1({ type: 'MUTATION_VALIDATED', actorId: 'controller', payload: { proposalId: p.id, method: 'skipped-ablation', incumbentScore: null, candidateScore: null, margin: c.delta, bufferTaskIds: [], accepted: true, shadowRunIds: [], cost: { tokens: 0, calls: 0, usd: 0 } } });
      } else {
        const buffer = this.buffer(history);
        const inc = await this.evaluate(r.genome, buffer, 'inc');
        const cand = await this.evaluate(candidate, buffer, 'cand');
        accepted = cand.fitness > inc.fitness + c.delta;
        r.emit1({
          type: 'MUTATION_VALIDATED',
          actorId: 'controller',
          payload: {
            proposalId: p.id,
            method: 'paired-reexecution',
            incumbentScore: inc.fitness,
            candidateScore: cand.fitness,
            margin: c.delta,
            bufferTaskIds: buffer.map((b) => (b.spec.kind === 'bench' ? b.spec.task.id : b.outcome.taskId)),
            accepted,
            shadowRunIds: [...inc.runIds, ...cand.runIds],
            cost: { tokens: inc.tokens + cand.tokens, calls: inc.calls + cand.calls, usd: inc.usd + cand.usd },
          },
        });
        if (!accepted) r.emit1({ type: 'MUTATION_REJECTED', actorId: 'controller', payload: { proposalId: p.id, reason: `candidate ${cand.fitness.toFixed(3)} ≤ incumbent ${inc.fitness.toFixed(3)} + δ ${c.delta}` } });
      }
      if (accepted) {
        const parent = r.genome;
        r.adoptGenome(candidate, { type: 'ORGANIZATION_MUTATED', actorId: 'controller', payload: { proposalId: p.id, fromGenomeId: parent.id, toGenomeId: candidate.id, generation: candidate.generation, mutation: p.mutation, genome: candidate } });
        const w = c.rollback.window;
        const recent = history.slice(-w);
        this.watch = { parent, acceptedAt: n, baseline: recent.length ? recent.filter((h) => h.outcome.success).length / recent.length : 0 };
        this.o.log?.(`gen ${candidate.generation}: ${p.mutation.type} accepted`);
        break; // one structural change per trigger keeps credit assignment clean
      }
    }
  }

  private async checkRollback(history: HistoryItem[]): Promise<void> {
    const c = this.o.config;
    if (!this.watch || !c.rollback.enabled || this.o.ablations.includes('no-rollback')) return;
    const since = history.length - this.watch.acceptedAt;
    if (since < c.rollback.window) return;
    const post = history.slice(this.watch.acceptedAt, this.watch.acceptedAt + c.rollback.window);
    const sr = post.filter((h) => h.outcome.success).length / post.length;
    const r = this.o.runner;
    if (this.watch.baseline - sr > c.rollback.dropThreshold) {
      const parent = this.watch.parent;
      r.adoptGenome(parent, { type: 'ORGANIZATION_ROLLED_BACK', actorId: 'controller', payload: { fromGenomeId: r.genome.id, toGenomeId: parent.id, reason: `success ${sr.toFixed(2)} vs ${this.watch.baseline.toFixed(2)} before the change (drop > ${c.rollback.dropThreshold})`, genome: parent } });
    }
    this.watch = null;
  }

  /** Replay buffer B: recent tasks + historical validation tasks (I-§45). Only bench tasks are re-executable. */
  private buffer(history: HistoryItem[]): HistoryItem[] {
    const bench = history.filter((h) => h.spec.kind === 'bench');
    const recent = bench.slice(-this.o.config.bufferRecent);
    const older = bench.slice(0, Math.max(0, bench.length - this.o.config.bufferRecent));
    const hist: HistoryItem[] = [];
    for (let i = 0; i < this.o.config.bufferHistorical && older.length; i++) hist.push(older.splice(this.rng.int(older.length), 1)[0]!);
    return [...recent, ...hist];
  }

  private async evaluate(genome: OrganizationGenome, buffer: HistoryItem[], tag: string): Promise<{ fitness: number; tokens: number; calls: number; usd: number; runIds: string[] }> {
    const parent = this.o.runner;
    const runId = `${parent.runId}-val${++this.shadowCount}-${tag}`;
    const cfg = buildRunConfig({ ...parent.config, runId, label: `validation shadow of ${parent.runId}`, genome, evolution: { ...parent.config.evolution, enabled: false } });
    createRun(parent.store, cfg);
    const shadow = new OrgRunner({ store: parent.store, provider: this.o.provider, runId, callCategory: 'validation', retry: parent.retry, sleep: parent.sleep });
    shadow.instantiate(genome, 'validation');
    shadow.start();
    let score = 0;
    let tokens = 0;
    for (const b of buffer) {
      const out = await shadow.runTask(b.spec);
      score += out.score;
      tokens += out.tokens;
    }
    shadow.complete({ purpose: 'validation', tasks: buffer.length });
    const s = shadow.state.costs.total;
    const n = Math.max(1, buffer.length);
    return { fitness: score / n - (this.o.config.fitnessCostPer1kTokens * tokens) / n / 1000, tokens: s.tokens, calls: s.calls, usd: s.usd, runIds: [runId] };
  }
}

export { validateGenome, capabilitiesOf };
