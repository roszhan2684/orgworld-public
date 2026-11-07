import { Mutation, type EvolutionConfig, type MutationProposal, type OrganizationGenome, type RoleDescriptor } from '@orgworld/protocol';
import { applyMutation, capabilitiesOf, isMutationAllowed, MutationError, newId, reachableFrom, Rng, ROLE_LIBRARY, roleVocabulary, truncate, validateGenome } from '@orgworld/core';
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
    // C-21 organization checks share one replay buffer per trigger and reuse identical re-executions; with both off,
    // every proposal draws its own buffer and re-runs the incumbent exactly as before.
    const shared = !!(c.contributionCheck || c.counterfactualReview);
    const sharedBuffer = shared ? this.buffer(history) : null;
    const cache = new Map<string, Evaluation>();
    const run = async (genome: OrganizationGenome, tasks: HistoryItem[], tag: string): Promise<Evaluation> => {
      if (!shared) return this.evaluate(genome, tasks, tag);
      const key = `${structure(genome)}|${tasks.map(taskIdOf).join(',')}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const e = await this.evaluate(genome, tasks, tag);
      cache.set(key, e);
      return e;
    };
    const charged = new Set<string>();
    const bill = (...evals: Evaluation[]) => {
      const fresh = evals.filter((e) => e.runIds.some((id) => !charged.has(id)));
      for (const e of fresh) for (const id of e.runIds) charged.add(id);
      return { runIds: fresh.flatMap((e) => e.runIds), cost: { tokens: sum(fresh, 'tokens'), calls: sum(fresh, 'calls'), usd: sum(fresh, 'usd') } };
    };
    const first: MutationProposal[] = [];
    if (c.contributionCheck) {
      const p = await this.contribution(d, sharedBuffer!, run, bill);
      if (p) first.push(p);
    }
    const base = random ? [randomProposal(r.genome, this.rng, this.vocab)] : c.proposer === 'llm' ? await this.llmProposals(d) : c.proposer === 'both' ? [...heuristicProposals(r.genome, d), ...(await this.llmProposals(d))] : heuristicProposals(r.genome, d);
    const seen = new Set<string>();
    const proposals = [...first, ...base].filter((p) => !seen.has(JSON.stringify(p.mutation)) && !!seen.add(JSON.stringify(p.mutation))).slice(0, c.maxProposalsPerTrigger);
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
        if (c.counterfactualReview) {
          // Would the alternative organization have done better on the tasks we just failed? The incumbent's side is
          // what actually happened (no re-run); the candidate replays those tasks in a shadow run.
          const failed = history.slice(-c.trigger.everyK).filter((h) => h.spec.kind === 'bench' && !h.outcome.success).slice(-3);
          if (failed.length) {
            const observed = fitnessOf(failed.map((h) => h.outcome), this.o.config.fitnessCostPer1kTokens);
            const alt = await run(candidate, failed, 'cf');
            const billed = bill(alt);
            const better = alt.fitness > observed;
            r.emit1({ type: 'COUNTERFACTUAL_EVALUATED', actorId: 'controller', payload: { proposalId: p.id, taskIds: failed.map(taskIdOf), incumbentScore: observed, alternativeScore: alt.fitness, better, shadowRunIds: billed.runIds, cost: billed.cost } });
            if (!better) {
              r.emit1({ type: 'MUTATION_REJECTED', actorId: 'controller', payload: { proposalId: p.id, reason: `counterfactual: no better on the ${failed.length} recently failed task(s) (${alt.fitness.toFixed(3)} vs ${observed.toFixed(3)} observed)` } });
              continue;
            }
          }
        }
        const buffer = sharedBuffer ?? this.buffer(history);
        const inc = await run(r.genome, buffer, 'inc');
        const cand = await run(candidate, buffer, 'cand');
        const billed = bill(inc, cand);
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
            shadowRunIds: billed.runIds,
            cost: billed.cost,
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

  private contributionRound = 0;

  /** Idea 25: replay the buffer without one agent (rotating) and record what it adds; a non-contributor becomes a proposal. */
  private async contribution(d: Diagnosis, buffer: HistoryItem[], run: (g: OrganizationGenome, t: HistoryItem[], tag: string) => Promise<Evaluation>, bill: (...e: Evaluation[]) => { runIds: string[]; cost: { tokens: number; calls: number; usd: number } }): Promise<MutationProposal | null> {
    const r = this.o.runner;
    const g = r.genome;
    const others = g.agents.map((a) => a.id).filter((id) => id !== g.entryAgentId).sort();
    if (!others.length || !buffer.length) return null;
    const agentId = others[this.contributionRound++ % others.length]!;
    let without: OrganizationGenome;
    try {
      without = applyMutation(g, { type: 'REMOVE_AGENT', agentId }, { createdBy: 'contribution-check' });
    } catch {
      return null; // removing it would break the organization's constraints
    }
    const inc = await run(g, buffer, 'inc');
    const out = await run(without, buffer, 'minus');
    const billed = bill(inc, out);
    const delta = inc.fitness - out.fitness;
    r.emit1({ type: 'CONTRIBUTION_MEASURED', actorId: 'controller', payload: { agentId, taskIds: buffer.map(taskIdOf), withScore: inc.fitness, withoutScore: out.fitness, delta, shadowRunIds: billed.runIds, cost: billed.cost } });
    if (delta > 0 || d.idleAgents.includes(agentId)) return null; // it helps, or the idle-agent rule already covers it
    return propose({ type: 'REMOVE_AGENT', agentId }, { contributionDelta: delta, withScore: inc.fitness, withoutScore: out.fitness, tasks: buffer.length }, `Without ${agentId} the organization scored ${out.fitness.toFixed(3)} vs ${inc.fitness.toFixed(3)} on ${buffer.length} replayed tasks: it does not contribute.`, 'heuristic', { costDelta: -0.1 });
  }

  /** Idea 26: the organization proposes its own structural change from the evidence (labelled proposer "llm"). */
  private async llmProposals(d: Diagnosis): Promise<MutationProposal[]> {
    const r = this.o.runner;
    const g = r.genome;
    const vocab = this.vocab ?? roleVocabulary(g);
    const lessons = r.memory
      .all()
      .filter((m) => (m.tags ?? []).includes('lesson'))
      .slice(-3)
      .map((m) => `- ${truncate(m.content, 200)}`);
    const system = 'You redesign an AI software organization. Propose at most ONE structural change that the evidence supports, or NONE. Every change is replayed on past tasks and adopted only if it scores better than the current organization.';
    const prompt = [
      `Organization (generation ${g.generation}); entry agent ${g.entryAgentId}.`,
      `Agents: ${g.agents.map((a) => `${a.id} (${a.roleId})`).join(', ')}`,
      `Edges: ${g.edges.map((e) => `${e.from}->${e.to}`).join(', ') || 'none'}`,
      `Roles you may use: ${vocab.map((v) => v.id).join(', ')}`,
      `Evidence from the last ${d.window} tasks: success ${(d.successRate * 100).toFixed(0)}%; failures by category ${JSON.stringify(d.failuresByCategory)} of ${JSON.stringify(d.tasksByCategory)}; idle agents: ${d.idleAgents.join(', ') || 'none'}; unused edges: ${d.unusedEdges.slice(0, 5).join(', ') || 'none'}; mean tokens per task ${Math.round(d.meanTokens)}.`,
      ...(lessons.length ? ['Lessons the organization has recorded:', ...lessons] : []),
      'Fill every field; use "" for fields the change does not need. ADD_AGENT needs roleId; REMOVE_AGENT needs agentId; CHANGE_ROLE needs agentId and roleId; ADD_EDGE and REMOVE_EDGE need from and to.',
      'Reply JSON {"type": "ADD_AGENT|REMOVE_AGENT|CHANGE_ROLE|ADD_EDGE|REMOVE_EDGE|NONE", "agentId": "...", "roleId": "...", "from": "...", "to": "...", "hypothesis": "what will improve and why, citing the evidence"}.',
    ].join('\n');
    const j = (await r.controllerCall('llm proposer', system, prompt, LLM_PROPOSAL_SCHEMA)) as Record<string, unknown> | null;
    if (!j || j.type === 'NONE') return [];
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string).trim() : '');
    // A small model often names the role only in its hypothesis: use it when exactly one known role is mentioned.
    const mentioned = vocab.filter((v) => new RegExp(`\\b(${v.id.replace(/_/g, '[ _]')}|${v.name.replace(/[^A-Za-z ]/g, '')})\\b`, 'i').test(`${str('roleId')} ${str('hypothesis')}`));
    // "Security Reviewer" also contains "Reviewer": keep only the most specific roles mentioned.
    const specific = mentioned.filter((v) => !mentioned.some((o) => o !== v && (o.name.toLowerCase().includes(v.name.toLowerCase()) || o.id.includes(v.id))));
    const role = vocab.find((v) => v.id === str('roleId')) ?? (specific.length === 1 ? specific[0] : undefined);
    const inferred = !!role && role.id !== str('roleId');
    const raw =
      j.type === 'ADD_AGENT' && role
        ? { type: 'ADD_AGENT', agent: { id: `${role.id}_g${g.generation + 1}`, name: role.name, roleId: role.id }, role }
        : j.type === 'REMOVE_AGENT'
          ? { type: 'REMOVE_AGENT', agentId: str('agentId') }
          : j.type === 'CHANGE_ROLE' && role
            ? { type: 'CHANGE_ROLE', agentId: str('agentId'), role }
            : j.type === 'ADD_EDGE'
              ? { type: 'ADD_EDGE', edge: { from: str('from'), to: str('to'), kind: 'delegate' } }
              : j.type === 'REMOVE_EDGE'
                ? { type: 'REMOVE_EDGE', from: str('from'), to: str('to') }
                : null;
    const m = raw ? Mutation.safeParse(raw) : null;
    if (!m?.success) {
      r.emit1({ type: 'ANOMALY_DETECTED', actorId: 'controller', payload: { kind: 'llm-proposal-unusable', detail: truncate(JSON.stringify(j), 400) } });
      return [];
    }
    const hypothesis = truncate(str('hypothesis') || 'no hypothesis given', 400);
    const worst = Object.entries(d.failuresByCategory).sort((a, b) => b[1] - a[1])[0];
    return [propose(m.data, { window: d.window, successRate: d.successRate, ...(worst ? { worstCategory: worst[0], failuresInWindow: worst[1] } : {}), idleAgents: d.idleAgents.join(','), ...(inferred ? { roleReadFromHypothesis: true } : {}) }, hypothesis, 'llm')];
  }

  private async evaluate(genome: OrganizationGenome, buffer: HistoryItem[], tag: string): Promise<Evaluation> {
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

interface Evaluation {
  fitness: number;
  tokens: number;
  calls: number;
  usd: number;
  runIds: string[];
}

const taskIdOf = (h: HistoryItem) => (h.spec.kind === 'bench' ? h.spec.task.id : h.outcome.taskId);
const sum = (es: Evaluation[], k: 'tokens' | 'calls' | 'usd') => es.reduce((a, e) => a + e[k], 0);
/** Same fitness F as shadow validation, from observed outcomes. */
const fitnessOf = (outs: Array<{ score: number; tokens: number }>, costPer1k: number) => (outs.length ? outs.reduce((a, o) => a + o.score, 0) / outs.length - (costPer1k * outs.reduce((a, o) => a + o.tokens, 0)) / outs.length / 1000 : 0);
/** Identity of an organization's structure, ignoring ids and lineage. */
const structure = (g: OrganizationGenome) => JSON.stringify([g.entryAgentId, g.agents.map((a) => [a.id, a.roleId]).sort(), g.edges.map((e) => [e.from, e.to, e.kind]).sort(), g.roles.map((x) => x.id).sort(), g.policies]);

const LLM_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['ADD_AGENT', 'REMOVE_AGENT', 'CHANGE_ROLE', 'ADD_EDGE', 'REMOVE_EDGE', 'NONE'] },
    agentId: { type: 'string' },
    roleId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    hypothesis: { type: 'string' },
  },
  required: ['type', 'agentId', 'roleId', 'from', 'to', 'hypothesis'],
};

export { validateGenome, capabilitiesOf };
