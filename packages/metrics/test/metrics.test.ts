import { describe, expect, it } from 'vitest';
import { applyMutation, presetGenome, reduceEvents, ROLE_LIBRARY } from '@orgworld/core';
import type { EventDraft } from '@orgworld/protocol';
import { adaptationHalfLife, ci95, hedgesG, pairedBootstrap, recallTime, runMetrics, specializationIndex, structuralChurn, topology, type TaskRecord } from '../src/index.ts';
import { buildEvents } from '../../core/test/helpers.ts';
import { goldenDrafts, GOLDEN_RUN_ID } from '../../core/test/fixtures/golden-fixture.ts';

const rec = (succ: number[], phases: string[]): TaskRecord[] =>
  succ.map((s, i) => ({ index: i, taskId: `t${i}`, category: 'c', family: 'f', phaseId: phases[i]!, evaluated: true, success: s === 1, score: s, reward: s, tokens: 100, calls: 1, usd: 0.01, messages: 0, forced: false, genomeId: 'g' }));

describe('Adaptation Half-Life (II-§29) — hand-computed', () => {
  it('pre=1, drops to 0, recovers', () => {
    // 4 successes, shift, then 0,0,1,1,1,1 with window 2
    const r = rec([1, 1, 1, 1, 0, 0, 1, 1, 1, 1], ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B', 'B']);
    const h = adaptationHalfLife(r, 4, 2);
    // post rolling (w=2): [0, 0, .5, 1, 1, 1]; P_post = 0; target = .5; first k ≥ argmin(0) with roll ≥ .5 → k=2
    expect(h).toMatchObject({ pre: 1, post: 0, target: 0.5, halfLife: 2, drop: 1 });
  });
  it('no drop → 0; never recovers → null (censored)', () => {
    expect(adaptationHalfLife(rec([1, 1, 1, 1], ['A', 'A', 'B', 'B']), 2, 2).halfLife).toBe(0);
    expect(adaptationHalfLife(rec([1, 1, 0, 0, 0], ['A', 'A', 'B', 'B', 'B']), 2, 2).halfLife).toBeNull();
  });
});

describe('recall time (III stream 4)', () => {
  it('counts tasks until the earlier SR is regained', () => {
    const r = rec([0, 1, 1, 0, 0, 0, 1, 1], ['A', 'A', 'A', 'B', 'B', 'A2', 'A2', 'A2']);
    // first-occurrence tail (w=2): [1,1] → goal 1; second occurrence rolling w=2: [0, .5, 1] → k=2
    expect(recallTime(r, 'A', 'A2', 2)).toBe(2);
  });
});

describe('Specialization Index (II-§31)', () => {
  it('is 1 for a pure specialist, 0 for a uniform generalist', () => {
    const s = reduceEvents(buildEvents(GOLDEN_RUN_ID, goldenDrafts()));
    s.agents.a1!.stats.workByCategory = { impl: 10, sec: 0 };
    s.agents.a2!.stats.workByCategory = { impl: 5, sec: 5 };
    const si = specializationIndex(s, 2);
    expect(si.a1).toBeCloseTo(1);
    expect(si.a2).toBeCloseTo(0);
  });
});

describe('topology (II-§32)', () => {
  it('star of 4 has centralization 1 and depth 1', () => {
    const t = topology(presetGenome('generalists-4'));
    expect(t).toMatchObject({ agents: 4, edges: 6, centralization: 1, depthFromEntry: 1 });
    expect(t.density).toBeCloseTo(6 / 12);
    expect(t.avgPathLength).toBeCloseTo((3 * 1 + 3 * (1 + 2 + 2)) / 12);
  });
});

describe('structural churn (I-§35)', () => {
  it('sums genome diffs across mutations', () => {
    const g0 = presetGenome('generalists-4');
    const g1 = applyMutation(g0, { type: 'CHANGE_ROLE', agentId: 'a2', role: ROLE_LIBRARY.tester! }, { createdBy: 'p', id: 'g1' });
    const g2 = applyMutation(g1, { type: 'REMOVE_EDGE', from: 'a1', to: 'a3' }, { createdBy: 'p', id: 'g2' });
    const drafts: EventDraft[] = [
      { type: 'ORGANIZATION_INSTANTIATED', actorId: 'r', payload: { genome: g0, reason: 'x' } },
      { type: 'ORGANIZATION_MUTATED', actorId: 'c', payload: { proposalId: null, fromGenomeId: g0.id, toGenomeId: g1.id, generation: 1, mutation: { type: 'CHANGE_ROLE', agentId: 'a2', role: ROLE_LIBRARY.tester! }, genome: g1 } },
      { type: 'ORGANIZATION_MUTATED', actorId: 'c', payload: { proposalId: null, fromGenomeId: g1.id, toGenomeId: g2.id, generation: 2, mutation: { type: 'REMOVE_EDGE', from: 'a1', to: 'a3' }, genome: g2 } },
    ];
    expect(structuralChurn(buildEvents('r', drafts), 50)).toEqual({ units: 2, per100: 4 });
  });
});

describe('run metrics over the golden fixture', () => {
  it('computes CR, SR, lifetime cost', () => {
    const m = runMetrics(buildEvents(GOLDEN_RUN_ID, goldenDrafts()));
    expect(m).toMatchObject({ tasks: 1, successes: 1, successRate: 1, cumulativeReward: 1, scripted: true, contaminated: false });
    expect(m.lifetime.calls).toBe(2);
    expect(m.costPerSuccessTokens).toBe(2400);
  });
});

describe('statistics (II-§41)', () => {
  it('ci95 matches hand computation', () => {
    const c = ci95([1, 2, 3, 4, 5]);
    expect(c.mean).toBe(3);
    expect(c.sd).toBeCloseTo(Math.sqrt(2.5));
    expect(c.hi - c.mean).toBeCloseTo((2.776 * Math.sqrt(2.5)) / Math.sqrt(5), 4);
  });
  it('paired bootstrap is deterministic and brackets the true difference', () => {
    const a = [1, 1, 1, 0, 1, 1, 1, 1, 0, 1];
    const b = [0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
    const r1 = pairedBootstrap(a, b, { seed: 7 });
    expect(r1).toEqual(pairedBootstrap(a, b, { seed: 7 }));
    expect(r1.meanDiff).toBeCloseTo(0.4);
    expect(r1.lo).toBeLessThanOrEqual(0.4);
    expect(r1.hi).toBeGreaterThanOrEqual(0.4);
  });
  it('hedges g sign and zero-variance case', () => {
    expect(hedgesG([3, 4, 5], [1, 2, 3])).toBeGreaterThan(0);
    expect(hedgesG([1, 1], [1, 1])).toBe(0);
  });
});
