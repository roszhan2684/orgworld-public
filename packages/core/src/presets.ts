import {
  GENOME_SCHEMA_VERSION,
  OrganizationGenome,
  type Capability,
  type Edge,
  type GenomeAgent,
  type OrganizationGenomeInput,
  type RoleDescriptor,
} from '@orgworld/protocol';

const r = (
  id: string,
  name: string,
  objective: string,
  capabilities: Capability[],
  inputTypes: string[] = ['task', 'message'],
  outputTypes: string[] = ['message'],
): RoleDescriptor => ({ id, name, objective, capabilities, inputTypes, outputTypes });

/**
 * Role library: the vocabulary available to CHANGE_ROLE / ADD_AGENT mutations and to the per-task designer (B3).
 * Descriptors are deliberately short (II-§16) so that structure, not prompt engineering, is what varies.
 */
export const ROLE_LIBRARY: Record<string, RoleDescriptor> = {
  generalist: r(
    'generalist',
    'Generalist',
    'Do whatever the task needs: plan, implement, test, review, and coordinate with teammates.',
    ['write_code', 'write_tests', 'run_checks', 'review', 'research', 'plan', 'submit'],
    ['task', 'message', 'code'],
    ['code', 'tests', 'review', 'message'],
  ),
  planner: r('planner', 'Planner', 'Decompose the task, delegate work, integrate results and submit the final deliverable.', ['plan', 'submit', 'decide'], ['task', 'message'], ['plan', 'message']),
  implementer: r('implementer', 'Implementer', 'Write and fix code that satisfies the specification; run the public checks.', ['write_code', 'run_checks'], ['task', 'plan', 'review'], ['code']),
  debugger: r('debugger', 'Debugging Specialist', 'Locate the root cause of incorrect behaviour in existing code and produce a minimal fix.', ['write_code', 'run_checks'], ['task', 'code', 'test_report'], ['code']),
  reviewer: r('reviewer', 'Reviewer', 'Find correctness and requirement violations in candidate code; approve or request changes.', ['review'], ['code'], ['review']),
  security_reviewer: r('security_reviewer', 'Security Reviewer', 'Find injection, traversal, validation and other security flaws in candidate code; demand fixes.', ['review'], ['code'], ['review']),
  tester: r('tester', 'Tester', 'Write tests that expose hidden failures and run the public checks against candidate code.', ['write_tests', 'run_checks'], ['code', 'task'], ['tests', 'test_report']),
  refactorer: r('refactorer', 'Refactoring Specialist', 'Restructure code to meet structural constraints while preserving behaviour exactly.', ['write_code', 'run_checks'], ['code', 'task'], ['code']),
};

/* ---------------- build §7 default organization (product AND research since 2026-10-29, conflict C-01) ---------------- */

export const SOFTWARE_ORG_ROLES: RoleDescriptor[] = [
  r('director', 'Director', 'Own the top-level objective: set priorities, delegate, resolve unresolved coordination, approve the final output.', ['plan', 'decide', 'submit', 'mediate']),
  r('scout', 'Scout', 'Rapidly explore the problem, discover dependencies and unknowns, report findings.', ['research']),
  r('researcher', 'Researcher', 'Investigate deeply, gather evidence, analyse hypotheses and synthesise findings.', ['research']),
  r('strategist', 'Strategist', 'Compare approaches, build plans and make trade-offs explicit.', ['plan']),
  r('architect', 'Architect', 'Design interfaces, component boundaries and technical approach; record design decisions.', ['plan', 'review']),
  r('builder', 'Builder', 'Implement code changes and prototypes; run the public checks.', ['write_code', 'run_checks'], ['task', 'plan', 'review'], ['code']),
  r('experimenter', 'Experimenter', 'Write tests and run validations and controlled comparisons.', ['write_tests', 'run_checks'], ['code'], ['tests', 'test_report']),
  r('critic', 'Critic', 'Challenge assumptions, find logical weaknesses, red-team proposals and code.', ['review'], ['code', 'proposal'], ['review']),
  r('risk', 'Risk Agent', 'Assess security, reliability, privacy and operational failure modes.', ['review'], ['code', 'proposal'], ['risk_report']),
  r('analyst', 'Analyst', 'Evaluate evidence, compute metrics and compare results.', ['review', 'research'], ['test_report'], ['evaluation']),
  r('librarian', 'Librarian', 'Curate organizational memory: decide what persists, retrieve relevant knowledge, flag stale memory.', ['memory', 'research']),
  r('mediator', 'Mediator', 'Resolve conflicting proposals by summarising opposing evidence and facilitating a decision.', ['mediate', 'decide']),
];

function edges(list: Array<[string, string, Edge['kind']]>): Edge[] {
  return list.map(([from, to, kind]) => ({ from, to, kind }));
}

function finalize(g: OrganizationGenomeInput): OrganizationGenome {
  return OrganizationGenome.parse(g);
}

/**
 * Role vocabulary available to the per-task designer and to evolution mutations for an organization that starts as
 * `base`: the research role library plus any roles the starting organization brings (e.g. the 12 build-spec roles).
 * For presets whose roles are already in the library this is exactly the library, so their behaviour is unchanged.
 */
export function roleVocabulary(base: OrganizationGenome): RoleDescriptor[] {
  const out = new Map(Object.values(ROLE_LIBRARY).map((r) => [r.id, r]));
  for (const r of base.roles) if (!out.has(r.id)) out.set(r.id, r);
  return [...out.values()];
}

export function softwareOrg12(): OrganizationGenome {
  const agents: GenomeAgent[] = SOFTWARE_ORG_ROLES.map((role) => ({ id: role.id, name: role.name, roleId: role.id }));
  const others = SOFTWARE_ORG_ROLES.map((x) => x.id).filter((x) => x !== 'director');
  const e: Array<[string, string, Edge['kind']]> = [];
  for (const o of others) {
    e.push(['director', o, 'delegate'], [o, 'director', 'inform']);
  }
  e.push(
    ['scout', 'researcher', 'inform'],
    ['researcher', 'strategist', 'inform'],
    ['strategist', 'architect', 'inform'],
    ['architect', 'builder', 'delegate'],
    ['builder', 'architect', 'inform'],
    ['builder', 'experimenter', 'review'],
    ['experimenter', 'builder', 'inform'],
    ['builder', 'critic', 'review'],
    ['critic', 'builder', 'inform'],
    ['builder', 'risk', 'review'],
    ['risk', 'builder', 'inform'],
    ['experimenter', 'analyst', 'inform'],
    ['critic', 'mediator', 'inform'],
    ['architect', 'mediator', 'inform'],
    ['mediator', 'critic', 'inform'],
    ['mediator', 'architect', 'inform'],
    ['librarian', 'builder', 'inform'],
    ['librarian', 'researcher', 'inform'],
  );
  return finalize({
    schemaVersion: GENOME_SCHEMA_VERSION,
    id: 'preset-software-org-12',
    name: '12-agent Software Organization',
    preset: 'software-org-12',
    generation: 0,
    parentId: null,
    createdBy: 'preset',
    roles: SOFTWARE_ORG_ROLES,
    agents,
    edges: edges(e),
    teams: [],
    entryAgentId: 'director',
    policies: { submit: 'capability', decision: 'MAJORITY', maxTurnsPerTask: 30, maxActionsPerTurn: 3, memoryRead: 'org' },
    constraints: { minAgents: 1, maxAgents: 16, verifierRequiredFor: [], protectEntry: true },
  });
}

/** Research Experiment A (II-§15): homogeneous generalists, star topology around the entry agent. */
export function generalists(n = 4): OrganizationGenome {
  const ids = Array.from({ length: n }, (_, i) => `a${i + 1}`);
  const e: Array<[string, string, Edge['kind']]> = [];
  for (const o of ids.slice(1)) e.push(['a1', o, 'delegate'], [o, 'a1', 'inform']);
  return finalize({
    schemaVersion: GENOME_SCHEMA_VERSION,
    id: `preset-generalists-${n}`,
    name: `${n} Generalists`,
    preset: `generalists-${n}`,
    generation: 0,
    parentId: null,
    createdBy: 'preset',
    roles: [ROLE_LIBRARY.generalist!],
    agents: ids.map((id) => ({ id, name: id.toUpperCase(), roleId: 'generalist' })),
    edges: edges(e),
    teams: [],
    entryAgentId: 'a1',
    policies: { submit: 'entry', decision: 'MAJORITY', maxTurnsPerTask: 16, maxActionsPerTurn: 3, memoryRead: 'org' },
    constraints: { minAgents: 1, maxAgents: 8, verifierRequiredFor: [], protectEntry: true },
  });
}

/** Research B2 (II-§23): human-designed specialists, static. */
export function specialistPool(): OrganizationGenome {
  const L = ROLE_LIBRARY;
  return finalize({
    schemaVersion: GENOME_SCHEMA_VERSION,
    id: 'preset-specialist-pool',
    name: 'Planner / Implementer / Reviewer / Tester',
    preset: 'specialist-pool',
    generation: 0,
    parentId: null,
    createdBy: 'preset',
    roles: [L.planner!, L.implementer!, L.reviewer!, L.tester!],
    agents: [
      { id: 'planner', name: 'Planner', roleId: 'planner' },
      { id: 'implementer', name: 'Implementer', roleId: 'implementer' },
      { id: 'reviewer', name: 'Reviewer', roleId: 'reviewer' },
      { id: 'tester', name: 'Tester', roleId: 'tester' },
    ],
    edges: edges([
      ['planner', 'implementer', 'delegate'],
      ['implementer', 'planner', 'inform'],
      ['implementer', 'reviewer', 'review'],
      ['reviewer', 'implementer', 'inform'],
      ['implementer', 'tester', 'review'],
      ['tester', 'implementer', 'inform'],
      ['reviewer', 'planner', 'inform'],
      ['tester', 'planner', 'inform'],
    ]),
    teams: [],
    entryAgentId: 'planner',
    policies: { submit: 'entry', decision: 'MAJORITY', maxTurnsPerTask: 16, maxActionsPerTurn: 3, memoryRead: 'org' },
    constraints: { minAgents: 1, maxAgents: 8, verifierRequiredFor: [], protectEntry: true },
  });
}

/** Research B0: one strong agent with every capability and the full budget (not handicapped, build §64). */
export function singleAgent(): OrganizationGenome {
  return finalize({
    schemaVersion: GENOME_SCHEMA_VERSION,
    id: 'preset-single-agent',
    name: 'Single Agent',
    preset: 'single-agent',
    generation: 0,
    parentId: null,
    createdBy: 'preset',
    roles: [{ ...ROLE_LIBRARY.generalist!, id: 'solo', name: 'Solo Engineer', objective: 'Solve the task end to end: implement, test, self-review and submit.' }],
    agents: [{ id: 'solo', name: 'Solo', roleId: 'solo' }],
    edges: [],
    teams: [],
    entryAgentId: 'solo',
    policies: { submit: 'entry', decision: 'DIRECTOR', maxTurnsPerTask: 12, maxActionsPerTurn: 3, memoryRead: 'org' },
    constraints: { minAgents: 1, maxAgents: 1, verifierRequiredFor: [], protectEntry: true },
  });
}

export const PRESETS: Record<string, () => OrganizationGenome> = {
  'software-org-12': softwareOrg12,
  'generalists-4': () => generalists(4),
  'generalists-3': () => generalists(3),
  'specialist-pool': specialistPool,
  'single-agent': singleAgent,
};

export function presetGenome(name: string): OrganizationGenome {
  const f = PRESETS[name];
  if (!f) throw new Error(`Unknown organization preset "${name}". Known: ${Object.keys(PRESETS).join(', ')}`);
  return f();
}
