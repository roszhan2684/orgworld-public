import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// lab/lab.mjs: the helper behind lab/daily.sh (nightly sessions). No model calls; temp files only.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lab = (args: string[], env: Record<string, string> = {}) => execFileSync('node', [join(root, 'lab/lab.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const tmp = () => mkdtempSync(join(tmpdir(), 'owlab-'));
const write = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
const hm = (d: Date) => d.toTimeString().slice(0, 5);

describe('lab helper', () => {
  it('window: inside and outside the session window, including one that crosses midnight', () => {
    const now = Date.now();
    const inside = lab(['window', hm(new Date(now - 3_600_000)), hm(new Date(now + 3_600_000)), hm(new Date(now + 7_200_000))]);
    expect(inside).toMatch(/^IN_WINDOW=1\nSECS_TO_HARD=\d+\n$/);
    expect(Number(/SECS_TO_HARD=(\d+)/.exec(inside)![1])).toBeGreaterThan(7_000);
    expect(lab(['window', hm(new Date(now + 3_600_000)), hm(new Date(now + 7_200_000)), hm(new Date(now + 9_000_000))])).toMatch(/^IN_WINDOW=0/);
  });

  it('provenance: records the first environment, then flags runtime changes and blocks new weights or code', () => {
    const d = tmp();
    const state = join(d, 'state.json');
    const cur = join(d, 'cur.json');
    const env = { bundleSha256: 'b1', model: 'qwen2.5-coder:7b', modelDigest: 'w1', ollamaVersion: '0.20.0', nodeVersion: 'v22.14.0', macos: '26.6', machine: 'm' };
    const check = (e: object, extra: Record<string, string> = {}) => (write(cur, e), JSON.parse(lab(['provenance', state, cur, '2026-11-06'], extra)));
    expect(check(env)).toEqual({ status: 'new', changes: [] });
    expect(check(env).status).toBe('same');
    expect(check({ ...env, ollamaVersion: '0.21.0' })).toMatchObject({ status: 'deviation', changes: [{ field: 'ollamaVersion', from: '0.20.0', to: '0.21.0', blocking: false }] });
    expect(check({ ...env, ollamaVersion: '0.21.0' }).status).toBe('same'); // recorded once
    expect(check({ ...env, ollamaVersion: '0.21.0', modelDigest: 'w2' })).toMatchObject({ status: 'blocked', changes: [{ field: 'modelDigest', blocking: true }] });
    expect(JSON.parse(readFileSync(state, 'utf8')).modelDigest).toBe('w1'); // a blocked change is not adopted
    expect(check({ ...env, ollamaVersion: '0.21.0', modelDigest: 'w2' }, { ACCEPT_ENV_CHANGE: '1' }).status).toBe('deviation');
    const hist = JSON.parse(readFileSync(state, 'utf8')).history;
    expect(hist.map((h: { field: string }) => h.field)).toEqual(['ollamaVersion', 'modelDigest']);
    expect(hist[1]).toMatchObject({ acceptedByResearcher: true });
  });

  it('render: a session page, the index and the data files, with no local paths', () => {
    const s = tmp();
    const nb = tmp();
    const slot = (rep: number, over: object) => ({ slot: `exp_x-fixed-r${rep}`, conditionId: 'fixed', repetition: rep, runId: `exp_x-fixed-r${rep}`, attempt: 1, pending: false, status: 'completed', excluded: [], wallSeconds: 600, tasks: 20, successRate: 0.5, cumulativeReward: 9.5, tokens: 120000, modelCalls: 140, usd: 0, generation: 0, mutationsAccepted: 0, mutationsRejected: 0, modelCallFailures: 2, agentFailures: 1, ...over });
    const ci = { mean: 9.5, lo: 9.5, hi: 9.5, n: 1 };
    const readings = (slots: object[], completed: number) => ({ experimentId: 'exp_x', name: 'feasibility-0', configHash: 'a'.repeat(64), model: { provider: 'ollama', model: 'qwen2.5-coder:7b' }, lockedAt: '2026-11-06T01:00:00Z', storedStatus: 'locked', planned: 2, completed, done: completed === 2, slots, shadowRuns: 0, allRunIds: [], scripted: false, conditions: [{ conditionId: 'fixed', condition: 'fixed-specialist', runs: completed ? ['exp_x-fixed-r1'] : [], cumulativeReward: ci, successRate: ci, lifetimeTokens: ci, lifetimeUsd: ci, reviewerCoverage: ci, securitySuccess: ci }], comparisons: [] });
    write(join(s, 'before.json'), readings([slot(1, { pending: true, status: null, runId: 'exp_x-fixed-r1' }), slot(2, { pending: true, status: null })], 0));
    write(join(s, 'after.json'), readings([slot(1, { runId: 'exp_x-fixed-r1-a2', attempt: 2, excluded: [{ runId: 'exp_x-fixed-r1', reason: 'interrupted (status running)', tasks: 7, wallSeconds: 300 }] }), slot(2, { pending: true, status: null })], 1));
    write(join(s, 'frozen.json'), { commit: 'c'.repeat(40), bundleSha256: 'f'.repeat(64) });
    write(join(s, 'ollama.json'), { model: 'qwen2.5-coder:7b', version: '0.21.0', digest: 'd'.repeat(64), gpuFraction: 1, contextLength: 4096, warmup: { genTokensPerSec: 50, promptTokensPerSec: 400 } });
    write(join(s, 'session.json'), { date: '2026-11-06', startedAt: '2026-11-06T09:00:00Z', endedAt: '2026-11-06T14:00:00Z', window: '01:00–06:30, hard stop 07:30', repoUrl: 'https://github.com/o/r', config: 'experiments/pilot/feasibility.yaml', outcome: 'ran', stopReason: 'time window closing at 06:30', retries: 3, truncatedPrompts: 2, notes: ['exp_x-fixed-r1 kept but excluded'], exported: ['a.zip'], provenanceFile: join(s, 'prov-state.json') });
    write(join(s, 'prov-state.json'), { modelDigest: 'd' });
    expect(lab(['render', s, nb]).trim()).toBe('sessions/2026-11-06.md');
    const page = readFileSync(join(nb, 'sessions/2026-11-06.md'), 'utf8');
    expect(page).toContain('**Outcome: ran.** feasibility-0: 1 new run counted, 1/2 complete.');
    expect(page).toContain('Stopped because: time window closing at 06:30.');
    expect(page).toContain('| `fixed-r1-a2` | fixed | 1 | completed | 20 | 0.50 | 9.50 | 120,000 | 140 | 2 | 1 | 0/0 | 10 min | 30 s | ✓ |');
    expect(page).toContain('- `exp_x-fixed-r1`: interrupted (status running); 7 task(s), 5 min **(this session)**');
    expect(page).toContain('## Interim aggregates (not results)');
    expect(page).toContain('context 4096 tokens · GPU offload 100%');
    expect(page).toContain('| Prompts truncated by Ollama | 2 |');
    expect(page).toContain('Ollama truncated 2 prompt(s) to its 4096-token context');
    expect(page).not.toContain(s);
    expect(existsSync(join(nb, 'data/feasibility-0/readings.json'))).toBe(true);
    expect(existsSync(join(nb, 'data/feasibility-0/provenance.json'))).toBe(true);
    const index = readFileSync(join(nb, 'README.md'), 'utf8');
    expect(index).toContain('| [2026-11-06](sessions/2026-11-06.md) | ran | feasibility-0 | 1 | 1/2 | time window closing at 06:30 |');
    expect(index).toContain('| feasibility-0 | `exp_x` | 1/2 runs |');
    // A second session the same day gets its own page.
    expect(lab(['render', s, nb]).trim()).toBe('sessions/2026-11-06-2.md');
    expect(readFileSync(join(nb, 'sessions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
