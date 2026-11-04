import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ExperimentConfig, PAID_PROVIDERS } from '@orgworld/protocol';
import { hashObject, presetGenome, validateGenome } from '@orgworld/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel: string) => ExperimentConfig.parse(parse(readFileSync(join(root, rel), 'utf8')));

describe('pre-registered experiment configs', () => {
  it('pilot config validates', () => {
    expect(load('experiments/pilot/pilot.yaml').conditions).toHaveLength(5);
  });

  for (const rel of ['experiments/pilot/pilot.yaml', 'experiments/pilot/feasibility.yaml', 'experiments/pilot-claude/pilot-claude.yaml', 'experiments/safety/verification-erosion.yaml'])
    it(`${rel}: parses, every starting organization satisfies its Ω, paid models are priced`, () => {
      const c = load(rel);
      for (const cond of c.conditions) {
        const base = presetGenome(cond.preset);
        const g = cond.constraints ? { ...base, constraints: { ...base.constraints, ...cond.constraints } } : base;
        expect(validateGenome(g).ok).toBe(true);
      }
      const ids = new Set(c.conditions.map((x) => x.id));
      for (const p of c.comparisons ?? []) expect(ids.has(p.a) && ids.has(p.b)).toBe(true);
      if (PAID_PROVIDERS.includes(c.controls.model.provider)) {
        expect(c.controls.model.pricing?.[c.controls.model.model]).toBeDefined();
        expect(c.controls.model.temperature).toBeUndefined(); // current Claude models reject non-default sampling
      }
    });

  it('the Claude replication differs from the frozen pilot only in the model block and name', () => {
    const a = load('experiments/pilot/pilot.yaml');
    const b = load('experiments/pilot-claude/pilot-claude.yaml');
    const strip = (c: ExperimentConfig) => ({ ...c, experiment: null, controls: { ...c.controls, model: null, maxTotalUsd: null } });
    expect(hashObject(strip(b))).toBe(hashObject(strip(a)));
  });

  it('the safety study turns Ω on in exactly the omega arms and uses the pilot stream', () => {
    const s = load('experiments/safety/verification-erosion.yaml');
    const omega = s.conditions.filter((c) => c.constraints?.verifierRequiredFor?.length).map((c) => c.id);
    expect(omega).toEqual(['omega-std', 'omega-high']);
    expect(s.stream).toEqual(load('experiments/pilot/pilot.yaml').stream);
  });
});
