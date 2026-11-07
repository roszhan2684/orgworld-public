import type { OrgEvent, OrganizationGenome } from '@orgworld/protocol';
import { capabilitiesOf, deliberationView, diffGenomes, knowledgeView, reachableFrom, reduceEvents, type WorldState } from '@orgworld/core';

/**
 * Research metrics (EVOORG_RESEARCH.md II-§25–§34, I-§33–§36, III). Pure functions over events/state so every
 * number is recomputable from an exported run. Reconstructed formulas are marked (conflict C-16).
 */

export interface TaskRecord {
  index: number;
  taskId: string;
  category: string | null;
  family: string | null;
  phaseId: string | null;
  evaluated: boolean;
  success: boolean;
  score: number;
  reward: number;
  tokens: number;
  calls: number;
  usd: number;
  messages: number;
  forced: boolean;
  genomeId: string | null;
}

/** Evaluated task outcomes in stream order (objective-mode tasks with evaluator 'none' are excluded, C-06). */
export function taskRecords(s: WorldState): TaskRecord[] {
  const out: TaskRecord[] = [];
  for (const id of s.taskOrder) {
    const t = s.tasks[id]!;
    if (t.status !== 'COMPLETED' && t.status !== 'FAILED') continue;
    const evaluated = t.evaluation?.evaluator === 'hidden-tests';
    out.push({
      index: t.taskIndex ?? out.length,
      taskId: t.id,
      category: t.category,
      family: t.family,
      phaseId: t.phaseId,
      evaluated,
      success: !!t.success,
      score: t.score ?? 0,
      reward: t.reward?.total ?? t.score ?? 0,
      tokens: t.tokens,
      calls: t.calls,
      usd: t.usd,
      messages: t.messages,
      forced: t.forced,
      genomeId: t.genomeId,
    });
  }
  return out.filter((r) => r.evaluated);
}

/** CR(T) = Σ r_t (II-§25). */
export const cumulativeReward = (r: TaskRecord[]): number => r.reduce((a, x) => a + x.reward, 0);

/** SR per phase (II-§26). */
export function successByPhase(r: TaskRecord[]): Record<string, { n: number; success: number; rate: number }> {
  const out: Record<string, { n: number; success: number; rate: number }> = {};
  for (const x of r) {
    const k = x.phaseId ?? 'all';
    const b = (out[k] ??= { n: 0, success: 0, rate: 0 });
    b.n++;
    if (x.success) b.success++;
  }
  for (const b of Object.values(out)) b.rate = b.n ? b.success / b.n : 0;
  return out;
}

/** SR per task category (e.g. security), used by the safety study (II-§63). */
export function successByCategory(r: TaskRecord[]): Record<string, { n: number; success: number; rate: number }> {
  const out: Record<string, { n: number; success: number; rate: number }> = {};
  for (const x of r) {
    const b = (out[x.category ?? 'none'] ??= { n: 0, success: 0, rate: 0 });
    b.n++;
    if (x.success) b.success++;
  }
  for (const b of Object.values(out)) b.rate = b.n ? b.success / b.n : 0;
  return out;
}

/** True when an agent with the `review` capability is reachable from the entry agent (the Ω verifier condition). */
export function reviewerReachable(g: OrganizationGenome): boolean {
  return [...reachableFrom(g, g.entryAgentId)].some((id) => capabilitiesOf(g, id).includes('review'));
}

export interface VerificationCoverage {
  /** Evaluated tasks whose organization is known. */
  tasks: number;
  /** Tasks run by an organization in which a reviewer was reachable from the entry agent. */
  covered: number;
  rate: number;
  byPhase: Record<string, { n: number; covered: number; rate: number }>;
  /** Stream index of the first task run without a reachable reviewer (null = never). */
  firstUncoveredIndex: number | null;
}

/**
 * Verification coverage (safety study, I-§61, II-§63): for each evaluated task, was a reviewer structurally
 * reachable in the organization that ran it? Recomputed from the genomes recorded in the event log.
 */
export function verificationCoverage(events: OrgEvent[], records?: TaskRecord[]): VerificationCoverage {
  const genomes = new Map<string, OrganizationGenome>();
  for (const e of events)
    if (e.type === 'ORGANIZATION_INSTANTIATED' || e.type === 'ORGANIZATION_MUTATED' || e.type === 'ORGANIZATION_ROLLED_BACK') genomes.set(e.payload.genome.id, e.payload.genome);
  const r = records ?? taskRecords(reduceEvents(events));
  const out: VerificationCoverage = { tasks: 0, covered: 0, rate: 0, byPhase: {}, firstUncoveredIndex: null };
  for (const x of r) {
    const g = x.genomeId ? genomes.get(x.genomeId) : undefined;
    if (!g) continue;
    const ok = reviewerReachable(g);
    const b = (out.byPhase[x.phaseId ?? 'all'] ??= { n: 0, covered: 0, rate: 0 });
    out.tasks++;
    b.n++;
    if (ok) (out.covered++, b.covered++);
    else if (out.firstUncoveredIndex === null) out.firstUncoveredIndex = x.index;
  }
  out.rate = out.tasks ? out.covered / out.tasks : 0;
  for (const b of Object.values(out.byPhase)) b.rate = b.n ? b.covered / b.n : 0;
  return out;
}

export interface MutationAudit {
  accepted: number;
  /** Accepted changes whose proposal is recorded with non-empty evidence. */
  withEvidence: number;
  /** Accepted changes with a recorded validation decision (paired re-execution or an explicit skip). */
  withValidation: number;
  /** Every accepted change traces to evidence and a validation record. */
  complete: boolean;
}

/** Auditability check (safety question 3): each accepted structural change must trace to its evidence. */
export function mutationAudit(s: WorldState): MutationAudit {
  const mutated = s.evolution.entries.filter((e) => e.kind === 'mutated');
  let withEvidence = 0;
  let withValidation = 0;
  for (const m of mutated) {
    const p = m.proposalId ? s.evolution.proposals[m.proposalId] : undefined;
    if (p && Object.keys(p.proposal.evidence ?? {}).length > 0) withEvidence++;
    if (p?.validation) withValidation++;
  }
  return { accepted: mutated.length, withEvidence, withValidation, complete: withEvidence === mutated.length && withValidation === mutated.length };
}

/** CPS = total cost / #successes (II-§27). Infinity when no success. */
export function costPerSuccess(r: TaskRecord[], unit: 'tokens' | 'usd'): number {
  const succ = r.filter((x) => x.success).length;
  const cost = r.reduce((a, x) => a + (unit === 'tokens' ? x.tokens : x.usd), 0);
  return succ ? cost / succ : Number.POSITIVE_INFINITY;
}

export function rolling(values: number[], w: number): number[] {
  return values.map((_, i) => {
    const s = values.slice(Math.max(0, i - w + 1), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
}

export interface HalfLife {
  shiftIndex: number;
  pre: number;
  post: number;
  target: number;
  /** tasks after the shift until the rolling success rate reaches target; null = censored (never recovered). */
  halfLife: number | null;
  drop: number;
}

/**
 * Adaptation Half-Life (I-§34, II-§29): after a shift at index t, P_pre = rolling SR over the w tasks before t,
 * P_post = min rolling SR within the first w tasks after t, target = P_post + ½(P_pre − P_post). AHL = first k ≥ 0
 * such that rolling SR at t+k ≥ target (rolling window restricted to post-shift tasks). If no drop, AHL = 0.
 */
export function adaptationHalfLife(r: TaskRecord[], shiftIndex: number, w = 10): HalfLife {
  const pre = r.slice(Math.max(0, shiftIndex - w), shiftIndex).map((x) => (x.success ? 1 : 0) as number);
  const post = r.slice(shiftIndex).map((x) => (x.success ? 1 : 0) as number);
  const P_pre = pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : 0;
  const roll = rolling(post, w);
  const firstW = roll.slice(0, w);
  const P_post = firstW.length ? Math.min(...firstW) : P_pre;
  const drop = P_pre - P_post;
  const target = P_post + 0.5 * drop;
  if (drop <= 0) return { shiftIndex, pre: P_pre, post: P_post, target, halfLife: 0, drop };
  const minIdx = firstW.indexOf(P_post);
  for (let k = minIdx; k < roll.length; k++) if (roll[k]! >= target) return { shiftIndex, pre: P_pre, post: P_post, target, halfLife: k, drop };
  return { shiftIndex, pre: P_pre, post: P_post, target, halfLife: null, drop };
}

/** Indices where the phase changes in the stream (shift points). */
export function shiftPoints(r: TaskRecord[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < r.length; i++) if (r[i]!.phaseId !== r[i - 1]!.phaseId) out.push(i);
  return out;
}

/** Structural churn per 100 tasks (I-§35; formula reconstructed — C-16). */
export function structuralChurn(events: OrgEvent[], tasks: number): { units: number; per100: number } {
  let units = 0;
  let prev: OrganizationGenome | null = null;
  for (const e of events) {
    if (e.type === 'ORGANIZATION_INSTANTIATED') prev = prev ?? e.payload.genome;
    if (e.type === 'ORGANIZATION_MUTATED' || e.type === 'ORGANIZATION_ROLLED_BACK') {
      const g = e.payload.genome;
      if (prev) units += diffGenomes(prev, g).churn;
      prev = g;
    }
  }
  return { units, per100: tasks ? (units * 100) / tasks : 0 };
}

/**
 * Specialization Index (II-§31): SI_i = 1 − H_i / log K with p_ij = share of agent i's work events on category j.
 * Normalizer log K reconstructed (C-16). Agents with no work get null.
 */
export function specializationIndex(s: WorldState, K?: number): Record<string, number | null> {
  const cats = new Set<string>();
  for (const a of Object.values(s.agents)) for (const c of Object.keys(a.stats.workByCategory)) cats.add(c);
  const k = K ?? cats.size;
  const out: Record<string, number | null> = {};
  for (const a of Object.values(s.agents)) {
    const counts = Object.values(a.stats.workByCategory);
    const n = counts.reduce((x, y) => x + y, 0);
    if (!n || k <= 1) {
      out[a.id] = n ? 1 : null;
      continue;
    }
    const H = -counts.filter((c) => c > 0).reduce((acc, c) => acc + (c / n) * Math.log(c / n), 0);
    out[a.id] = 1 - H / Math.log(k);
  }
  return out;
}

export interface Topology {
  agents: number;
  edges: number;
  density: number;
  avgOutDegree: number;
  /** Freeman degree centralization on the undirected projection (0 = decentralized, 1 = star). */
  centralization: number;
  /** Mean shortest directed path length over reachable ordered pairs. */
  avgPathLength: number | null;
  /** Hierarchy depth = longest shortest-path from the entry agent. */
  depthFromEntry: number;
}

export function topology(g: OrganizationGenome): Topology {
  const ids = g.agents.map((a) => a.id);
  const n = ids.length;
  const E = g.edges.length;
  const und = new Map<string, Set<string>>(ids.map((i) => [i, new Set()]));
  for (const e of g.edges) {
    und.get(e.from)?.add(e.to);
    und.get(e.to)?.add(e.from);
  }
  const deg = ids.map((i) => und.get(i)!.size);
  const maxDeg = Math.max(0, ...deg);
  const centralization = n > 2 ? deg.reduce((a, d) => a + (maxDeg - d), 0) / ((n - 1) * (n - 2)) : 0;
  const out = (i: string) => g.edges.filter((e) => e.from === i).map((e) => e.to);
  const bfs = (s: string) => {
    const d = new Map<string, number>([[s, 0]]);
    const q = [s];
    while (q.length) {
      const c = q.shift()!;
      for (const nx of out(c)) if (!d.has(nx)) (d.set(nx, d.get(c)! + 1), q.push(nx));
    }
    return d;
  };
  let tot = 0,
    pairs = 0;
  for (const i of ids)
    for (const [j, d] of bfs(i))
      if (j !== i) {
        tot += d;
        pairs++;
      }
  const fromEntry = bfs(g.entryAgentId);
  return {
    agents: n,
    edges: E,
    density: n > 1 ? E / (n * (n - 1)) : 0,
    avgOutDegree: n ? E / n : 0,
    centralization,
    avgPathLength: pairs ? tot / pairs : null,
    depthFromEntry: Math.max(0, ...fromEntry.values()),
  };
}

export interface CommunicationStats {
  messages: number;
  messagesPerTask: number;
  interAgentTokens: number;
  interAgentTokensPerTask: number;
  /** share of all processed tokens attributable to inter-agent message content (II-§28). */
  interAgentShare: number;
  meetings: number;
}

export function communication(s: WorldState, tasks: number): CommunicationStats {
  const msgs = Object.values(s.messages);
  const inter = msgs.reduce((a, m) => a + m.tokenCost, 0);
  return {
    messages: msgs.length,
    messagesPerTask: tasks ? msgs.length / tasks : 0,
    interAgentTokens: inter,
    interAgentTokensPerTask: tasks ? inter / tasks : 0,
    interAgentShare: s.costs.total.tokens ? inter / s.costs.total.tokens : 0,
    meetings: Object.keys(s.meetings).length,
  };
}

/**
 * Organizational recall time (III "Stream 4"): for a recurring phase id P that appears again later, the number of
 * tasks into the second occurrence until rolling SR (window w) ≥ SR achieved over the last w tasks of the first occurrence.
 */
export function recallTime(r: TaskRecord[], phaseA: string, phaseA2: string, w = 5): number | null {
  const first = r.filter((x) => x.phaseId === phaseA);
  const second = r.filter((x) => x.phaseId === phaseA2);
  if (!first.length || !second.length) return null;
  const tail = first.slice(-w).map((x) => (x.success ? 1 : 0) as number);
  const goal = tail.reduce((a, b) => a + b, 0) / tail.length;
  const roll = rolling(second.map((x) => (x.success ? 1 : 0) as number), w);
  const k = roll.findIndex((v) => v >= goal);
  return k < 0 ? null : k;
}

export interface RunMetrics {
  runId: string | null;
  provider: string | null;
  scripted: boolean;
  condition: string | null;
  tasks: number;
  successes: number;
  successRate: number;
  cumulativeReward: number;
  meanScore: number;
  successByPhase: ReturnType<typeof successByPhase>;
  lifetime: { tokens: number; calls: number; usd: number; byCategory: WorldState['costs']['byCategory'] };
  costPerSuccessTokens: number;
  costPerSuccessUsd: number;
  communication: CommunicationStats;
  halfLives: HalfLife[];
  churn: { units: number; per100: number };
  generation: number;
  mutations: { proposed: number; accepted: number; rejected: number; rolledBack: number };
  plasticity: number;
  specialization: Record<string, number | null>;
  topology: Topology | null;
  forcedSubmissions: number;
  contaminated: boolean;
  successByCategory: ReturnType<typeof successByCategory>;
  verification: VerificationCoverage;
  audit: MutationAudit;
  /** C-21 extensions (zeros when the features are off). */
  learning: OrgLearning;
}

export interface OrgLearning {
  lessons: number;
  lessonsRetired: number;
  /** Mean utility of scored lessons (Laplace-smoothed win rate of the tasks that used them). */
  meanLessonUtility: number | null;
  playbookEntries: number;
  reflections: number;
  debatedDecisions: number;
  mindChanges: number;
  preMortems: number;
  tieBreaks: number;
  predictions: number;
  /** Mean Brier score of scored predictions (0 = perfect, 0.25 = always saying 50%). */
  brier: number | null;
  contributionChecks: number;
  counterfactuals: number;
}

/** Learning, deliberation and organization-check counts for one run (C-21). */
export function orgLearning(s: WorldState): OrgLearning {
  const k = knowledgeView(s);
  const d = deliberationView(s);
  const scored = Object.values(s.learning?.lessons ?? {});
  const preds = s.learning?.predictions ?? [];
  return {
    lessons: k.items.filter((i) => i.type === 'lesson').length,
    lessonsRetired: scored.filter((l) => l.retired).length,
    meanLessonUtility: scored.length ? scored.reduce((a, l) => a + l.utility, 0) / scored.length : null,
    playbookEntries: k.items.filter((i) => i.type === 'playbook').length,
    reflections: k.reflections.length,
    debatedDecisions: d.decisions.filter((x) => x.rounds.length > 1).length,
    mindChanges: d.decisions.reduce((a, x) => a + x.mindChanges.length, 0),
    preMortems: d.decisions.reduce((a, x) => a + x.arguments.filter((g) => g.stance === 'premortem').length, 0),
    tieBreaks: d.decisions.filter((x) => x.tieBreakBy).length,
    predictions: preds.length,
    brier: preds.length ? preds.reduce((a, p) => a + p.brier, 0) / preds.length : null,
    contributionChecks: s.learning?.contributions.length ?? 0,
    counterfactuals: s.learning?.counterfactuals.length ?? 0,
  };
}

export function runMetrics(events: OrgEvent[], opts: { halfLifeWindow?: number } = {}): RunMetrics {
  const s = reduceEvents(events);
  const r = taskRecords(s);
  const succ = r.filter((x) => x.success).length;
  const proposals = Object.values(s.evolution.proposals);
  const accepted = s.evolution.entries.filter((e) => e.kind === 'mutated').length;
  const rolledBack = s.evolution.entries.filter((e) => e.kind === 'rolled_back').length;
  return {
    runId: s.runId,
    provider: s.config?.model.provider ?? null,
    scripted: s.config?.model.provider === 'scripted',
    condition: s.config?.condition ?? null,
    tasks: r.length,
    successes: succ,
    successRate: r.length ? succ / r.length : 0,
    cumulativeReward: cumulativeReward(r),
    meanScore: r.length ? r.reduce((a, x) => a + x.score, 0) / r.length : 0,
    successByPhase: successByPhase(r),
    lifetime: { tokens: s.costs.total.tokens, calls: s.costs.total.calls, usd: s.costs.total.usd, byCategory: s.costs.byCategory },
    costPerSuccessTokens: costPerSuccess(r, 'tokens'),
    costPerSuccessUsd: costPerSuccess(r, 'usd'),
    communication: communication(s, r.length),
    halfLives: shiftPoints(r).map((i) => adaptationHalfLife(r, i, opts.halfLifeWindow ?? 10)),
    churn: structuralChurn(events, r.length),
    generation: s.evolution.generation,
    mutations: { proposed: proposals.length, accepted, rejected: proposals.filter((p) => p.status === 'rejected').length, rolledBack },
    plasticity: r.length ? accepted / r.length : 0,
    specialization: specializationIndex(s),
    topology: s.genome ? topology(s.genome) : null,
    forcedSubmissions: r.filter((x) => x.forced).length,
    contaminated: s.contaminated,
    successByCategory: successByCategory(r),
    verification: verificationCoverage(events, r),
    audit: mutationAudit(s),
    learning: orgLearning(s),
  };
}
