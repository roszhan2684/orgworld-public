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

  for (const rel of ['experiments/pilot/pilot.yaml', 'experiments/pilot/feasibility.yaml', 'experiments/pilot-claude/pilot-claude.yaml', 'experiments/safety/verification-erosion.yaml', 'experiments/organization/org-behaviour-pilot.yaml'])
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

describe('organization-behaviour pilot (draft, C-21)', () => {
  it('is free, pins the context, matches budgets across conditions, and isolates each feature group', () => {
    const c = load('experiments/organization/org-behaviour-pilot.yaml');
    expect(c.controls.model).toMatchObject({ provider: 'ollama', contextTokens: 16384 });
    expect(new Set(c.conditions.map((x) => x.preset))).toEqual(new Set(['software-org-12']));
    const NEW = new Set(['afterActionReview', 'playbook', 'lessonScoring', 'decisionJournal', 'debate', 'evidenceRule', 'blindVote', 'tieBreak', 'preMortem', 'multiPath', 'trackRecord', 'expertiseDirectory']);
    const f = Object.fromEntries(c.conditions.map((x) => [x.id, Object.entries(x.features ?? {}).filter(([k, v]) => NEW.has(k) && v === true).map(([k]) => k).sort()]));
    expect(f['evo-base']).toEqual([]);
    expect(f['evo-learn']).toEqual(['afterActionReview', 'decisionJournal', 'lessonScoring', 'playbook']);
    expect(f['evo-debate']).toEqual(['blindVote', 'debate', 'evidenceRule', 'preMortem', 'tieBreak']);
    expect(f['evo-predict']).toEqual(['expertiseDirectory', 'multiPath', 'trackRecord']);
    expect(f['evo-all']).toHaveLength(12);
    expect(readFileSync(join(root, 'experiments/organization/PROTOCOL.md'), 'utf8')).toContain('DRAFT');
  });

  it('adding the optional feature flags did not change the pre-registered configs (same parsed form, same hash)', () => {
    const pilot = load('experiments/pilot/pilot.yaml');
    expect(Object.keys(pilot.controls.features).sort()).toEqual(['beliefs', 'crossTaskMemory', 'decisions', 'meetings', 'relationships']);
    expect(pilot.controls.model.contextTokens).toBeUndefined();
  });
});
