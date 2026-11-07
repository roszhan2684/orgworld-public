import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { presetGenome } from '@orgworld/core';
import { EventStore } from '@orgworld/store';
import { ScriptedProvider, type CognitionRequest } from '@orgworld/cognition';
import { familyById } from '@orgworld/bench';
import { buildRunConfig, createRun, OrgRunner } from '@orgworld/runtime';
import { renderDeliberation, renderKnowledge } from '../../apps/web/src/research/views.ts';

// Web research views (ideas 28–29) rendered from a scripted run (test-only provider; mechanics, not results).
describe('research views', () => {
  it('render decisions, debate, lessons and expertise from recorded events, escaping agent text', async () => {
    const store = EventStore.open(join(mkdtempSync(join(tmpdir(), 'owviews-')), 'orgworld.db'));
    const genome = presetGenome('generalists-4');
    const cfg = buildRunConfig({ runId: 'run_views', mode: 'sandbox', kind: 'stream', condition: 'fixed-generalist', genome, model: { provider: 'scripted', model: 's' }, budget: {}, reward: {}, seeds: {}, features: { afterActionReview: true, playbook: true, debate: true, blindVote: true, trackRecord: true }, evolution: {}, policy: {} });
    createRun(store, cfg);
    const fam = familyById('impl-rle');
    let good = false;
    const box: { r?: OrgRunner } = {};
    const agentOf = (r: CognitionRequest) => /agent id "([^"]+)"/.exec(r.system)?.[1];
    const runner = new OrgRunner({
      store,
      runId: cfg.runId,
      provider: new ScriptedProvider((req) => {
        const me = agentOf(req)!;
        if (req.purpose.startsWith('vote on')) return { option: me === 'a2' && !req.purpose.includes('round 2') ? 'B' : 'A', rationale: `${me} thinks so`, confidence: 0.7, evidence: [] };
        if (req.purpose.startsWith('against on')) return { content: 'B is <safer>', evidence: [] };
        if (req.purpose.startsWith('rebuttal on')) return { content: 'A is fine', evidence: [] };
        if (req.purpose === 'after-action review') return { whys: ['checks were skipped'], lesson: 'Run the checks first.', approach: 'Write, check, submit.' };
        if (me !== 'a1') return { reasoning: 'idle', actions: [{ type: 'wait' }] };
        const art = /Created code artifact (art_[0-9a-f]{16})/.exec(req.prompt)?.[1];
        if (art) return { reasoning: 'submit', actions: [{ type: 'submit', artifactId: art }] };
        if (!Object.values(box.r!.state.decisions).some((d) => d.taskId === box.r!.state.activeTaskId)) return { reasoning: 'decide', actions: [{ type: 'propose_decision', question: 'Use <script> or a loop?', options: ['A', 'B'], recommendation: 'A' }] };
        const v = Number(/TASK \S+#(\d+) —/.exec(req.prompt)![1]);
        return { reasoning: 'write', actions: [{ type: 'write_code', title: 'impl', code: good ? fam.referenceDeliverable(v) : 'module.exports = {};' }] };
      }),
    });
    box.r = runner;
    runner.instantiate(genome, 'test');
    runner.start();
    await runner.runTask({ kind: 'bench', task: fam.generate(0) });
    good = true;
    await runner.runTask({ kind: 'bench', task: fam.generate(1) });

    const d = renderDeliberation(runner.state);
    expect(d).toContain('Use &lt;script&gt; or a loop?');
    expect(d).not.toContain('<script>');
    expect(d).toContain('Round 1 · blind');
    expect(d).toContain('a2 → A · 70% <em>(was B)</em>');
    expect(d).toContain('B is &lt;safer&gt;');
    expect(d).toContain('task failed');
    expect(d).toContain('task passed');
    expect(d).toContain('<th>Brier (lower is better)</th>');

    const k = renderKnowledge(runner.state);
    expect(k).toContain('Run the checks first.');
    expect(k).toContain('Approach that passed a implementation task: Write, check, submit.');
    expect(k).toContain('why? checks were skipped');
    expect(k).toMatch(/<td>a1<\/td><td>1\/2<\/td>/);
    expect(k).toContain('<svg class="ow-spark"');
    store.close();
  });
});
