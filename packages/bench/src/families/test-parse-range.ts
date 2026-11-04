import type { TaskFamily } from '../types.ts';

/** testing / difficulty 2: write tests for parseRange; hidden score = fraction of mutants killed. */
const SEPS = ['-', '..', ':'] as const;
const H = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { parseRange } = require('./solution.js');\n";

function impl(sep: string, bug: string | null): string {
  const s = JSON.stringify(sep);
  return `/** parseRange("a${sep}b") -> integers a..b inclusive; "a${sep}b,c" joins parts; descending ranges count down; throws on invalid input. */
function parseRange(str) {
  if (typeof str !== 'string' || str.trim() === '') throw new Error('invalid');
  const out = [];
  for (const part of str.split(',')) {
    const p = part.trim();
    if (${bug === 'single' ? 'false' : `!p.includes(${s})`}) { const n = Number(p); if (!Number.isInteger(n)) throw new Error('invalid'); out.push(n); continue; }
    const [a, b] = p.split(${s}).map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) ${bug === 'nothrow' ? 'continue' : "throw new Error('invalid')"};
    if (a <= b) for (let i = a; i ${bug === 'exclusive' ? '<' : '<='} b; i++) out.push(i);
    else for (let i = a; i ${bug === 'desc' ? '>' : '>='} b; i--) out.push(i);
  }
  return ${bug === 'sort' ? 'out.sort((x, y) => x - y)' : bug === 'dedupe' ? '[...new Set(out)]' : 'out'};
}
module.exports = { parseRange };
`;
}

export const testParseRange: TaskFamily = {
  id: 'test-parse-range',
  category: 'testing',
  difficulty: 2,
  variants: SEPS.length,
  referenceDeliverable(v) {
    const sep = SEPS[v % SEPS.length]!;
    const r = (a: string, b: string) => `test(${JSON.stringify(a)}, () => assert.deepStrictEqual(parseRange(${JSON.stringify(a)}), ${b}));`;
    return H + [r(`1${sep}4`, '[1,2,3,4]'), r(`5${sep}3`, '[5,4,3]'), r('7', '[7]'), r(`3${sep}4,1${sep}2`, '[3,4,1,2]'), r(`2${sep}3,3`, '[2,3,3]'),
      `test('throws', () => { assert.throws(() => parseRange('')); assert.throws(() => parseRange('x${sep}2')); assert.throws(() => parseRange('abc')); });`].join('\n') + '\n';
  },
  generate(v) {
    const sep = SEPS[v % SEPS.length]!;
    return {
      id: `test-parse-range#${v}`, family: 'test-parse-range', category: 'testing', variant: v, difficulty: 2,
      title: `Test suite for parseRange ("${sep}" ranges)`,
      statement: `The module solution.js exports parseRange(str). Write a node:test test file (require('./solution.js')) that passes on a correct implementation and fails on buggy ones. Specification: "a${sep}b" returns the integers from a to b inclusive (counting down when a > b); a part without "${sep}" is a single integer; comma-separated parts are concatenated in order, keeping duplicates and order; empty or non-integer input throws.`,
      deliverable: 'tests', starterCode: impl(sep, null), publicChecks: '', hiddenChecks: '',
      reference: impl(sep, null),
      mutants: (['exclusive', 'desc', 'sort', 'dedupe', 'nothrow'] as const).map((b) => impl(sep, b)),
      publicMutant: impl(sep, 'single'),
    };
  },
};
