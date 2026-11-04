import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { presetGenome, reduceEvents } from '@orgworld/core';
import { EventStore } from '@orgworld/store';
import { CognitionError, ScriptedProvider, type CognitionRequest } from '@orgworld/cognition';
import { familyById } from '@orgworld/bench';
import { backoffMs, buildRunConfig, createRun, DEFAULT_RETRY, InfrastructureError, OrgRunner, parseAction, type RunnerOptions } from '../src/index.ts';

/*
 * MECHANICS TESTS with the SCRIPTED provider (test-only, labelled provider:"scripted").
 * They pin runtime rules; they are NOT evidence that real agents collaborate — see *.live.test.ts for that.
 */

const stores: EventStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});
const newStore = () => {
  const s = EventStore.open(join(mkdtempSync(join(tmpdir(), 'owrt-')), 'orgworld.db'));
  stores.push(s);
  return s;
};

const fam = familyById('impl-rle');
const task = fam.generate(0);
const solution = fam.referenceDeliverable(0);
const lastArt = (p: string) => [...p.matchAll(/(art_[0-9a-f]{16})/g)].map((m) => m[1]!).pop();
const holder: { runner?: OrgRunner } = {};
const codeArts = (by?: string) => Object.values(holder.runner!.state.artifacts).filter((a) => a.kind === 'code' && (!by || a.authorId === by));
const agentOf = (r: CognitionRequest) => /agent id "([^"]+)"/.exec(r.system)?.[1];

function setup(preset: string, script: ConstructorParameters<typeof ScriptedProvider>[0], overrides: Record<string, unknown> = {}, runnerOpts: Partial<RunnerOptions> = {}) {
  const store = newStore();
  const genome = presetGenome(preset);
  const cfg = buildRunConfig({
    runId: `run_${preset}_${Math.random().toString(36).slice(2, 8)}`,
    mode: 'sandbox',
    kind: 'stream',
    condition: 'fixed-generalist',
    genome,
    model: { provider: 'scripted', model: 'scripted-test' },
    budget: {},
    reward: {},
    seeds: {},
    features: {},
    evolution: {},
    policy: {},
    ...overrides,
  });
  createRun(store, cfg);
  const provider = new ScriptedProvider(script);
  const runner = new OrgRunner({ store, provider, runId: cfg.runId, ...runnerOpts });
  holder.runner = runner;
  runner.instantiate(genome, 'test');
  runner.start();
  return { store, runner, provider, cfg };
}

describe('single agent (B0) mechanics', () => {
  it('write → check → submit; hidden evaluation; state == replay', async () => {
    const { store, runner } = setup('single-agent', (_req, i) => {
      if (i === 0) return { reasoning: 'implement', actions: [{ type: 'write_code', title: 'rle', code: solution }] };
      if (i === 1) return { reasoning: 'check', actions: [{ type: 'run_checks', artifactId: codeArts()[0]!.artifactId }] };
      return { reasoning: 'ship', actions: [{ type: 'submit', artifactId: codeArts()[0]!.artifactId }] };
    });
    const out = await runner.runTask({ kind: 'bench', task });
    expect(out).toMatchObject({ success: true, score: 1, evaluated: true, forced: false, stopReason: 'submitted', submittedBy: 'solo' });
    const events = store.events(runner.runId);
    const types = events.map((e) => e.type);
    for (const t of ['TASK_CREATED', 'MODEL_CALL_STARTED', 'MODEL_CALL_COMPLETED', 'ARTIFACT_CREATED', 'EXPERIMENT_STARTED', 'EXPERIMENT_COMPLETED', 'EVALUATION_COMPLETED', 'REWARD_RECORDED', 'TASK_COMPLETED', 'BUDGET_UPDATED'] as const) expect(types).toContain(t);
    const check = events.find((e) => e.type === 'EXPERIMENT_COMPLETED')!;
    expect(check.payload).toMatchObject({ passed: 2, total: 2 });
    expect(JSON.parse(JSON.stringify(reduceEvents(events)))).toEqual(JSON.parse(JSON.stringify(runner.state)));
    expect(runner.state.costs.total.calls).toBe(3);
    expect(runner.state.agents.solo!.modelProvider).toBe('scripted');
  });
});

describe('multi-agent mechanics (generalists-4)', () => {
  it('delegation, edge enforcement, knowledge gating, submission by entry', async () => {
    const { store, runner } = setup('generalists-4', (req) => {
      const me = agentOf(req);
      if (me === 'a1' && !req.prompt.includes('attached:')) return { reasoning: 'delegate', actions: [{ type: 'send_message', to: ['a2'], kind: 'DELEGATION', content: 'Please implement the module.' }] };
      if (me === 'a1') return { reasoning: 'submit what a2 sent', actions: [{ type: 'submit', artifactId: /attached: (art_[0-9a-f]{16})/.exec(req.prompt)![1] }] };
      if (me === 'a2' && !req.prompt.includes('Created code artifact'))
        return { reasoning: 'write and try to talk to a3 (no edge)', actions: [{ type: 'write_code', title: 'impl', code: solution }, { type: 'send_message', to: ['a3'], kind: 'DIRECT_MESSAGE', content: 'hi' }] };
      return { reasoning: 'send back', actions: [{ type: 'send_message', to: ['a1'], kind: 'EVIDENCE', content: 'done', attach: [lastArt(req.prompt)] }] };
    });
    const out = await runner.runTask({ kind: 'bench', task });
    expect(out.success).toBe(true);
    expect(out.submittedBy).toBe('a1');
    const s = runner.state;
    const rejected = s.rejectedActions.map((r) => `${r.agentId}:${r.action}`);
    expect(rejected).toContain('a2:send_message'); // a2 → a3 has no edge
    expect(s.tasks[out.taskId]!.assignedAgents.sort()).toEqual(['a1', 'a2']);
    // a3/a4 never learned anything about the task
    expect(s.agents.a3!.knownArtifactIds).toEqual([]);
    expect(s.agents.a3!.knownMessageIds).toEqual([]);
    // every MESSAGE_SENT is along a genome edge
    for (const e of store.events(runner.runId, { types: ['MESSAGE_SENT'] })) {
      const p = e.payload as { from: string; to: string[] };
      for (const t of p.to) expect(runner.genome.edges.some((x) => x.from === p.from && x.to === t)).toBe(true);
    }
  });

  it('cannot submit an artifact the agent has not received', async () => {
    const { runner } = setup('generalists-4', (req, i) => {
      const me = agentOf(req);
      if (i === 0) return { reasoning: '', actions: [{ type: 'send_message', to: ['a2'], kind: 'DELEGATION', content: 'go' }] };
      if (me === 'a2') return codeArts('a2').length ? { reasoning: '', actions: [{ type: 'wait' }] } : { reasoning: '', actions: [{ type: 'write_code', title: 'x', code: solution }] };
      return { reasoning: '', actions: [{ type: 'submit', artifactId: codeArts('a2')[0]?.artifactId ?? 'art_0000000000000000' }] };
    });
    const res = await runner.runTask({ kind: 'bench', task });
    const reasons = runner.state.rejectedActions.filter((r) => r.agentId === 'a1' && r.action === 'submit').map((r) => r.reason);
    expect(reasons.some((r) => r.startsWith('unknown artifact'))).toBe(true);
    expect(res.forced).toBe(true); // newest code artifact evaluated under the uniform forced-submission rule
  });
});

describe('budgets (III Control 1–3)', () => {
  it('per-task call budget stops work and records BUDGET_EXHAUSTED; forced evaluation flagged', async () => {
    const { runner } = setup('single-agent', () => ({ reasoning: 'loop', actions: [{ type: 'write_code', title: 'v', code: 'module.exports = {}' }] }), {
      budget: { perTask: { maxTokens: 1_000_000, maxCalls: 2, maxUsd: 1, reserveTokens: 0 } },
    });
    const out = await runner.runTask({ kind: 'bench', task });
    expect(out.stopReason).toBe('budget');
    expect(out.calls).toBe(2);
    expect(out.forced).toBe(true);
    expect(runner.state.timeline.some((t) => t.type === 'BUDGET_EXHAUSTED')).toBe(true);
  });
});

describe('decisions (build §14)', () => {
  it('MAJORITY decision collects real votes from contacts and records provenance', async () => {
    const { runner } = setup('specialist-pool', (req) => {
      if (req.purpose.startsWith('vote')) return { option: agentOf(req) === 'implementer' ? 'B' : 'A', rationale: `${agentOf(req)} reasons` };
      if (agentOf(req) === 'planner' && !req.prompt.includes('resolved by')) return { reasoning: 'decide', actions: [{ type: 'propose_decision', question: 'Which approach?', options: ['A', 'B'], recommendation: 'A' }] };
      return { reasoning: 'stop', actions: [{ type: 'wait' }] };
    });
    await runner.runTask({ kind: 'bench', task });
    const d = Object.values(runner.state.decisions)[0]!;
    expect(d.policy).toBe('MAJORITY');
    expect(d.votes.map((v) => `${v.agentId}:${v.option}`)).toEqual(['planner:A', 'implementer:B']); // planner only reaches implementer
    expect(d.outcome).toMatchObject({ chosen: 'A', opposition: ['implementer'] });
  });
});

describe('memory (ADR-007, build §15, Phase 7)', () => {
  it('org memory written in run A is retrieved in run B with provenance; private memory is not', async () => {
    const shared = newStore();
    const mk = (script: ConstructorParameters<typeof ScriptedProvider>[0]) => {
      const genome = presetGenome('generalists-4');
      const cfg = buildRunConfig({ runId: `run_${Math.random().toString(36).slice(2)}`, mode: 'sandbox', kind: 'stream', condition: 'objective', genome, model: { provider: 'scripted', model: 's' }, budget: {}, reward: {}, seeds: {}, features: { crossTaskMemory: true }, evolution: {}, policy: {} });
      createRun(shared, cfg);
      const r = new OrgRunner({ store: shared, provider: new ScriptedProvider(script), runId: cfg.runId });
      r.instantiate(genome, 'test');
      r.start();
      return r;
    };
    const A = mk((_r, i) => i > 0 ? { reasoning: 'done', actions: [{ type: 'wait' }] } : ({
      reasoning: 'learn',
      actions: [
        { type: 'remember', scope: 'org', kind: 'semantic', content: 'Run length encoding tasks: runs longer than 9 need multi-digit counts.' },
        { type: 'remember', scope: 'private', kind: 'episodic', content: 'Run length encoding secret note for a1 only' },
        { type: 'write_code', title: 'x', code: solution },
      ],
    }));
    await A.runTask({ kind: 'bench', task });
    const B = mk(() => ({ reasoning: 'done', actions: [{ type: 'wait' }] }));
    await B.runTask({ kind: 'bench', task: fam.generate(1) });
    const retrieved = B.state.timeline.length && B.store.events(B.runId, { types: ['MEMORY_RETRIEVED'] })[0]!.payload as { itemIds: string[]; deniedItemIds: string[] };
    const items = (retrieved as { itemIds: string[] }).itemIds;
    // Entry agent a1 is the SAME persistent agent across runs: it recalls the org lesson and its own private note.
    const scopes = items.map((id) => A.memory.all().find((m) => m.memoryId === id)!.scope).sort();
    expect(scopes).toEqual(['org', 'private']);
    const mem = A.memory.all().find((m) => m.scope === 'org')!;
    expect(mem.provenance.runId).toBe(A.runId);
    expect(mem.provenance.sourceEventIds.length).toBeGreaterThan(0);
    expect(mem.provenance.genomeId).toBe('preset-generalists-4');
    // a1 in run B is the same role-agent id, but private memory belongs to a1 → visible to a1 only.
    const p = A.memory.all().find((m) => m.scope === 'private')!;
    expect(B.memory.canRead(p, 'a2', null, 'org')).toBe(false);
    expect(B.memory.canRead(p, 'a1', null, 'org')).toBe(true);
  });
});

describe('failure handling (build §59)', () => {
  it('a non-retryable agent-level cognition failure of the entry agent fails the task visibly', async () => {
    const { runner } = setup('single-agent', () => {
      throw new CognitionError('model reply could not be parsed', false);
    });
    const out = await runner.runTask({ kind: 'bench', task });
    expect(out.stopReason).toBe('entry-failed');
    expect(runner.state.timeline.some((t) => t.type === 'AGENT_FAILED')).toBe(true);
    expect(runner.state.tasks[out.taskId]!.status).toBe('FAILED');
  });
});

describe('model-service failures are infrastructure, not agent behaviour (C-19)', () => {
  const recorder = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  it('backs off exponentially and recovers from transient errors without failing the task', async () => {
    const { waits, sleep } = recorder();
    const { runner } = setup(
      'single-agent',
      (_req, i) => {
        if (i < 2) throw new CognitionError('Anthropic API 529: overloaded', true);
        if (i === 2) return { reasoning: 'implement', actions: [{ type: 'write_code', title: 'rle', code: solution }] };
        return { reasoning: 'ship', actions: [{ type: 'submit', artifactId: codeArts()[0]!.artifactId }] };
      },
      {},
      { sleep },
    );
    const out = await runner.runTask({ kind: 'bench', task });
    expect(out).toMatchObject({ success: true, stopReason: 'submitted' });
    expect(waits).toEqual([2_000, 4_000]);
    const failed = runner.store.events(runner.runId, { types: ['MODEL_CALL_FAILED'] });
    expect(failed.map((e) => (e.payload as { error: string }).error.slice(0, 15))).toEqual(['[attempt 1/10] ', '[attempt 2/10] ']);
    expect(runner.state.timeline.some((t) => t.type === 'AGENT_FAILED')).toBe(false);
  });

  it('honours a longer server retry-after', async () => {
    const { waits, sleep } = recorder();
    const { runner } = setup(
      'single-agent',
      (_req, i) => {
        if (i === 0) throw new CognitionError('Anthropic API 429: rate limited', true, { retryAfterMs: 30_000 });
        if (i === 1) return { reasoning: 'implement', actions: [{ type: 'write_code', title: 'rle', code: solution }] };
        return { reasoning: 'ship', actions: [{ type: 'submit', artifactId: codeArts()[0]!.artifactId }] };
      },
      {},
      { sleep },
    );
    await runner.runTask({ kind: 'bench', task });
    expect(waits).toEqual([30_000]);
  });

  it('exhausted retries stop the run instead of scoring a failed task', async () => {
    const { waits, sleep } = recorder();
    const { runner } = setup(
      'single-agent',
      () => {
        throw new Error('fetch failed: ECONNRESET');
      },
      {},
      { sleep, retry: { maxAttempts: 4 } },
    );
    await expect(runner.runTask({ kind: 'bench', task })).rejects.toBeInstanceOf(InfrastructureError);
    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(runner.store.events(runner.runId, { types: ['MODEL_CALL_FAILED'] })).toHaveLength(4);
    const types = runner.store.events(runner.runId).map((e) => e.type);
    expect(types).not.toContain('AGENT_FAILED');
    expect(types).not.toContain('TASK_COMPLETED');
    expect(types).not.toContain('TASK_FAILED');
  });

  it('a fatal configuration error (auth, billing, bad request) stops at once without retrying', async () => {
    const { waits, sleep } = recorder();
    const { runner } = setup(
      'single-agent',
      () => {
        throw new CognitionError('Anthropic API 401: invalid x-api-key', false, { fatal: true });
      },
      {},
      { sleep },
    );
    await expect(runner.runTask({ kind: 'bench', task })).rejects.toBeInstanceOf(InfrastructureError);
    expect(waits).toEqual([]);
    expect(runner.store.events(runner.runId, { types: ['MODEL_CALL_FAILED'] })).toHaveLength(1);
  });

  it('default policy waits about five minutes in total and caps single waits', () => {
    const waits = Array.from({ length: DEFAULT_RETRY.maxAttempts - 1 }, (_, i) => backoffMs(DEFAULT_RETRY, i + 1));
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
    expect(backoffMs(DEFAULT_RETRY, 1, 10 * 60_000)).toBe(5 * 60_000);
  });
});

describe('action parsing', () => {
  it('validates per-type fields and strips empty flat fields', () => {
    expect(parseAction({ type: 'send_message', to: ['x'], kind: 'QUESTION', content: 'hi', code: '', title: null }).ok).toBe(true);
    expect(parseAction({ type: 'send_message', to: [], kind: 'QUESTION', content: 'hi' })).toMatchObject({ ok: false });
    expect(parseAction({ type: 'launch_missiles' })).toMatchObject({ ok: false });
  });
});
