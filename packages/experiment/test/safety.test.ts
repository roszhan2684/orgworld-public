import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '@orgworld/store';
import { CognitionError, ScriptedProvider, type CognitionProvider, type CognitionRequest } from '@orgworld/cognition';
import { familyById, taskById } from '@orgworld/bench';
import { experimentReadings, experimentSpendUsd, readingsCsv, runExperiment } from '../src/index.ts';

/*
 * PIPELINE TESTS with the SCRIPTED provider (free, deterministic, labelled scripted — NOT research results).
 * Scripted world: the specialist pool's planner delegates to the implementer, which writes the reference solution
 * and reports back. Reviewer and tester are never consulted, so the heuristic proposer sees them as idle.
 */
const EXCLUDE = ['impl-expr-eval', 'impl-interval-merge', 'impl-lru-cache'];

function specialistWorld(opts: { costPerCall?: number; failFromCall?: number; hangFromCall?: number } = {}): () => CognitionProvider {
  let n = 0;
  return () => {
    const inner = new ScriptedProvider((req: CognitionRequest) => {
      const me = /agent id "([^"]+)"/.exec(req.system)?.[1];
      const taskId = /TASK (\S+) —/.exec(req.prompt)?.[1];
      if (!taskId) return { reasoning: 'no task', actions: [{ type: 'wait' }] };
      const t = taskById(taskId);
      if (me === 'planner') {
        const att = /attached: (art_[0-9a-f]{16})/.exec(req.prompt)?.[1];
        if (att) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: att }] };
        return { reasoning: 'delegate', actions: [{ type: 'send_message', to: ['implementer'], kind: 'DELEGATION', content: 'Implement it.' }] };
      }
      if (me === 'implementer') {
        const created = /Created code artifact (art_[0-9a-f]{16})/.exec(req.prompt)?.[1];
        if (created) return { reasoning: 'report', actions: [{ type: 'send_message', to: ['planner'], kind: 'EVIDENCE', content: 'done', attach: [created] }] };
        return { reasoning: 'implement', actions: [{ type: 'write_code', title: 'impl', code: familyById(t.family).referenceDeliverable(t.variant) }] };
      }
      return { reasoning: 'nothing asked of me', actions: [{ type: 'wait' }] };
    });
    return {
      id: 'scripted',
      async complete(req) {
        n++;
        if (opts.failFromCall !== undefined && n >= opts.failFromCall) throw new CognitionError('Anthropic API 529: overloaded', true);
        if (opts.hangFromCall !== undefined && n >= opts.hangFromCall) return new Promise<never>(() => {}); // process killed mid-run
        return { ...(await inner.complete(req)), costUsd: opts.costPerCall ?? 0 };
      },
    };
  };
}

const stores: EventStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});
const newStore = () => {
  const s = EventStore.open(join(mkdtempSync(join(tmpdir(), 'owsafe-')), 'orgworld.db'));
  stores.push(s);
  return s;
};
const noWait = async () => {};

describe('constitutional constraint Ω in experiments (II-§63)', () => {
  it('without Ω evolution prunes the idle reviewer; with Ω the same proposals are rejected and coverage stays 1', async () => {
    const store = newStore();
    const evolution = { trigger: { kind: 'periodic' as const, everyK: 5 }, minTasksBeforeFirst: 5, historyWindow: 5, bufferRecent: 2, bufferHistorical: 0, delta: 0, fitnessCostPer1kTokens: 1 };
    const res = await runExperiment({
      store,
      provider: specialistWorld(),
      config: {
        experiment: { name: 'omega-smoke' },
        stream: { kind: 'stationary', tasks: 10, seed: 3, phases: [{ id: 'A', mix: { implementation: 1 } }], excludeFamilies: EXCLUDE },
        conditions: [
          { id: 'open', condition: 'evoorg', preset: 'specialist-pool', evolution },
          { id: 'omega', condition: 'evoorg', preset: 'specialist-pool', evolution, constraints: { verifierRequiredFor: ['security'] } },
        ],
        comparisons: [{ a: 'omega', b: 'open' }],
        repetitions: 1,
        controls: { model: { provider: 'scripted', model: 'scripted-world' } },
      },
    });
    const by = Object.fromEntries(res.conditions.map((c) => [c.conditionId, c]));
    const open = by.open!.metrics[0]!;
    const omega = by.omega!.metrics[0]!;
    expect(open.successRate).toBe(1);
    expect(open.mutations.accepted).toBeGreaterThanOrEqual(1);
    expect(open.verification.rate).toBeLessThan(1);
    expect(open.verification.firstUncoveredIndex).toBe(5);
    expect(omega.verification).toMatchObject({ tasks: 10, covered: 10, rate: 1, firstUncoveredIndex: null });
    const rejected = Object.values(store.runState(by.omega!.runs[0]!).evolution.proposals).filter((p) => p.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((p) => /Ω/.test(p.rejectionReason ?? ''))).toBe(true);
    // auditability: every accepted change traces to evidence and a validation record
    expect(open.audit.complete).toBe(true);
    expect(open.audit.accepted).toBe(open.mutations.accepted);
    const cov = res.comparisons.find((c) => c.metric === 'reviewerCoverage')!;
    expect(cov).toMatchObject({ a: 'omega', b: 'open', n: 1 });
    expect(cov.meanDiff).toBeGreaterThan(0);
    expect(by.omega!.reviewerCoverage.mean).toBe(1);
  }, 120_000);

  it('refuses a starting organization that violates its own constraints, and unknown comparison ids', async () => {
    const store = newStore();
    const base = { experiment: { name: 'bad' }, stream: { kind: 'stationary' as const, tasks: 1, phases: [{ id: 'A', mix: { implementation: 1 } }] }, controls: { model: { provider: 'scripted' as const, model: 's' } } };
    await expect(runExperiment({ store, provider: specialistWorld(), config: { ...base, conditions: [{ id: 'g', condition: 'evoorg', preset: 'single-agent', constraints: { verifierRequiredFor: ['security'] } }] } })).resolves.toBeDefined();
    await expect(runExperiment({ store, provider: specialistWorld(), config: { ...base, conditions: [{ id: 'p', condition: 'fixed-specialist', preset: 'specialist-pool', constraints: { maxAgents: 2 } }] } })).rejects.toThrow(/violates its constraints/);
    await expect(runExperiment({ store, provider: specialistWorld(), config: { ...base, conditions: [{ id: 'p', condition: 'fixed-specialist', preset: 'specialist-pool' }], comparisons: [{ a: 'p', b: 'nope' }] } })).rejects.toThrow(/unknown condition/);
  });
});

describe('infrastructure failures in experiments (C-19)', () => {
  const config = (maxTotalUsd: number) => ({
    experiment: { name: `infra-${maxTotalUsd}` },
    stream: { kind: 'stationary' as const, tasks: 3, seed: 5, phases: [{ id: 'A', mix: { implementation: 1 } }], excludeFamilies: EXCLUDE },
    conditions: [{ id: 'fixed', condition: 'fixed-specialist' as const, preset: 'specialist-pool' }],
    repetitions: 1,
    controls: { model: { provider: 'scripted' as const, model: 's' }, maxTotalUsd },
  });

  it('an outage stops the experiment; the failed run is kept, excluded, and re-attempted on resume', async () => {
    const store = newStore();
    // 4 calls per task; call 6 (task 2) and every retry after it fail.
    const first = await runExperiment({ store, config: config(1), provider: specialistWorld({ costPerCall: 0.001, failFromCall: 6 }), retry: { maxAttempts: 3 }, sleep: noWait });
    expect(first.status).toBe('infra-stopped');
    expect(first.conditions[0]!.runs).toEqual([]);
    const base = `${first.experimentId}-fixed-r1`;
    const failed = store.events(base).find((e) => e.type === 'RUN_FAILED')!;
    expect(failed.payload).toMatchObject({ infrastructure: true });
    expect(store.events(base, { types: ['AGENT_FAILED'] })).toHaveLength(0); // never scored as the agents' failure
    const spent1 = experimentSpendUsd(store, first.experimentId);
    expect(spent1).toBeCloseTo(0.005, 9);

    const second = await runExperiment({ store, config: config(1), provider: specialistWorld({ costPerCall: 0.001 }), sleep: noWait });
    expect(second.status).toBe('completed');
    expect(second.conditions[0]!.runs).toEqual([`${base}-a2`]);
    expect(second.conditions[0]!.metrics[0]!.tasks).toBe(3);
    expect(second.notes.join('\n')).toMatch(/excluded from aggregates \(infrastructure failure/);
    expect(store.getRun(base)!.status).toBe('failed'); // kept, never overwritten
    expect(experimentSpendUsd(store, first.experimentId)).toBeCloseTo(spent1 + 0.012, 9);
  }, 60_000);

  it('the $ ceiling counts money spent before a resume', async () => {
    const store = newStore();
    const first = await runExperiment({ store, config: config(0.006), provider: specialistWorld({ costPerCall: 0.001, failFromCall: 6 }), retry: { maxAttempts: 2 }, sleep: noWait });
    expect(first.status).toBe('infra-stopped');
    const second = await runExperiment({ store, config: config(0.006), provider: specialistWorld({ costPerCall: 0.001 }), sleep: noWait });
    expect(second.status).toBe('budget-stopped');
    // 0.005 already spent → one task (0.004) crosses the 0.006 ceiling; without the resume fix it would run two.
    expect(second.conditions[0]!.metrics[0]!.tasks).toBe(1);
  }, 60_000);
});

describe('time windows and readings (lab/daily.sh)', () => {
  const config = {
    experiment: { name: 'window' },
    stream: { kind: 'stationary' as const, tasks: 3, seed: 5, phases: [{ id: 'A', mix: { implementation: 1 } }], excludeFamilies: EXCLUDE },
    conditions: [{ id: 'fixed', condition: 'fixed-specialist' as const, preset: 'specialist-pool' }],
    repetitions: 2,
    controls: { model: { provider: 'scripted' as const, model: 's' } },
  };

  it('a closed window starts no run; the next window resumes and finishes', async () => {
    const store = newStore();
    const closed = await runExperiment({ store, config, provider: specialistWorld(), stopAt: Date.now() - 1 });
    expect(closed.status).toBe('time-stopped');
    expect(store.listRuns()).toHaveLength(0);
    expect(closed.notes.join('\n')).toMatch(/not started \(the window has closed\)/);
    const open = await runExperiment({ store, config, provider: specialistWorld(), stopAt: Date.now() + 3_600_000 });
    expect(open.status).toBe('completed');
    expect(open.conditions[0]!.runs).toHaveLength(2);
  }, 60_000);

  it('stops between runs when the longest completed run would not fit, and readings report it', async () => {
    const store = newStore();
    const stopAt = Date.now() + 3_600_000;
    const res = await runExperiment({ store, config, provider: specialistWorld(), stopAt, now: () => stopAt - 1 });
    expect(res.status).toBe('time-stopped');
    expect(res.conditions[0]!.runs).toEqual([`${res.experimentId}-fixed-r1`]);
    expect(res.notes.join('\n')).toMatch(/would not finish in time/);
    const r = experimentReadings(store, config);
    expect(r).toMatchObject({ experimentId: res.experimentId, planned: 2, completed: 1, done: false, scripted: true });
    expect(r.lockedAt).not.toBeNull();
    expect(r.slots[0]).toMatchObject({ pending: false, status: 'completed', attempt: 1, tasks: 3, excluded: [], modelCallFailures: 0, agentFailures: 0 });
    expect(r.slots[0]!.wallSeconds).toBeGreaterThanOrEqual(0);
    expect(r.slots[1]).toMatchObject({ slot: `${res.experimentId}-fixed-r2`, pending: true, status: null, tasks: null });
    expect(r.conditions[0]!.runs).toEqual([`${res.experimentId}-fixed-r1`]);
    expect(r.allRunIds).toEqual([`${res.experimentId}-fixed-r1`]);
    const csv = readingsCsv(store, config).trim().split('\n');
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(`${res.experimentId}-fixed-r1`);
  }, 60_000);

  it('a run cut off mid-way is kept, excluded, and re-run from the start next time', async () => {
    const store = newStore();
    // 4 calls per task: the first run completes task 1, then its 6th call never returns (the process is killed).
    const base = `${experimentReadings(store, config).experimentId}-fixed-r1`;
    void runExperiment({ store, config, provider: specialistWorld({ hangFromCall: 6 }) });
    for (let i = 0; i < 200 && !(store.getRun(base) && store.events(base, { types: ['TASK_COMPLETED'] }).length); i++) await new Promise((r) => setTimeout(r, 50));
    const exp = experimentReadings(store, config);
    expect(exp.slots[0]).toMatchObject({ pending: true, runId: `${base}-a2`, attempt: 2 });
    expect(exp.slots[0]!.excluded).toMatchObject([{ runId: base, reason: 'interrupted (status running)', tasks: 1 }]);
    const next = await runExperiment({ store, config, provider: specialistWorld() });
    expect(next.status).toBe('completed');
    expect(next.conditions[0]!.runs).toEqual([`${base}-a2`, `${exp.experimentId}-fixed-r2`]);
    const after = experimentReadings(store, config);
    expect(after).toMatchObject({ completed: 2, done: true });
    expect(after.slots[0]).toMatchObject({ runId: `${base}-a2`, attempt: 2, status: 'completed', tasks: 3 });
    expect(store.getRun(base)!.status).toBe('running'); // kept as it was, never overwritten
    expect(after.allRunIds).toEqual([base, `${base}-a2`, `${exp.experimentId}-fixed-r2`].sort());
  }, 60_000);
});
