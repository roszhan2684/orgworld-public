import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { presetGenome } from '@orgworld/core';
import { EventStore, exportRun } from '@orgworld/store';
import { ClaudeCliProvider } from '@orgworld/cognition';
import { familyById } from '@orgworld/bench';
import { buildRunConfig, createRun, OrgRunner } from '../src/index.ts';

/**
 * LIVE (real Claude via headless CLI; spends real budget). Phase 3/4 acceptance evidence.
 * Persists to docs/verification/evidence/live.db and exports each run as a zip.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/verification/evidence');
mkdirSync(root, { recursive: true });

async function liveRun(preset: string, condition: 'single-agent' | 'fixed-specialist', label: string) {
  const store = EventStore.open(join(root, 'live.db'));
  const genome = presetGenome(preset);
  const cfg = buildRunConfig({
    runId: `run_${label}_${Date.now().toString(36)}`,
    mode: 'experiment',
    kind: 'stream',
    condition,
    label,
    genome,
    model: { provider: 'claude-cli', model: 'haiku' },
    budget: { perTask: { maxTokens: 400_000, maxCalls: 14, maxUsd: 0.6, reserveTokens: 4_000 } },
    reward: {},
    seeds: {},
    features: {},
    evolution: {},
    policy: {},
  });
  createRun(store, cfg);
  const runner = new OrgRunner({ store, provider: new ClaudeCliProvider(), runId: cfg.runId, log: (m) => console.log(`[${label}] ${m}`) });
  runner.instantiate(genome, 'preset');
  runner.start();
  const task = familyById('impl-rle').generate(1);
  const out = await runner.runTask({ kind: 'bench', task });
  runner.complete({ tasks: 1, success: out.success ? 1 : 0, score: out.score });
  const zip = exportRun(store, cfg.runId, join(root, `${label}.orgworld-run.zip`));
  console.log(`[${label}] outcome`, JSON.stringify(out));
  console.log(`[${label}] events=${zip.eventCount} export=${zip.path}`);
  const s = runner.state;
  store.close();
  return { out, s };
}

describe.runIf(process.env.ORGWORLD_LIVE === '1' && process.env.ORGWORLD_ALLOW_PAID === '1')('LIVE runs (claude-cli / haiku)', () => {
  it('Phase 3: single-agent baseline executes a real task end-to-end', async () => {
    const { out, s } = await liveRun('single-agent', 'single-agent', 'phase3-single-agent');
    expect(s.costs.total.calls).toBeGreaterThan(0);
    expect(Object.values(s.agents).every((a) => a.modelProvider === 'claude-cli')).toBe(true);
    expect(s.costs.total.tokens).toBeGreaterThan(0);
    expect(out.evaluated).toBe(true);
  }, 600_000);

  it('Phase 4: fixed multi-agent organization collaborates on a real task', async () => {
    const { out, s } = await liveRun('specialist-pool', 'fixed-specialist', 'phase4-specialists');
    const callers = Object.values(s.agents).filter((a) => a.calls > 0).map((a) => a.id);
    console.log('[phase4] agents that thought:', callers, 'messages:', s.messageOrder.length, 'rejected actions:', s.rejectedActions.length);
    for (const id of s.messageOrder.slice(0, 8)) {
      const m = s.messages[id]!;
      console.log(`  ${m.from} → ${m.to.join(',')} [${m.kind}] ${m.content.slice(0, 140).replace(/\n/g, ' ')}`);
    }
    expect(callers.length).toBeGreaterThanOrEqual(2);
    expect(s.messageOrder.length).toBeGreaterThanOrEqual(2);
    expect(out.success).toBe(true);
  }, 900_000);
});
