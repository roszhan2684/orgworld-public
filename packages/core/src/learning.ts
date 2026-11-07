import type { WorldState } from './state.ts';

/**
 * Pure derivations for the organization-behaviour extensions (conflict C-21): who has done well at what, how well
 * agents predict, and the view models behind the deliberation and knowledge views. Everything comes from reduced
 * events; nothing here changes state.
 */

export interface CategoryRecord {
  worked: number;
  passed: number;
}

/** Per agent and task category: finished tasks the agent worked on (wrote an artifact or sent a message) and how many passed. */
export function expertise(s: WorldState): Record<string, Record<string, CategoryRecord>> {
  const workers: Record<string, Set<string>> = {};
  for (const id of s.artifactOrder) {
    const a = s.artifacts[id]!;
    if (a.taskId) (workers[a.taskId] ??= new Set()).add(a.authorId);
  }
  for (const id of s.messageOrder) {
    const m = s.messages[id]!;
    if (m.taskId) (workers[m.taskId] ??= new Set()).add(m.from);
  }
  const out: Record<string, Record<string, CategoryRecord>> = {};
  for (const tid of s.taskOrder) {
    const t = s.tasks[tid]!;
    if (t.success === null || !t.category) continue;
    for (const agentId of workers[tid] ?? []) {
      const r = ((out[agentId] ??= {})[t.category] ??= { worked: 0, passed: 0 });
      r.worked += 1;
      if (t.success) r.passed += 1;
    }
  }
  return out;
}

/** Brier-based track record: score = 1 − mean Brier over the agent's scored predictions (null when it has none). */
export function calibration(s: WorldState, agentId: string): { n: number; brier: number | null; score: number | null } {
  const ps = (s.learning?.predictions ?? []).filter((p) => p.agentId === agentId);
  if (!ps.length) return { n: 0, brier: null, score: null };
  const brier = ps.reduce((a, p) => a + p.brier, 0) / ps.length;
  return { n: ps.length, brier, score: 1 - brier };
}

export interface DeliberationVote {
  agentId: string;
  option: string;
  rationale: string;
  weight: number;
  confidence: number | null;
  previousOption: string | null;
  blind: boolean;
}

export interface DeliberationDecision {
  decisionId: string;
  taskId: string | null;
  question: string;
  options: string[];
  proposerId: string;
  recommendation: string;
  policy: string;
  rounds: Array<{ round: number; votes: DeliberationVote[] }>;
  arguments: Array<{ agentId: string; round: number; stance: 'against' | 'rebuttal' | 'premortem'; option: string; content: string; evidence: string[]; evidenceValid: boolean }>;
  /** Agents whose final vote differs from their first. */
  mindChanges: Array<{ agentId: string; from: string; to: string }>;
  chosen: string | null;
  confidence: number | null;
  predictedSuccess: number | null;
  minorityReport: string | null;
  tieBreakBy: string | null;
  taskSuccess: boolean | null;
}

export interface DeliberationView {
  decisions: DeliberationDecision[];
  trackRecords: Array<{ agentId: string; predictions: number; brier: number | null; score: number | null }>;
}

/** View model for the debate and decision view (idea 28). */
export function deliberationView(s: WorldState): DeliberationView {
  const args = s.learning?.arguments ?? [];
  const reviews = new Map((s.learning?.decisionReviews ?? []).map((r) => [r.decisionId, r]));
  const decisions = s.decisionOrder.map((id): DeliberationDecision => {
    const d = s.decisions[id]!;
    const rounds = new Map<number, DeliberationVote[]>();
    for (const v of d.votes) {
      const r = v.round ?? 1;
      if (!rounds.has(r)) rounds.set(r, []);
      rounds.get(r)!.push({ agentId: v.agentId, option: v.option, rationale: v.rationale, weight: v.weight, confidence: v.confidence ?? null, previousOption: v.previousOption ?? null, blind: v.blind ?? false });
    }
    const first = new Map<string, string>();
    const last = new Map<string, string>();
    for (const v of d.votes) {
      if (!first.has(v.agentId)) first.set(v.agentId, v.option);
      last.set(v.agentId, v.option);
    }
    const out = d.outcome as (typeof d.outcome & { predictedSuccess?: number; minorityReport?: string; tieBreakBy?: string }) | null;
    return {
      decisionId: id,
      taskId: d.taskId,
      question: d.question,
      options: d.options,
      proposerId: d.proposerId,
      recommendation: d.recommendation,
      policy: d.policy,
      rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, votes]) => ({ round, votes })),
      arguments: args.filter((a) => a.decisionId === id).map(({ agentId, round, stance, option, content, evidence, evidenceValid }) => ({ agentId, round, stance, option, content, evidence, evidenceValid })),
      mindChanges: [...first.entries()].filter(([a, o]) => last.get(a) !== o).map(([agentId, from]) => ({ agentId, from, to: last.get(agentId)! })),
      chosen: out?.chosen ?? null,
      confidence: out?.confidence ?? null,
      predictedSuccess: out?.predictedSuccess ?? null,
      minorityReport: out?.minorityReport ?? null,
      tieBreakBy: out?.tieBreakBy ?? null,
      taskSuccess: reviews.get(id)?.taskSuccess ?? (d.taskId ? (s.tasks[d.taskId]?.success ?? null) : null),
    };
  });
  const agents = [...new Set((s.learning?.predictions ?? []).map((p) => p.agentId))].sort();
  return { decisions, trackRecords: agents.map((agentId) => ({ agentId, ...(({ n, brier, score }) => ({ predictions: n, brier, score }))(calibration(s, agentId)) })) };
}

export interface KnowledgeItem {
  memoryId: string;
  kind: string;
  content: string;
  category: string | null;
  /** lesson | playbook | decision | other */
  type: string;
  taskId: string | null;
  seq: number;
  uses: number;
  wins: number;
  utility: number | null;
  retired: boolean;
  retrievals: number;
}

export interface KnowledgeView {
  items: KnowledgeItem[];
  reflections: Array<{ taskId: string; agentId: string; success: boolean; category: string | null; whys: string[]; lesson: string; seq: number }>;
  expertise: Record<string, Record<string, CategoryRecord>>;
  /** Cumulative count of knowledge items (not retired) after each one is written: the growth curve. */
  growth: Array<{ seq: number; items: number }>;
  contributions: Array<{ agentId: string; delta: number; withScore: number; withoutScore: number; seq: number }>;
}

/** View model for the knowledge view (idea 29). */
export function knowledgeView(s: WorldState): KnowledgeView {
  const lessons = s.learning?.lessons ?? {};
  const items = Object.values(s.memory)
    .sort((a, b) => a.seq - b.seq)
    .map((m): KnowledgeItem => {
      const tags = (m as { tags?: string[] }).tags ?? [];
      const ev = lessons[m.memoryId];
      return {
        memoryId: m.memoryId,
        kind: m.kind,
        content: m.content,
        category: tags.find((t) => t.startsWith('category:'))?.slice(9) ?? null,
        type: tags.includes('playbook') ? 'playbook' : tags.includes('lesson') ? 'lesson' : tags.includes('decision') ? 'decision' : 'other',
        taskId: m.provenance.taskId ?? null,
        seq: m.seq,
        uses: ev?.uses ?? 0,
        wins: ev?.wins ?? 0,
        utility: ev?.utility ?? null,
        retired: ev?.retired ?? false,
        retrievals: m.retrievals,
      };
    });
  let n = 0;
  return {
    items,
    reflections: (s.learning?.reflections ?? []).map(({ taskId, agentId, success, category, whys, lesson, seq }) => ({ taskId, agentId, success, category, whys, lesson, seq })),
    expertise: expertise(s),
    growth: items.map((it) => ({ seq: it.seq, items: (n += 1) })),
    contributions: (s.learning?.contributions ?? []).map(({ agentId, delta, withScore, withoutScore, seq }) => ({ agentId, delta, withScore, withoutScore, seq })),
  };
}
