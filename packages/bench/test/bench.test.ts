import { describe, expect, it } from 'vitest';
import { StreamSpec } from '@orgworld/protocol';
import { CATEGORIES, evaluateDeliverable, FAMILIES, generateStream, publicView, runNodeTests, runPublicChecks, variantInSplit } from '../src/index.ts';

describe('sandbox (build §56)', () => {
  it('denies fs writes, child processes and reads outside the sandbox', async () => {
    const r = await runNodeTests(
      {
        'solution.js': 'module.exports = {}',
        't.test.js': `const test=require('node:test');const assert=require('node:assert');const fs=require('node:fs');
test('no write',()=>assert.throws(()=>fs.writeFileSync('x.txt','1'),(e)=>e.code==='ERR_ACCESS_DENIED'));
test('no spawn',()=>assert.throws(()=>require('node:child_process').execSync('echo hi'),(e)=>e.code==='ERR_ACCESS_DENIED'));
test('no outside read',()=>assert.throws(()=>fs.readFileSync('/etc/hosts'),(e)=>e.code==='ERR_ACCESS_DENIED'));`,
      },
      't.test.js',
    );
    expect(r).toMatchObject({ total: 3, passed: 3, failed: 0, crashed: false });
  });
  it('kills infinite loops at the timeout', async () => {
    const r = await runNodeTests({ 't.test.js': "require('node:test')('spin',()=>{for(;;){}})" }, 't.test.js', { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(0);
  });
  it('reports syntax errors in submissions as crashed', async () => {
    const r = await runNodeTests({ 'solution.js': 'module.exports = {', 't.test.js': "require('./solution.js')" }, 't.test.js');
    expect(r.crashed).toBe(true);
  });
});

describe('every family is well-formed (benchmark self-test)', () => {
  for (const fam of FAMILIES) {
    for (let v = 0; v < Math.min(fam.variants, 3); v++) {
      it(`${fam.id}#${v}: reference scores 1, starter scores < 1, hidden checks not leaked`, async () => {
        const task = fam.generate(v);
        expect(task.id).toBe(`${fam.id}#${v}`);
        expect(task.category).toBe(fam.category);
        const pv = JSON.stringify(publicView(task));
        if (task.hiddenChecks) expect(pv.includes(task.hiddenChecks.slice(-120))).toBe(false);
        for (const m of task.mutants ?? []) expect(pv.includes(m.slice(-200))).toBe(false);
        const good = await evaluateDeliverable(task, fam.referenceDeliverable(v));
        expect(good.score, good.details).toBe(1);
        const pub = await runPublicChecks(task, fam.referenceDeliverable(v));
        expect(pub.failed, pub.output).toBe(0);
        const bad = await evaluateDeliverable(task, task.starterCode);
        expect(bad.score, bad.details).toBeLessThan(1);
      }, 60_000);
    }
  }
});

describe('stream generator (II-§17, III stream types)', () => {
  const phases = [
    { id: 'A', mix: { implementation: 1 } },
    { id: 'B', mix: { implementation: 1 } },
  ];
  it('is deterministic for a seed and respects phase boundaries (abrupt)', () => {
    const spec = StreamSpec.parse({ kind: 'abrupt', tasks: 10, seed: 7, phases });
    const a = generateStream(spec, FAMILIES);
    const b = generateStream(spec, FAMILIES);
    expect(a.map((t) => t.task.id)).toEqual(b.map((t) => t.task.id));
    expect(a.map((t) => t.phaseId)).toEqual(['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B']);
  });
  it('recurring stream returns to the first phase', () => {
    const spec = StreamSpec.parse({ kind: 'recurring', tasks: 9, seed: 1, phases: [phases[0], phases[1], { id: 'A2', mix: { implementation: 1 } }] });
    expect(generateStream(spec, FAMILIES).map((t) => t.phaseIndex)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });
  it('variant splits are disjoint', () => {
    for (let v = 0; v < 100; v++) {
      const n = ['train', 'validation', 'test'].filter((s) => variantInSplit(v, s as 'train')).length;
      expect(n).toBe(1);
    }
  });
  it('category mix is honoured statistically when families exist', () => {
    const cats = new Set(FAMILIES.map((f) => f.category));
    if (cats.size < CATEGORIES.length) return; // full check once all categories have families
    const spec = StreamSpec.parse({ kind: 'stationary', tasks: 400, seed: 3, phases: [{ id: 'S', mix: { implementation: 0.7, security: 0.3 } }] });
    const s = generateStream(spec, FAMILIES);
    const share = s.filter((t) => t.task.category === 'security').length / s.length;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.38);
  });
});
