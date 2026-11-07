import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deliberationView, knowledgeView, presetGenome } from '@orgworld/core';
import { EventStore } from '@orgworld/store';
import { ScriptedProvider, type CognitionRequest } from '@orgworld/cognition';
import { familyById } from '@orgworld/bench';
import { buildRunConfig, createRun, OrgRunner, systemPrompt } from '../src/index.ts';

/*
 * MECHANICS TESTS for the organization-behaviour extensions (conflict C-21) with the SCRIPTED provider (test-only).
 * They pin what each feature records and when it calls the model; they are NOT evidence that the features help.
 */

const stores: EventStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});
const fam = familyById('impl-rle');
const task = fam.generate(0);
const solution = fam.referenceDeliverable(0);
const agentOf = (r: CognitionRequest) => /agent id "([^"]+)"/.exec(r.system)?.[1];
const created = (p: string) => /Created code artifact (art_[0-9a-f]{16})/.exec(p)?.[1];
/** The reference solution for the task in this prompt (family#variant). */
const reference = (p: string) => {
  const m = /TASK (\S+)#(\d+) —/.exec(p)!;
  return familyById(m[1]!).referenceDeliverable(Number(m[2]));
};
const retrievals = (r: OrgRunner) =>
  r.store
    .events(r.runId, { types: ['MEMORY_RETRIEVED'] })
    .flatMap((e) => (e.type === 'MEMORY_RETRIEVED' && e.payload.query.startsWith('task start') ? [e.payload.itemIds] : []));
const NEW_TYPES = ['REFLECTION_RECORDED', 'LESSON_EVALUATED', 'DECISION_REVIEWED', 'ARGUMENT_MADE', 'PLANS_PROPOSED', 'PREDICTION_SCORED', 'COUNTERFACTUAL_EVALUATED', 'CONTRIBUTION_MEASURED'];

function setup(preset: string, features: Record<string, boolean>, script: (req: CognitionRequest, r: OrgRunner) => unknown) {
  const store = EventStore.open(join(mkdtempSync(join(tmpdir(), 'oworg-')), 'orgworld.db'));
  stores.push(store);
  const genome = presetGenome(preset);
  const cfg = buildRunConfig({ runId: `run_${Math.random().toString(36).slice(2, 8)}`, mode: 'sandbox', kind: 'stream', condition: 'fixed-generalist', genome, model: { provider: 'scripted', model: 's' }, budget: {}, reward: {}, seeds: {}, features, evolution: {}, policy: {} });
  createRun(store, cfg);
  const box: { r?: OrgRunner } = {};
  const prompts: Array<{ purpose: string; prompt: string; agent?: string }> = [];
  const runner = new OrgRunner({
    store,
    runId: cfg.runId,
    provider: new ScriptedProvider((req) => {
      prompts.push({ purpose: req.purpose, prompt: req.prompt, agent: agentOf(req) });
      return script(req, box.r!) as never;
    }),
  });
  box.r = runner;
  runner.instantiate(genome, 'test');
  runner.start();
  return { store, runner, prompts };
}

/** a1 proposes A vs B; round 1 splits 2–2, the debate makes a2 and a3 swap sides, a tie remains and a1 settles it. */
function debateWorld(req: CognitionRequest, r: OrgRunner) {
  const me = agentOf(req)!;
  const p = req.purpose;
  if (p.startsWith('vote on')) {
    const r2 = p.includes('round 2');
    const option = ({ a2: r2 ? 'A' : 'B', a3: r2 ? 'B' : 'A', a4: 'B' } as Record<string, string>)[me]!;
    return { option, rationale: `${me} round ${r2 ? 2 : 1}`, confidence: 0.8, evidence: me === 'a4' ? ['art_0000000000000000'] : [] };
  }
  if (p.startsWith('against on')) return { content: 'B handles the empty input; A does not.', evidence: [] };
  if (p.startsWith('rebuttal on')) return { content: 'A is simpler and the empty case is covered.', evidence: [] };
  if (p.startsWith('premortem on')) return { content: 'Unicode runs and empty strings could fail; run the public checks first.', evidence: [] };
  if (me !== 'a1') return { reasoning: 'nothing asked of me', actions: [{ type: 'wait' }] };
  const art = created(req.prompt);
  if (art) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: art }] };
  if (!Object.values(r.state.decisions).some((d) => d.taskId === r.state.activeTaskId)) return { reasoning: 'decide first', actions: [{ type: 'propose_decision', question: 'Which approach for the encoder?', options: ['A', 'B'], recommendation: 'A' }] };
  return { reasoning: 'implement the decision', actions: [{ type: 'write_code', title: 'impl', code: reference(req.prompt) }] };
}

describe('organization extensions are off by default (C-21)', () => {
  it('a decision with default features emits none of the new records and keeps the old vote prompt', async () => {
    const { runner, prompts } = setup('generalists-4', {}, debateWorld);
    await runner.runTask({ kind: 'bench', task });
    const types = new Set(runner.store.events(runner.runId).map((e) => e.type));
    for (const t of NEW_TYPES) expect(types.has(t as never)).toBe(false);
    expect(runner.state.learning).toBeUndefined();
    const votes = Object.values(runner.state.decisions)[0]!.votes;
    expect(votes.every((v) => v.round === undefined && v.confidence === undefined)).toBe(true);
    expect(prompts.find((p) => p.purpose.startsWith('vote on'))!.prompt).toContain('Proposer recommends "A"');
    expect(systemPrompt(runner.state, runner.config, 'a1', ['wait'])).not.toContain('Track record');
  });
});

describe('deliberation (ideas 16–20, 22)', () => {
  it('blind first vote, evidence rule, debate with changed minds, tie-break, pre-mortem, scored predictions', async () => {
    const { runner, prompts } = setup('generalists-4', { blindVote: true, evidenceRule: true, debate: true, tieBreak: true, preMortem: true, trackRecord: true, decisionJournal: true }, debateWorld);
    const out = await runner.runTask({ kind: 'bench', task });
    expect(out.success).toBe(true);
    const round1 = prompts.filter((p) => p.purpose.startsWith('vote on') && !p.purpose.includes('round 2'));
    expect(round1).toHaveLength(3);
    for (const p of round1) expect(p.prompt).not.toContain('Proposer recommends'); // blind
    expect(prompts.filter((p) => p.purpose.includes('round 2'))[0]!.prompt).toContain('a2 against it: B handles the empty input');

    const view = deliberationView(runner.state).decisions[0]!;
    expect(view.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(view.arguments.map((a) => `${a.agentId}:${a.stance}`)).toEqual(['a2:against', 'a1:rebuttal', 'a2:premortem']);
    expect(view.mindChanges).toEqual([
      { agentId: 'a2', from: 'B', to: 'A' },
      { agentId: 'a3', from: 'A', to: 'B' },
    ]);
    // 2–2 after the debate: a1 (the entry agent; nobody holds "decide") settles it with its own vote.
    expect(view).toMatchObject({ chosen: 'A', tieBreakBy: 'a1', taskSuccess: true });
    expect(view.minorityReport).toContain('a3 (B)');
    expect(view.predictedSuccess).toBeCloseTo(0.8, 9);
    // Evidence rule: a4 cited an id it cannot see, so its vote counts half like the others without evidence.
    const a4 = runner.state.decisions[view.decisionId]!.votes.find((v) => v.agentId === 'a4')!;
    expect(a4).toMatchObject({ evidence: ['art_0000000000000000'], evidenceWeight: 0.625 }); // (0.5 + 0.75 prior) × 0.5
    // Track record: only a2 ended on the chosen option with a stated confidence.
    expect(runner.state.learning!.predictions).toMatchObject([{ agentId: 'a2', source: 'vote', predicted: 0.8, actual: 1 }]);
    expect(runner.state.learning!.predictions[0]!.brier).toBeCloseTo(0.04, 9);
    // Journal: the decision and its outcome are kept for next time.
    expect(runner.state.learning!.decisionReviews).toMatchObject([{ chosen: 'A', taskSuccess: true }]);
    const journal = Object.values(runner.state.memory).find((m) => (m as { tags?: string[] }).tags?.includes('decision'))!;
    expect(journal.content).toContain('The task then passed');
  });

  it('the next decision sees similar past decisions', async () => {
    const { runner, prompts } = setup('generalists-4', { decisionJournal: true }, debateWorld);
    await runner.runTask({ kind: 'bench', task });
    await runner.runTask({ kind: 'bench', task: fam.generate(1) });
    const second = prompts.filter((p) => p.purpose.startsWith('vote on')).slice(-1)[0]!;
    expect(second.prompt).toContain('Similar past decisions and how they turned out:');
    expect(second.prompt).toContain('The task then passed');
  });
});

describe('learning loop (ideas 12–14)', () => {
  it('a failure is reviewed into a lesson, the lesson is offered and scored on the next task, the first win becomes a playbook entry', async () => {
    let attempt = 0;
    const reviews: string[] = [];
    const { runner } = setup('single-agent', { afterActionReview: true, playbook: true, lessonScoring: true }, (req) => {
      if (req.purpose === 'after-action review') {
        reviews.push(req.prompt);
        return { whys: ['the output was wrong', 'nobody ran the checks', 'there was no habit of checking'], lesson: 'Run the public checks before submitting.', approach: 'Implement, run the checks, then submit.' };
      }
      const art = created(req.prompt);
      if (art) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: art }] };
      return { reasoning: 'write', actions: [{ type: 'write_code', title: 'impl', code: attempt === 0 ? 'module.exports = {};' : reference(req.prompt) }] };
    });
    const first = await runner.runTask({ kind: 'bench', task });
    expect(first.success).toBe(false);
    // Hidden-test content never reaches a prompt; only the score does.
    const ev = runner.store.events(runner.runId, { types: ['EVALUATION_COMPLETED'] })[0]!;
    const details = ev.type === 'EVALUATION_COMPLETED' ? ev.payload.details : '';
    expect(details.length).toBeGreaterThan(0);
    expect(reviews[0]).not.toContain(details.slice(0, 40));
    expect(reviews[0]).toContain('FAILED the hidden tests (score 0.00)');
    const lesson = Object.values(runner.state.memory).find((m) => (m as { tags?: string[] }).tags?.includes('lesson'))!;
    expect(lesson).toMatchObject({ scope: 'org', kind: 'failure' });
    expect(runner.state.learning!.reflections[0]).toMatchObject({ success: false, whys: ['the output was wrong', 'nobody ran the checks', 'there was no habit of checking'] });

    attempt = 1;
    const second = await runner.runTask({ kind: 'bench', task: fam.generate(1) });
    expect(second.success).toBe(true);
    const offered = retrievals(runner)[0]!;
    expect(offered).toEqual([lesson.memoryId]);
    expect(runner.state.learning!.lessons[lesson.memoryId]).toMatchObject({ uses: 1, wins: 1, retired: false });
    expect(reviews).toHaveLength(2); // the first success in the category is reviewed too
    const playbook = Object.values(runner.state.memory).find((m) => (m as { tags?: string[] }).tags?.includes('playbook'))!;
    expect(playbook.content).toBe('Approach that passed a implementation task: Implement, run the checks, then submit.');

    await runner.runTask({ kind: 'bench', task: fam.generate(2) });
    expect(reviews).toHaveLength(2); // later successes need no review
    expect(retrievals(runner)[1]).toContain(playbook.memoryId);
    const k = knowledgeView(runner.state);
    expect(k.items.map((i) => i.type)).toEqual(['lesson', 'playbook']); // the success review repeated the lesson: reinforced, not copied
    expect(k.reflections.map((x) => x.success)).toEqual([false, true]);
    expect(k.expertise.solo).toEqual({ implementation: { worked: 3, passed: 2 } });
  });

  it('a lesson whose tasks keep failing while others pass is retired and no longer offered; repeats reinforce it', async () => {
    const { runner } = setup('single-agent', { afterActionReview: true, lessonScoring: true }, (req) => {
      if (req.purpose === 'after-action review') return { whys: ['wrong'], lesson: req.prompt.includes('[debugging]') ? 'Reproduce the bug with a check first.' : 'Always return an empty object.' };
      const art = created(req.prompt);
      if (art) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: art }] };
      const debug = req.prompt.includes('[category: debugging]');
      return { reasoning: 'write', actions: [{ type: 'write_code', title: 'impl', code: debug ? reference(req.prompt) : 'module.exports = {};' }] };
    });
    const dbg = familyById('debug-binary-search');
    const plan = [task, dbg.generate(0), dbg.generate(1), fam.generate(1), fam.generate(2), fam.generate(0), fam.generate(1)];
    for (const t of plan) await runner.runTask({ kind: 'bench', task: t });
    const implLessons = Object.values(runner.state.memory).filter((m) => (m as { tags?: string[] }).tags?.includes('category:implementation'));
    expect(implLessons).toHaveLength(1); // four failures, one lesson, reinforced
    const id = implLessons[0]!.memoryId;
    expect(runner.state.learning!.reflections.filter((x) => x.memoryId === id)).toHaveLength(5);
    expect(runner.state.learning!.lessons[id]).toMatchObject({ uses: 3, wins: 0, retired: true });
    expect(retrievals(runner).filter((ids) => ids.includes(id))).toHaveLength(3); // not offered on the last task
  });
});

describe('prediction and expertise (ideas 21, 23)', () => {
  it('multi-path planning picks the best predicted plan, guides the entry agent, and is scored', async () => {
    const { runner, prompts } = setup('single-agent', { multiPath: true, expertiseDirectory: true }, (req) => {
      if (req.purpose === 'plan paths') return { plans: [{ summary: 'Regex-based encoder', predictedSuccess: 0.4 }, { summary: 'Single pass with a counter', predictedSuccess: 0.9 }] };
      const art = created(req.prompt);
      if (art) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: art }] };
      return { reasoning: 'write', actions: [{ type: 'write_code', title: 'impl', code: solution }] };
    });
    await runner.runTask({ kind: 'bench', task });
    expect(runner.state.learning!.plans[0]).toMatchObject({ chosenPlanId: 'plan2', agentId: 'solo' });
    const firstTurn = prompts.find((p) => p.purpose.includes('turn 1'))!;
    expect(firstTurn.prompt).toContain('Plan chosen from 2 alternative(s), predicted 90%: Single pass with a counter — set aside: Regex-based encoder (40%)');
    expect(runner.state.learning!.predictions).toMatchObject([{ source: 'plan', refId: 'plan2', predicted: 0.9, actual: 1 }]);
    expect(systemPrompt(runner.state, runner.config, 'solo', ['wait'])).toContain('Track record (finished tasks worked on that passed, by category): you: implementation 1/1.');
  });

  it('planDecision: the team votes between the plans (blind), may overrule the entry agent, and that plan is scored', async () => {
    const { runner, prompts } = setup('generalists-4', { multiPath: true, planDecision: true, blindVote: true, trackRecord: true }, (req, r) => {
      const me = agentOf(req)!;
      if (req.purpose === 'plan paths') return { plans: [{ summary: 'Regex-based encoder', predictedSuccess: 0.9 }, { summary: 'Single pass with a counter', predictedSuccess: 0.6 }] };
      if (req.purpose.startsWith('vote on')) return { option: 'plan2: Single pass with a counter', rationale: `${me}: simpler`, confidence: 0.7, evidence: [] };
      if (me !== 'a1') return { reasoning: 'idle', actions: [{ type: 'wait' }] };
      const art = created(req.prompt);
      if (art) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: art }] };
      void r;
      return { reasoning: 'write', actions: [{ type: 'write_code', title: 'impl', code: reference(req.prompt) }] };
    });
    await runner.runTask({ kind: 'bench', task });
    const d = Object.values(runner.state.decisions)[0]!;
    expect(d.question).toBe('Which plan should the team follow for this task?');
    expect(d.outcome).toMatchObject({ chosen: 'plan2: Single pass with a counter' }); // 3 votes against a1's recommendation
    expect(prompts.filter((p) => p.purpose.startsWith('vote on')).every((p) => !p.prompt.includes('Proposer recommends'))).toBe(true);
    expect(prompts.find((p) => p.purpose.includes('turn 1'))!.prompt).toContain('Plan decided by the team from 2 alternative(s), predicted 60%: Single pass with a counter');
    expect(runner.state.learning!.predictions.map((p) => `${p.source}:${p.refId}`)).toEqual(['plan:plan2', 'vote:' + d.decisionId, 'vote:' + d.decisionId, 'vote:' + d.decisionId]);
  });
});
