import type { RunConfig } from '@orgworld/protocol';
import { calibration, capabilitiesOf, newId, truncate } from '@orgworld/core';
import type { Action } from './actions.ts';
import { IMPLEMENTED_POLICIES, resolveDecision, type Ballot } from './decisions.ts';
import { InfrastructureError } from './errors.ts';
import type { MemoryItem } from './memory.ts';
import { systemPrompt, taskBrief } from './prompts.ts';
import type { OrgRunner, TaskCtx } from './runner.ts';
import type { TaskOutcome } from './tasks.ts';

/*
 * Organization-behaviour extensions (conflict C-21), each behind a feature flag that is off by default:
 *   learning loop  — afterActionReview (12), playbook (13), lessonScoring (14), decisionJournal (15)
 *   deliberation   — debate (16), evidenceRule (17), blindVote (18), tieBreak (19), preMortem (20)
 *   prediction     — multiPath (21), trackRecord (22); expertiseDirectory (23) lives in prompts.ts
 * Every model call here is a real call by a named agent, charged to the task budget, and every result is an event.
 * Token rules: calls happen only where they can change something (a debate only on disagreement, a review only after
 * a failure or a category's first success), outputs are capped, and hidden-test details never reach a prompt.
 */

const words = (x: string) => new Set(x.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
/** Near-duplicate lesson: word Jaccard ≥ 0.6, comparing the lesson text without its stored label. */
function similar(stored: string, b: string): boolean {
  const A = words(stored.replace(/^Lesson \([^)]*\): /, ''));
  const B = words(b);
  const inter = [...B].filter((w) => A.has(w)).length;
  return B.size > 0 && inter / new Set([...A, ...B]).size >= 0.6;
}
const clamp01 = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5);
const tagsOf = (m: MemoryItem): string[] => m.tags ?? [];
type Json = Record<string, unknown>;

export function usesDeliberation(cfg: RunConfig): boolean {
  const f = cfg.features;
  return !!(f.debate || f.evidenceRule || f.blindVote || f.tieBreak || f.preMortem || f.trackRecord || f.decisionJournal);
}

const VOTE_SCHEMA = {
  type: 'object',
  properties: { option: { type: 'string' }, rationale: { type: 'string' }, confidence: { type: 'number' }, evidence: { type: 'array', items: { type: 'string' } } },
  required: ['option', 'rationale'],
  additionalProperties: false,
};
const ARGUMENT_SCHEMA = {
  type: 'object',
  properties: { content: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } },
  required: ['content'],
  additionalProperties: false,
};
const REVIEW_SCHEMA = {
  type: 'object',
  properties: { whys: { type: 'array', items: { type: 'string' } }, lesson: { type: 'string' }, approach: { type: 'string' } },
  required: ['whys', 'lesson'],
  additionalProperties: false,
};
const PLANS_SCHEMA = {
  type: 'object',
  properties: { plans: { type: 'array', items: { type: 'object', properties: { summary: { type: 'string' }, predictedSuccess: { type: 'number' } }, required: ['summary', 'predictedSuccess'] } } },
  required: ['plans'],
  additionalProperties: false,
};

/**
 * One model call by an organization mechanism, charged to the task budget. Returns 'refused' when the budget is
 * spent, null on an agent-level failure (recorded), and rethrows model-service failures so the run stops (C-19).
 */
async function ask(r: OrgRunner, agentId: string, ctx: TaskCtx, purpose: string, prompt: string, schema: object, maxOutputTokens: number): Promise<Json | null | 'refused'> {
  const system = systemPrompt(r.state, r.config, agentId, ['wait']);
  try {
    const res = await r.think(agentId, ctx.taskId, ctx.ledger, purpose, system, prompt, schema as Record<string, unknown>, null, undefined, { maxOutputTokens });
    if ('refused' in res) return 'refused';
    const j = res.result.json;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Json) : null;
  } catch (err) {
    if (err instanceof InfrastructureError) throw err;
    r.emit1({ type: 'AGENT_FAILED', actorId: 'runtime', payload: { agentId, error: truncate(String(err), 300), recovery: 'continue' } });
    return null;
  }
}

const taskArtifacts = (r: OrgRunner, ctx: TaskCtx, agentId: string): string[] =>
  r.state.agents[agentId]!.knownArtifactIds.filter((id) => r.state.artifacts[id]?.taskId === ctx.taskId).slice(-5);

/** Evidence the agent cites: valid when at least one id is an artifact it knows or a memory that exists. */
function citedEvidence(r: OrgRunner, agentId: string, raw: unknown): { ids: string[]; valid: boolean } {
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
  return { ids, valid: ids.some((id) => r.knows(agentId, id) || !!r.state.memory[id]) };
}

/* ======================================================================== learning loop (12–15) */

/** Every memory cites the events it comes from (the task outcome, or the decision outcome) and the evidence. */
function provenance(r: OrgRunner, ctx: TaskCtx, sourceEventId: string, outcome: string, artifactId: string | null) {
  return { runId: r.runId, taskId: ctx.taskId, genomeId: r.genome.id, sourceEventIds: [sourceEventId], evidenceArtifactIds: artifactId ? [artifactId] : [], outcome };
}

type TaskEnd = { success: boolean; score: number; stopReason: TaskOutcome['stopReason']; outcomeEventId: string; artifactId: string | null };

/** Task start: offer the entry agent the best lessons and the category's playbook entry (no model call). */
export function taskStartLearning(r: OrgRunner, ctx: TaskCtx): void {
  const f = r.config.features;
  if (!(f.afterActionReview || f.playbook) || ctx.spec.kind !== 'bench') return;
  const cat = ctx.spec.task.category;
  const entry = r.genome.entryAgentId;
  const me = r.state.agents[entry];
  if (!me) return;
  const lesson = (id: string) => r.state.learning?.lessons[id];
  const usable = (it: MemoryItem) => !(f.lessonScoring && lesson(it.memoryId)?.retired);
  const boost = (it: MemoryItem) => (f.lessonScoring ? 0.5 + (lesson(it.memoryId)?.utility ?? 0.5) : 1);
  const query = `${cat} ${taskBrief(ctx.spec).slice(0, 400)}`;
  const pick = (filter: (it: MemoryItem) => boolean, k: number) => r.memory.retrieve(query, entry, me.teamId, r.genome.policies.memoryRead, k, { filter: (it) => filter(it) && usable(it), boost, recentFallback: true }).items;
  const items = [
    ...(f.afterActionReview ? pick((it) => tagsOf(it).includes('lesson') && tagsOf(it).includes(`category:${cat}`), 2) : []),
    ...(f.playbook ? pick((it) => tagsOf(it).includes('playbook') && tagsOf(it).includes(`category:${cat}`), 1) : []),
  ];
  if (!items.length) return;
  r.emit1({ type: 'MEMORY_RETRIEVED', actorId: entry, payload: { agentId: entry, query: `task start: lessons and playbook for ${cat}`, itemIds: items.map((i) => i.memoryId), latencyMs: 0, deniedItemIds: [] } });
  ctx.pendingMemories[entry] = [...(ctx.pendingMemories[entry] ?? []), ...items];
  ctx.learningIds = items.map((i) => i.memoryId);
}

/** Task end: score lessons, predictions and decisions; then the after-action review. */
export async function afterTaskLearning(r: OrgRunner, ctx: TaskCtx, o: TaskEnd): Promise<void> {
  if (o.stopReason === 'stopped') return;
  const f = r.config.features;
  const s = r.state;

  if (f.lessonScoring && ctx.learningIds.length) {
    const done = s.taskOrder.map((id) => s.tasks[id]!).filter((t) => t.success !== null);
    const baseline = (done.filter((t) => t.success).length + 1) / (done.length + 2);
    for (const memoryId of ctx.learningIds) {
      const prev = s.learning?.lessons[memoryId];
      const uses = (prev?.uses ?? 0) + 1;
      const wins = (prev?.wins ?? 0) + (o.success ? 1 : 0);
      const utility = (wins + 1) / (uses + 2);
      r.emit1({ type: 'LESSON_EVALUATED', actorId: 'runtime', payload: { memoryId, taskId: ctx.taskId, success: o.success, uses, wins, utility, baseline, retired: uses >= 3 && utility < baseline - 0.1 } });
    }
  }

  const actual = o.success ? 1 : 0;
  if (ctx.plan) {
    const p = ctx.plan;
    r.emit1({ type: 'PREDICTION_SCORED', actorId: 'runtime', payload: { taskId: ctx.taskId, agentId: p.agentId, source: 'plan', refId: p.planId, predicted: p.predicted, actual, brier: (p.predicted - actual) ** 2 } });
  }

  const decisions = s.decisionOrder.map((id) => s.decisions[id]!).filter((d) => d.taskId === ctx.taskId && d.outcome);
  for (const d of decisions) {
    const out = d.outcome!;
    if (f.trackRecord) {
      // The last vote of each agent; only votes for the chosen option can be scored (the others' outcome is unknown).
      const last = new Map<string, (typeof d.votes)[number]>();
      for (const v of d.votes) last.set(v.agentId, v);
      for (const v of last.values())
        if (v.option === out.chosen && v.confidence !== undefined)
          r.emit1({ type: 'PREDICTION_SCORED', actorId: 'runtime', payload: { taskId: ctx.taskId, agentId: v.agentId, source: 'vote', refId: d.decisionId, predicted: v.confidence, actual, brier: (v.confidence - actual) ** 2 } });
    }
    if (f.decisionJournal) {
      const predicted = (out as { predictedSuccess?: number }).predictedSuccess ?? null;
      const decided = r.store.events(r.runId, { types: ['DECISION_COMPLETED'] }).find((e) => e.type === 'DECISION_COMPLETED' && e.payload.decisionId === d.decisionId)!;
      const memoryId = newId('mem');
      const cat = ctx.spec.kind === 'bench' ? ctx.spec.task.category : null;
      r.emit([
        {
          type: 'MEMORY_WRITTEN',
          actorId: d.proposerId,
          payload: {
            memoryId,
            scope: 'org',
            kind: 'decision',
            content: truncate(`Decision "${d.question}" → ${out.chosen} (${out.policy}; ${out.rationale})${predicted === null ? '' : `, predicted ${(predicted * 100).toFixed(0)}% success`}. The task then ${o.success ? 'passed' : 'failed'}.`, 1500),
            provenance: provenance(r, ctx, decided.eventId, o.success ? 'task passed' : 'task failed', null),
            tags: ['decision', ...(cat ? [`category:${cat}`] : [])],
          },
        },
        { type: 'DECISION_REVIEWED', actorId: 'runtime', payload: { decisionId: d.decisionId, taskId: ctx.taskId, chosen: out.chosen, predictedSuccess: predicted, taskSuccess: o.success, memoryId } },
      ]);
    }
  }

  const bench = ctx.spec.kind === 'bench' ? ctx.spec.task : null;
  if (!bench || !(f.afterActionReview || f.playbook)) return;
  const cat = bench.category;
  const firstWin = o.success && !s.taskOrder.some((id) => id !== ctx.taskId && s.tasks[id]?.category === cat && s.tasks[id]?.success === true);
  const author = ctx.submitted?.by ?? r.genome.entryAgentId;
  if (f.afterActionReview && (!o.success || firstWin)) await review(r, ctx, author, o);
  else if (f.playbook && firstWin) {
    // No review call: keep the submitter's own last reasoning as the approach.
    const why = (ctx.reasoning[author] ?? []).slice(-1)[0];
    if (why) r.emit1({ type: 'MEMORY_WRITTEN', actorId: author, payload: { memoryId: newId('mem'), scope: 'org', kind: 'episodic', content: truncate(`Approach that passed a ${cat} task: ${why}`, 1000), provenance: provenance(r, ctx, o.outcomeEventId, 'task passed', o.artifactId), tags: ['playbook', `category:${cat}`] } });
  }
}

/** After-action review: "why?" up to three levels, one lesson for the organization, and on success the approach. */
async function review(r: OrgRunner, ctx: TaskCtx, agentId: string, o: TaskEnd): Promise<void> {
  if (ctx.spec.kind !== 'bench') return;
  const t = ctx.spec.task;
  const s = r.state;
  const checks = Object.values(s.checkRuns).filter((c) => c.taskId === ctx.taskId && c.result);
  const last = checks[checks.length - 1]?.result;
  const rejected = s.rejectedActions.filter((x) => x.taskId === ctx.taskId);
  const reasoning = Object.entries(ctx.reasoning).map(([a, rs]) => `- ${a}: ${rs[rs.length - 1] ?? ''}`).slice(0, 4);
  const prompt = [
    // Only counts from the hidden tests: their content never enters a prompt (it would leak into later tasks).
    `TASK ${t.id} [${t.category}] "${t.title}" just ${o.success ? 'PASSED' : 'FAILED'} the hidden tests (score ${o.score.toFixed(2)}).`,
    `Team record: ${ctx.turns} turn(s), ended by ${o.stopReason}; ${last ? `last public checks ${last.passed}/${last.total}` : 'public checks never run'}; ${rejected.length} rejected action(s)${rejected.length ? ` (last: ${truncate(rejected[rejected.length - 1]!.reason, 160)})` : ''}.`,
    ...(reasoning.length ? ['Last reasoning of each teammate:', ...reasoning] : []),
    `Ask "why did this ${o.success ? 'work' : 'fail'}?" up to three times, each answer explaining the one before.`,
    `Then write ONE lesson (at most 2 sentences) the organization should apply to future ${t.category} tasks: about how the team works, not this task's code.`,
    ...(o.success ? ['Also give the approach that worked, in one sentence, as "approach".'] : []),
    `Reply JSON {"whys": ["..."], "lesson": "..."${o.success ? ', "approach": "..."' : ''}}.`,
  ].join('\n');
  const j = await ask(r, agentId, ctx, 'after-action review', prompt, REVIEW_SCHEMA, 350);
  if (!j || j === 'refused' || typeof j.lesson !== 'string' || !j.lesson.trim()) return;
  const whys = Array.isArray(j.whys) ? j.whys.filter((x): x is string => typeof x === 'string').slice(0, 3).map((x) => truncate(x, 400)) : [];
  const lesson = truncate(j.lesson.trim(), 600);
  // A lesson the organization already holds is reinforced, not copied (keeps memory small and lets it be scored).
  const same = r.memory.all().find((m) => tagsOf(m).includes('lesson') && tagsOf(m).includes(`category:${t.category}`) && similar(m.content, lesson));
  const memoryId = same?.memoryId ?? newId('mem');
  r.emit([
    ...(same ? [] : [{ type: 'MEMORY_WRITTEN' as const, actorId: agentId, payload: { memoryId, scope: 'org' as const, kind: o.success ? ('semantic' as const) : ('failure' as const), content: `Lesson (${t.category}, from a task that ${o.success ? 'passed' : 'failed'}): ${lesson}`, provenance: provenance(r, ctx, o.outcomeEventId, o.success ? 'task passed' : 'task failed', o.artifactId), tags: ['lesson', `category:${t.category}`] } }]),
    { type: 'REFLECTION_RECORDED', actorId: agentId, payload: { taskId: ctx.taskId, agentId, success: o.success, category: t.category, whys, lesson, memoryId } },
  ]);
  if (o.success && r.config.features.playbook && typeof j.approach === 'string' && j.approach.trim())
    r.emit1({ type: 'MEMORY_WRITTEN', actorId: agentId, payload: { memoryId: newId('mem'), scope: 'org', kind: 'episodic', content: truncate(`Approach that passed a ${t.category} task: ${j.approach.trim()}`, 1000), provenance: provenance(r, ctx, o.outcomeEventId, 'task passed', o.artifactId), tags: ['playbook', `category:${t.category}`] } });
}

/* ======================================================================== prediction (21) */

/** Before the first turn: the entry agent sketches 2–3 plans with predicted success; the best one guides the team. */
export async function planPaths(r: OrgRunner, ctx: TaskCtx): Promise<void> {
  if (!r.config.features.multiPath || ctx.spec.kind !== 'bench') return;
  const entry = r.genome.entryAgentId;
  const prompt = [
    taskBrief(ctx.spec),
    '',
    'Before your team starts: sketch 2 or 3 genuinely different plans for this task (one sentence each) and estimate, for each, the probability (0-1) that it passes the hidden tests. Your predictions are scored against the outcome.',
    'Reply JSON {"plans": [{"summary": "...", "predictedSuccess": 0.0}]}.',
  ].join('\n');
  const j = await ask(r, entry, ctx, 'plan paths', prompt, PLANS_SCHEMA, 300);
  if (!j || j === 'refused' || !Array.isArray(j.plans)) return;
  const plans = (j.plans as unknown[])
    .filter((p): p is { summary: string; predictedSuccess: unknown } => !!p && typeof (p as { summary?: unknown }).summary === 'string' && !!(p as { summary: string }).summary.trim())
    .slice(0, 3)
    .map((p, i) => ({ planId: `plan${i + 1}`, summary: truncate(p.summary.trim(), 400), predictedSuccess: clamp01(p.predictedSuccess) }));
  if (!plans.length) return;
  const best = plans.reduce((b, p) => (p.predictedSuccess > b.predictedSuccess ? p : b));
  r.emit1({ type: 'PLANS_PROPOSED', actorId: entry, payload: { taskId: ctx.taskId, agentId: entry, plans, chosenPlanId: best.planId } });
  ctx.plan = { planId: best.planId, predicted: best.predictedSuccess, agentId: entry };
  const others = plans.filter((p) => p !== best).map((p) => `${p.summary} (${(p.predictedSuccess * 100).toFixed(0)}%)`);
  (ctx.pendingFeedback[entry] ??= []).push(`Plan chosen from ${plans.length} alternative(s), predicted ${(best.predictedSuccess * 100).toFixed(0)}%: ${best.summary}${others.length ? ` — set aside: ${others.join('; ')}` : ''}`);
}

/* ======================================================================== deliberation (15–20, 22) */

type Vote = Ballot & { rationale: string; confidence?: number };

function ballotFor(r: OrgRunner, agentId: string, option: string, evidenceValid: boolean): Ballot {
  const f = r.config.features;
  const g = r.genome;
  const track = f.trackRecord ? 0.5 + (calibration(r.state, agentId).score ?? 0.75) : null;
  const ev = f.evidenceRule ? (evidenceValid ? 1 : 0.5) : 1;
  const base = track ?? 1 + (r.state.agents[agentId]?.stats.successfulSubmissions ?? 0);
  return { agentId, option, weight: base * ev, value: (track ?? 1) * ev, isEntry: agentId === g.entryAgentId, canReview: capabilitiesOf(g, agentId).includes('review') };
}

async function argue(r: OrgRunner, ctx: TaskCtx, decisionId: string, question: string, agentId: string, round: number, stance: 'against' | 'rebuttal' | 'premortem', option: string, context: string[]): Promise<string | null> {
  const instruction =
    stance === 'against'
      ? `Argue in at most 3 sentences why choosing ${JSON.stringify(option)} would be a mistake.`
      : stance === 'rebuttal'
        ? `Rebut in at most 3 sentences: why ${JSON.stringify(option)} is still the right choice.`
        : `Assume ${JSON.stringify(option)} was chosen and the task then FAILED. In at most 3 sentences name the two most likely reasons and one mitigation the team should apply now.`;
  const prompt = [taskBrief(ctx.spec), '', `DECISION: ${question}`, ...context, instruction, `Cite the artifact ids you rely on (you know: ${taskArtifacts(r, ctx, agentId).join(', ') || 'none'}).`, 'Reply JSON {"content": "...", "evidence": ["..."]}.'].join('\n');
  const j = await ask(r, agentId, ctx, `${stance} on ${decisionId}`, prompt, ARGUMENT_SCHEMA, 250);
  if (!j || j === 'refused' || typeof j.content !== 'string' || !j.content.trim()) return null;
  const ev = citedEvidence(r, agentId, j.evidence);
  const content = truncate(j.content.trim(), 1500);
  r.emit1({ type: 'ARGUMENT_MADE', actorId: agentId, payload: { argumentId: newId('arg'), decisionId, agentId, round, stance, option, content, evidence: ev.ids, evidenceValid: ev.valid } });
  return truncate(content, 600);
}

/** A decision with the enabled deliberation features. With every flag off, runner.runDecision is used instead. */
export async function deliberate(r: OrgRunner, ctx: TaskCtx, proposer: string, a: Extract<Action, { type: 'propose_decision' }>, cause: string): Promise<void> {
  const g = r.genome;
  const f = r.config.features;
  const policy = g.policies.decision;
  if (!IMPLEMENTED_POLICIES.has(policy)) return r.reject(ctx, proposer, a.type, `decision policy ${policy} is not implemented in v0.1`, cause);
  if (!a.options.includes(a.recommendation)) return r.reject(ctx, proposer, a.type, 'recommendation must be one of the options', cause);
  const voters = r.contacts(proposer, g.edges.filter((e) => e.from === proposer).map((e) => e.to)).slice(0, 4);
  if (!voters.length) return r.reject(ctx, proposer, a.type, 'nobody you can reach to vote', cause);
  const decisionId = newId('dec');
  const evidence = taskArtifacts(r, ctx, proposer).slice(-3);
  const participants = [proposer, ...voters];
  r.emit1({ type: 'DECISION_CREATED', actorId: proposer, payload: { decisionId, question: a.question, options: a.options, proposerId: proposer, recommendation: a.recommendation, evidence, policy, participants, taskId: ctx.taskId }, causedBy: cause });
  const proposerReason = (ctx.reasoning[proposer] ?? []).slice(-1)[0] ?? '';
  const predict = !!(f.trackRecord || f.decisionJournal);

  // 15: similar past decisions and how they turned out.
  let past: MemoryItem[] = [];
  if (f.decisionJournal) {
    const me = r.state.agents[proposer]!;
    past = r.memory.retrieve(a.question, proposer, me.teamId, g.policies.memoryRead, 2, { filter: (it) => tagsOf(it).includes('decision') }).items;
    if (past.length) r.emit1({ type: 'MEMORY_RETRIEVED', actorId: proposer, payload: { agentId: proposer, query: truncate(`past decisions: ${a.question}`, 300), itemIds: past.map((m) => m.memoryId), latencyMs: 0, deniedItemIds: [] } });
  }

  const votes = new Map<string, Vote>();
  const pb = ballotFor(r, proposer, a.recommendation, evidence.length > 0);
  votes.set(proposer, { ...pb, rationale: 'proposer recommendation' });
  r.emit1({ type: 'VOTE_CAST', actorId: proposer, payload: { decisionId, agentId: proposer, option: a.recommendation, rationale: 'proposer recommendation', weight: pb.weight, ...(f.debate ? { round: 1 } : {}), ...(f.evidenceRule ? { evidence, evidenceWeight: pb.value! } : {}) } });

  const votePrompt = (v: string, round: number, extra: string[]) =>
    [
      taskBrief(ctx.spec),
      '',
      `DECISION REQUESTED by ${proposer}: ${a.question}`,
      `Options: ${a.options.map((o) => JSON.stringify(o)).join(', ')}`,
      // 18: the first round is blind to the recommendation so votes are independent.
      f.blindVote && round === 1 ? 'Vote independently: the proposer’s recommendation is not shown in this round.' : `Proposer recommends ${JSON.stringify(a.recommendation)} because: ${proposerReason}`,
      ...(past.length ? ['Similar past decisions and how they turned out:', ...past.map((m) => `- ${truncate(m.content, 300)}`)] : []),
      ...extra,
      `Evidence you can cite (artifact ids you know): ${taskArtifacts(r, ctx, v).join(', ') || 'none'}.${f.evidenceRule ? ' Votes that cite no evidence you can see count half.' : ''}`,
      `Vote for exactly one option (copy it verbatim) with a one-sentence rationale${predict ? ', your probability (0-1) that the task will pass if your option is chosen as "confidence"' : ''}, and the ids you rely on as "evidence".`,
      `Reply JSON {"option": "...", "rationale": "..."${predict ? ', "confidence": 0.0' : ''}, "evidence": ["..."]}.`,
    ].join('\n');

  let budgetLeft = true;
  const castRound = async (round: number, extra: string[]) => {
    for (const v of voters) {
      if (!budgetLeft) return;
      const j = await ask(r, v, ctx, `vote on ${decisionId}${round > 1 ? ` (round ${round})` : ''}`, votePrompt(v, round, extra), VOTE_SCHEMA, 200);
      if (j === 'refused') {
        budgetLeft = false;
        return;
      }
      if (!j) continue;
      const option = typeof j.option === 'string' ? j.option : undefined;
      if (!option || !a.options.includes(option)) {
        r.emit1({ type: 'ACTION_REJECTED', actorId: 'runtime', payload: { agentId: v, action: 'vote', reason: `invalid option ${JSON.stringify(j.option)} — abstention recorded`, taskId: ctx.taskId } });
        continue;
      }
      const ev = citedEvidence(r, v, j.evidence);
      const b = ballotFor(r, v, option, ev.valid);
      const confidence = predict && typeof j.confidence === 'number' ? clamp01(j.confidence) : undefined;
      const previous = votes.get(v)?.option;
      const rationale = truncate(typeof j.rationale === 'string' ? j.rationale : '', 1000);
      votes.set(v, { ...b, rationale, ...(confidence !== undefined ? { confidence } : {}) });
      r.emit1({
        type: 'VOTE_CAST',
        actorId: v,
        payload: {
          decisionId,
          agentId: v,
          option,
          rationale,
          weight: b.weight,
          ...(f.debate ? { round } : {}),
          ...(round > 1 && previous !== undefined ? { previousOption: previous } : {}),
          ...(f.blindVote && round === 1 ? { blind: true } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(f.evidenceRule ? { evidence: ev.ids, evidenceWeight: b.value! } : {}),
        },
      });
    }
  };
  await castRound(1, []);

  // 16: on disagreement, a critic argues against the leading option, a supporter rebuts, and everyone votes again.
  let rounds = 1;
  if (f.debate && budgetLeft && new Set([...votes.values()].map((b) => b.option)).size > 1) {
    const first = resolveDecision(policy, a.options, [...votes.values()], a.recommendation);
    const leader = first.chosen;
    const dissent = [...votes.values()].filter((b) => b.option !== leader);
    const critic = (dissent.find((b) => b.canReview) ?? dissent[0])?.agentId;
    const supporter = votes.get(proposer)?.option === leader ? proposer : [...votes.values()].find((b) => b.option === leader && b.agentId !== critic)?.agentId;
    if (critic) {
      const tally = Object.entries(first.tally).map(([o, n]) => `${o}: ${Number(n.toFixed(2))}`).join(', ');
      const against = await argue(r, ctx, decisionId, a.question, critic, 1, 'against', leader, [`The team leans to ${JSON.stringify(leader)} (${tally}); you voted ${JSON.stringify(votes.get(critic)!.option)}.`]);
      if (against) {
        const rebuttal = supporter ? await argue(r, ctx, decisionId, a.question, supporter, 1, 'rebuttal', leader, [`${critic} argues against it: ${against}`]) : null;
        rounds = 2;
        await castRound(2, ['DEBATE after the first vote:', `- Leading option ${JSON.stringify(leader)} (${tally})`, `- ${critic} against it: ${against}`, ...(rebuttal ? [`- ${supporter} in reply: ${rebuttal}`] : []), 'Vote again; you may change your vote.']);
      }
    }
  }

  const ballots = [...votes.values()];
  let res = resolveDecision(policy, a.options, ballots, a.recommendation);
  // 19: without a majority, the agent with decision authority settles it (its own last vote; no extra call).
  let tieBreakBy: string | undefined;
  if (f.tieBreak && (policy === 'MAJORITY' || policy === 'WEIGHTED_VOTE')) {
    const vals = Object.values(res.tally).sort((x, y) => y - x);
    const total = vals.reduce((p, c) => p + c, 0);
    if ((vals.length > 1 && vals[0] === vals[1]) || (total > 0 && vals[0]! / total <= 0.5)) {
      const decider = participants.find((p) => capabilitiesOf(g, p).includes('decide')) ?? (participants.includes(g.entryAgentId) ? g.entryAgentId : proposer);
      const chosen = votes.get(decider)?.option ?? a.recommendation;
      tieBreakBy = decider;
      res = { ...res, chosen, confidence: Math.min(res.confidence, 0.5), rationale: `no majority after ${rounds} round(s); settled by ${decider} (decision authority)`, opposition: ballots.filter((b) => b.option !== chosen).map((b) => b.agentId) };
    }
  }
  const backing = ballots.filter((b) => b.option === res.chosen && b.confidence !== undefined);
  const w = backing.reduce((p, b) => p + (b.value ?? 1), 0);
  const predictedSuccess = backing.length && w > 0 ? backing.reduce((p, b) => p + b.confidence! * (b.value ?? 1), 0) / w : undefined;
  const minority = ballots.filter((b) => b.option !== res.chosen).map((b) => `${b.agentId} (${b.option}): ${b.rationale}`);
  r.emit1({
    type: 'DECISION_COMPLETED',
    actorId: 'runtime',
    payload: {
      decisionId,
      chosen: res.chosen,
      confidence: Math.max(0, Math.min(1, res.confidence)),
      policy,
      tally: res.tally,
      rationale: res.rationale,
      opposition: res.opposition,
      ...(f.debate ? { rounds } : {}),
      ...(predictedSuccess !== undefined ? { predictedSuccess } : {}),
      ...(f.blindVote && minority.length ? { minorityReport: truncate(minority.join(' | '), 2000) } : {}),
      ...(tieBreakBy ? { tieBreakBy } : {}),
    },
  });
  const fb = [`Decision ${decisionId} resolved by ${policy}${rounds > 1 ? ` after ${rounds} rounds` : ''}: ${res.chosen} (${res.rationale}).`];
  if (minority.length && f.blindVote) fb.push(`Minority view: ${truncate(minority.join(' | '), 600)}`);
  if (past.length) fb.push(`Similar past decisions: ${past.map((m) => truncate(m.content, 200)).join(' | ')}`);
  (ctx.pendingFeedback[proposer] ??= []).push(...fb);

  // 20: pre-mortem — imagine the choice failed, name the risks and a mitigation.
  if (f.preMortem && budgetLeft) {
    const critic = voters.find((v) => capabilitiesOf(g, v).includes('review')) ?? voters[0]!;
    const pm = await argue(r, ctx, decisionId, a.question, critic, rounds, 'premortem', res.chosen, []);
    if (pm) (ctx.pendingFeedback[proposer] ??= []).push(`Pre-mortem by ${critic}: ${pm}`);
  }
}
