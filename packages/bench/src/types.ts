/** EvoOrgBench task model (research II-§17–19). Categories require meaningfully different behaviours. */
export const CATEGORIES = ['implementation', 'debugging', 'testing', 'security', 'refactoring'] as const;
export type TaskCategory = (typeof CATEGORIES)[number];

export interface BenchTask {
  /** `${family}#${variant}` — stable across runs for identical (family, variant). */
  id: string;
  family: string;
  category: TaskCategory;
  variant: number;
  difficulty: 1 | 2 | 3;
  title: string;
  /** Self-contained statement shown to agents. Must state the exact module interface. */
  statement: string;
  /**
   * What the agents must produce:
   *  - 'solution': CommonJS module source saved as solution.js
   *  - 'tests': a node:test file that require()s './solution.js' (testing category)
   */
  deliverable: 'solution' | 'tests';
  /** Code shown to agents at the start (skeleton, buggy code, vulnerable code, code to refactor, or the implementation under test). */
  starterCode: string;
  /** node:test file visible to agents via run_checks. For 'tests' deliverables this is unused (public check = agent tests vs reference). */
  publicChecks: string;
  /** EVALUATOR ONLY (build §95). Never shown to agents. node:test file run against solution.js. */
  hiddenChecks: string;
  /** testing category only: correct implementation the agent's tests must pass on. */
  reference?: string;
  /** testing category only: buggy implementations the agent's tests should fail on (hidden). */
  mutants?: string[];
  /** testing category only: one mutant shown via public checks so agents can verify their tests bite. */
  publicMutant?: string;
}

export interface TaskFamily {
  id: string;
  category: TaskCategory;
  difficulty: 1 | 2 | 3;
  /** Number of distinct parameterisations available (variants wrap modulo this). */
  variants: number;
  generate(variant: number): BenchTask;
  /** A correct deliverable for this variant — used ONLY by the benchmark self-test, never shown to agents. */
  referenceDeliverable(variant: number): string;
}

/** Agent-visible slice of a task (no hidden checks, no mutants). */
export interface PublicTaskView {
  id: string;
  family: string;
  category: TaskCategory;
  title: string;
  statement: string;
  deliverable: 'solution' | 'tests';
  starterCode: string;
  publicCheckCount: number;
}

export function publicView(t: BenchTask): PublicTaskView {
  return {
    id: t.id,
    family: t.family,
    category: t.category,
    title: t.title,
    statement: t.statement,
    deliverable: t.deliverable,
    starterCode: t.starterCode,
    publicCheckCount: countTests(t.deliverable === 'tests' ? '' : t.publicChecks),
  };
}

export function countTests(src: string): number {
  return (src.match(/\btest\(\s*['"`]/g) ?? []).length;
}
