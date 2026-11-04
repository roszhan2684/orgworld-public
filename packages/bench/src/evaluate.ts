import { runNodeTests, type CheckResult } from './sandbox.ts';
import type { BenchTask } from './types.ts';

export interface Evaluation {
  score: number; // [0,1]
  passed: number;
  total: number;
  details: string;
}

/** Public checks an agent may run during the task (build §95: agents never see hidden checks). */
export async function runPublicChecks(task: BenchTask, deliverable: string): Promise<CheckResult> {
  if (task.deliverable === 'tests') {
    // Agent tests must pass on the reference and fail on the public mutant.
    const onRef = await runNodeTests({ 'solution.js': task.reference!, 'agent.test.js': deliverable }, 'agent.test.js');
    const onMut = task.publicMutant ? await runNodeTests({ 'solution.js': task.publicMutant, 'agent.test.js': deliverable }, 'agent.test.js') : null;
    const mutantCaught = onMut ? !onMut.crashed && onMut.failed > 0 : false;
    const refOk = !onRef.crashed && onRef.failed === 0 && onRef.total > 0;
    return {
      passed: (refOk ? 1 : 0) + (mutantCaught ? 1 : 0),
      failed: (refOk ? 0 : 1) + (onMut && !mutantCaught ? 1 : 0),
      total: onMut ? 2 : 1,
      timedOut: onRef.timedOut || !!onMut?.timedOut,
      durationMs: onRef.durationMs + (onMut?.durationMs ?? 0),
      crashed: onRef.crashed,
      output:
        `[your tests vs correct implementation] ${refOk ? 'all pass ✓' : 'FAIL — tests must pass on a correct implementation'}\n${onRef.output}` +
        (onMut ? `\n[your tests vs a known-buggy implementation] ${mutantCaught ? 'bug detected ✓' : 'bug NOT detected ✗'}` : ''),
    };
  }
  return runNodeTests({ 'solution.js': deliverable, 'public.test.js': task.publicChecks }, 'public.test.js');
}

/** Hidden evaluation — separate from producing agents. */
export async function evaluateDeliverable(task: BenchTask, deliverable: string | null): Promise<Evaluation> {
  if (deliverable === null || deliverable.trim() === '') return { score: 0, passed: 0, total: 1, details: 'no deliverable submitted' };
  if (task.deliverable === 'tests') {
    const onRef = await runNodeTests({ 'solution.js': task.reference!, 'agent.test.js': deliverable }, 'agent.test.js');
    if (onRef.crashed || onRef.failed > 0 || onRef.total === 0)
      return { score: 0, passed: 0, total: task.mutants!.length, details: `agent tests do not pass on the correct implementation:\n${onRef.output}` };
    let killed = 0;
    const lines: string[] = [];
    for (const [i, m] of task.mutants!.entries()) {
      const r = await runNodeTests({ 'solution.js': m, 'agent.test.js': deliverable }, 'agent.test.js');
      const k = r.crashed || r.failed > 0;
      if (k) killed++;
      lines.push(`mutant ${i + 1}: ${k ? 'killed' : 'survived'}`);
    }
    return { score: killed / task.mutants!.length, passed: killed, total: task.mutants!.length, details: lines.join('\n') };
  }
  const r = await runNodeTests({ 'solution.js': deliverable, 'hidden.test.js': task.hiddenChecks }, 'hidden.test.js');
  if (r.crashed || r.total === 0) return { score: 0, passed: 0, total: Math.max(1, r.total), details: `hidden checks crashed:\n${r.output}` };
  return { score: r.passed / r.total, passed: r.passed, total: r.total, details: r.output };
}
