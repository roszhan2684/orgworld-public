import { describe, expect, it } from 'vitest';
import { OrganizationGenome } from '@orgworld/protocol';
import { applyMutation, canSubmit, diffGenomes, genomeStructureHash, isMutationAllowed, MutationError, PRESETS, presetGenome, ROLE_LIBRARY, validateGenome } from '../src/index.ts';

describe('presets', () => {
  for (const name of Object.keys(PRESETS)) {
    it(`${name} is a valid genome`, () => {
      const g = presetGenome(name);
      expect(OrganizationGenome.safeParse(g).success).toBe(true);
      const v = validateGenome(g);
      expect(v.errors).toEqual([]);
      expect(v.warnings).toEqual([]);
    });
  }
  it('software-org-12 has exactly the 12 build-§7 roles', () => {
    const g = presetGenome('software-org-12');
    expect(g.agents.map((a) => a.id)).toEqual(['director', 'scout', 'researcher', 'strategist', 'architect', 'builder', 'experimenter', 'critic', 'risk', 'analyst', 'librarian', 'mediator']);
    expect(canSubmit(g, 'director')).toBe(true);
    expect(canSubmit(g, 'builder')).toBe(false);
  });
  it('generalists start with one shared role (Experiment A)', () => {
    const g = presetGenome('generalists-4');
    expect(new Set(g.agents.map((a) => a.roleId))).toEqual(new Set(['generalist']));
  });
});

describe('applyMutation', () => {
  const base = presetGenome('generalists-4');
  it('ADD_AGENT adds agent, role and default wiring; lineage recorded; input untouched', () => {
    const before = structuredClone(base);
    const g = applyMutation(base, { type: 'ADD_AGENT', agent: { id: 'sec', name: 'Sec', roleId: 'security_reviewer' }, role: ROLE_LIBRARY.security_reviewer! }, { createdBy: 'p1' });
    expect(base).toEqual(before);
    expect(g.generation).toBe(1);
    expect(g.parentId).toBe(base.id);
    expect(g.createdBy).toBe('p1');
    expect(g.edges).toContainEqual({ from: 'a1', to: 'sec', kind: 'delegate' });
    expect(diffGenomes(base, g)).toMatchObject({ agentsAdded: ['sec'], churn: 3 });
  });
  it('CHANGE_ROLE swaps role and prunes unused roles', () => {
    const g = applyMutation(base, { type: 'CHANGE_ROLE', agentId: 'a2', role: ROLE_LIBRARY.tester! }, { createdBy: 'p' });
    expect(g.agents.find((a) => a.id === 'a2')!.roleId).toBe('tester');
    expect(diffGenomes(base, g).roleChanges).toEqual([{ agentId: 'a2', from: 'generalist', to: 'tester' }]);
  });
  it('REMOVE_AGENT removes incident edges', () => {
    const g = applyMutation(base, { type: 'REMOVE_AGENT', agentId: 'a3' }, { createdBy: 'p' });
    expect(g.edges.some((e) => e.from === 'a3' || e.to === 'a3')).toBe(false);
  });
  it('Ω: entry agent is protected', () => {
    expect(() => applyMutation(base, { type: 'REMOVE_AGENT', agentId: 'a1' }, { createdBy: 'p' })).toThrow(MutationError);
  });
  it('Ω: verifier required — removing the only reviewer path is rejected', () => {
    const g0 = { ...presetGenome('specialist-pool'), constraints: { ...presetGenome('specialist-pool').constraints, verifierRequiredFor: ['security'] } };
    expect(validateGenome(g0).ok).toBe(true);
    expect(() => applyMutation(g0, { type: 'REMOVE_AGENT', agentId: 'reviewer' }, { createdBy: 'p' })).toThrow(/reviewer must be reachable/);
  });
  it('rejects duplicate edges, self loops, missing endpoints', () => {
    expect(() => applyMutation(base, { type: 'ADD_EDGE', edge: { from: 'a1', to: 'a2', kind: 'delegate' } }, { createdBy: 'p' })).toThrow(/already exists/);
    expect(() => applyMutation(base, { type: 'ADD_EDGE', edge: { from: 'a2', to: 'a2', kind: 'inform' } }, { createdBy: 'p' })).toThrow(MutationError);
    expect(() => applyMutation(base, { type: 'ADD_EDGE', edge: { from: 'a2', to: 'zz', kind: 'inform' } }, { createdBy: 'p' })).toThrow(/missing/);
    expect(() => applyMutation(base, { type: 'REMOVE_EDGE', from: 'a2', to: 'a3' }, { createdBy: 'p' })).toThrow(/not found/);
  });
  it('structure hash ignores lineage but not structure', () => {
    const g = applyMutation(base, { type: 'ADD_EDGE', edge: { from: 'a2', to: 'a3', kind: 'inform' } }, { createdBy: 'p' });
    const back = applyMutation(g, { type: 'REMOVE_EDGE', from: 'a2', to: 'a3' }, { createdBy: 'q' });
    expect(genomeStructureHash(back)).toBe(genomeStructureHash(base));
    expect(genomeStructureHash(g)).not.toBe(genomeStructureHash(base));
  });
});

describe('mutation sets and ablations (conflict C-02)', () => {
  it('paper1 set excludes exploratory operators', () => {
    expect(isMutationAllowed({ type: 'CHANGE_DECISION_METHOD', policy: 'VETO' }, 'paper1')).toMatch(/exploratory/);
    expect(isMutationAllowed({ type: 'CHANGE_DECISION_METHOD', policy: 'VETO' }, 'extended')).toBeNull();
    expect(isMutationAllowed({ type: 'ADD_EDGE', edge: { from: 'a', to: 'b', kind: 'inform' } }, 'paper1')).toBeNull();
  });
  it('ablations A2/A3/A4 block their operators', () => {
    expect(isMutationAllowed({ type: 'CHANGE_ROLE', agentId: 'a', role: ROLE_LIBRARY.tester! }, 'paper1', ['no-role-evolution'])).toMatch(/no-role-evolution/);
    expect(isMutationAllowed({ type: 'REMOVE_AGENT', agentId: 'a' }, 'paper1', ['no-membership-evolution'])).toMatch(/membership/);
    expect(isMutationAllowed({ type: 'REMOVE_EDGE', from: 'a', to: 'b' }, 'paper1', ['no-topology-evolution'])).toMatch(/topology/);
  });
});
