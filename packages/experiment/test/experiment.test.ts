import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStore } from '@orgworld/store';
import { ScriptedProvider, type CognitionRequest } from '@orgworld/cognition';
import { taskById } from '@orgworld/bench';
import { familyById } from '@orgworld/bench';
import { OrgPolicy } from '@orgworld/evoorg';
import { resultsCsv, runExperiment } from '../src/index.ts';

/*
 * PIPELINE TEST with the SCRIPTED provider (deterministic, free, labelled scripted — NOT a research result).
 * Scripted world rule: implementation tasks are always solved; security tasks are solved only when the entry agent
 * can consult an agent whose role is "Security Reviewer". So evolution has something real (in this toy world) to find.
 */
function scriptedWorld() {
  return new ScriptedProvider((req: CognitionRequest) => {
    if (req.purpose.startsWith('design')) return { agents: [{ id: 'p', roleId: 'planner' }, { id: 's', roleId: 'security_reviewer' }], edges: [{ from: 'p', to: 's', kind: 'delegate' }, { from: 's', to: 'p', kind: 'inform' }], entry: 'p' };
    if (req.purpose.startsWith('vote') || req.purpose.startsWith('meeting')) return { option: 'x', rationale: 'n/a', kind: 'STATUS_UPDATE', content: 'n/a' };
    const taskId = /TASK (\S+) —/.exec(req.prompt)?.[1];
    if (!taskId) return { reasoning: 'no task', actions: [{ type: 'wait' }] };
    const task = taskById(taskId);
    const ref = familyById(task.family).referenceDeliverable(task.variant);
    if (/Role: Security Reviewer/.test(req.system)) return { reasoning: 'advise', actions: [{ type: 'send_message', to: [/You can message ONLY: (\w+)/.exec(req.system)![1]], kind: 'ANSWER', content: 'HINT: resolve against base and reject escapes, absolute and drive paths, NUL bytes.' }] };
    const created = /Created code artifact (art_[0-9a-f]{16})/.exec(req.prompt)?.[1];
    if (created) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: created }] };
    if (task.category === 'security') {
      if (req.prompt.includes('HINT:')) return { reasoning: 'apply advice', actions: [{ type: 'write_code', title: 'fixed', code: ref }] };
      const spec = /(\w+) \(Security Reviewer; /.exec(req.system)?.[1];
      if (spec) return { reasoning: 'ask specialist', actions: [{ type: 'send_message', to: [spec], kind: 'QUESTION', content: 'How do I fix this safely?' }] };
      return { reasoning: 'best effort', actions: [{ type: 'write_code', title: 'naive', code: task.starterCode }] };
    }
    return { reasoning: 'implement', actions: [{ type: 'write_code', title: 'impl', code: ref }] };
  });
}

describe('experiment pipeline (scripted)', () => {
  it('runs conditions on identical streams; EvoOrg evolves a validated specialist; costs attributed; CSV exported', async () => {
    const store = EventStore.open(join(mkdtempSync(join(tmpdir(), 'owexp-')), 'orgworld.db'));
    const res = await runExperiment({
      store,
      provider: scriptedWorld,
      config: {
        experiment: { name: 'pipeline-smoke' },
        stream: { kind: 'stationary', tasks: 20, seed: 3, phases: [{ id: 'A', mix: { implementation: 0.5, security: 0.5 } }], excludeFamilies: ['impl-expr-eval', 'impl-interval-merge', 'impl-lru-cache'] },
        conditions: [
          { id: 'fixed', condition: 'fixed-generalist', preset: 'generalists-4' },
          { id: 'pertask', condition: 'per-task-adaptive', preset: 'specialist-pool' },
          { id: 'evoorg', condition: 'evoorg', preset: 'generalists-4', evolution: { trigger: { kind: 'periodic', everyK: 10 }, minTasksBeforeFirst: 10, bufferRecent: 3, bufferHistorical: 1, delta: 0.05 } },
          { id: 'random', condition: 'random-evolution', preset: 'generalists-4', evolution: { trigger: { kind: 'periodic', everyK: 10 }, minTasksBeforeFirst: 10 } },
        ],
        repetitions: 1,
        controls: { model: { provider: 'scripted', model: 'scripted-world' } },
      },
    });
    const by = Object.fromEntries(res.conditions.map((c) => [c.conditionId, c]));
    expect(res.scripted).toBe(true);
    expect(res.notes.join(' ')).toMatch(/NOT research results/);
    // identical task sequences across conditions
    const seq = (id: string) => store.events(by[id]!.runs[0]!, { types: ['TASK_CREATED'] }).map((e) => (e.payload as { family?: string }).family);
    expect(seq('evoorg')).toEqual(seq('fixed'));
    const evo = by.evoorg!.metrics[0]!;
    expect(evo.generation).toBeGreaterThanOrEqual(1);
    expect(evo.mutations.accepted).toBeGreaterThanOrEqual(1);
    expect(evo.lifetime.byCategory.validation.calls).toBeGreaterThan(0); // shadow validation cost counted (III Control 4)
    const state = store.runState(by.evoorg!.runs[0]!);
    const accepted = Object.values(state.evolution.proposals).find((p) => p.status === 'accepted')!;
    expect(accepted.validation!.method).toBe('paired-reexecution');
    expect(accepted.validation!.candidateScore!).toBeGreaterThan(accepted.validation!.incumbentScore! + 0.05);
    expect(Object.keys(accepted.proposal.evidence).length).toBeGreaterThan(0);
    // EvoOrg's second half beats the fixed generalists (who can never solve security in this toy world)
    expect(evo.successRate).toBeGreaterThan(by.fixed!.metrics[0]!.successRate);
    // random evolution accepts without validation
    expect(by.random!.metrics[0]!.lifetime.byCategory.validation.calls).toBe(0);
    // per-task designer calls are controller cost
    expect(by.pertask!.metrics[0]!.lifetime.byCategory.controller.calls).toBe(20);
    const csv = resultsCsv(res);
    expect(csv.split('\n')[0]).toContain('cumulative_reward');
    expect(csv.trim().split('\n')).toHaveLength(5);
    // locked config cannot change
    expect(store.getExperiment(res.experimentId)!.lockedAt).not.toBeNull();
    store.close();
  }, 120_000);

  it('refuses unimplemented literature baselines instead of faking them', async () => {
    const store = EventStore.open(join(mkdtempSync(join(tmpdir(), 'owexp-')), 'orgworld.db'));
    await expect(
      runExperiment({ store, provider: scriptedWorld, config: { experiment: { name: 'x' }, stream: { kind: 'stationary', tasks: 1, phases: [{ id: 'A', mix: { implementation: 1 } }] }, conditions: [{ id: 't', condition: 'tacomas-style', preset: 'generalists-4' }], controls: { model: { provider: 'scripted', model: 's' } } } }),
    ).rejects.toThrow(/not implemented/);
    store.close();
  });
});

describe('Stage-1 policy evaluation (build Phase 9)', () => {
  it('Thompson bandit has lower regret than the random baseline on a synthetic environment (10 seeds)', () => {
    const P: Record<string, number> = { a: 0.2, b: 0.5, c: 0.8 };
    const regret = (kind: 'thompson' | 'random', seed: number) => {
      const pol = new OrgPolicy(kind, ['a', 'b', 'c'], seed);
      let r = 0, s = seed;
      const u = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      for (let t = 0; t < 300; t++) {
        const { chosen } = pol.select('x');
        pol.update('x', chosen, u() < P[chosen]!);
        r += 0.8 - P[chosen]!;
      }
      return r;
    };
    const seeds = Array.from({ length: 10 }, (_, i) => i + 1);
    const ts = seeds.reduce((a, s) => a + regret('thompson', s), 0) / 10;
    const rs = seeds.reduce((a, s) => a + regret('random', s), 0) / 10;
    expect(ts).toBeLessThan(rs * 0.5);
    expect(new OrgPolicy('thompson', ['a'], 1).select('x').label).toBe('bandit policy');
    expect(new OrgPolicy('heuristic', ['a', 'b'], 1, { sec: 'b' }).select('sec').chosen).toBe('b');
  });
});
