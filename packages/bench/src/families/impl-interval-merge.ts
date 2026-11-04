import type { TaskFamily } from '../types.ts';
import { header, lit, pick, tc } from './_util.ts';

/**
 * implementation / difficulty 2: merge intervals under a variant-specific boundary semantics
 * (closed reals, inclusive integer ranges where adjacency merges, open intervals where touching does not merge
 * and empty intervals vanish). Boundary handling is where first attempts usually go wrong.
 */
type Iv = [number, number];
type Case = { name: string; input: Iv[]; out: [Iv[], Iv[], Iv[]] };

const VARIANTS = [
  {
    name: 'closed intervals',
    join: 'iv[0] <= last[1]',
    dropEmpty: false,
    rule:
      'Intervals are CLOSED: [a, b] contains every real x with a <= x <= b. Two intervals must be merged whenever they share at least one point, so [1, 3] and [3, 5] become [1, 5], while [1, 2] and [2.5, 4] stay separate. A degenerate interval [a, a] is a single point; it is kept (and merges with intervals containing a).',
  },
  {
    name: 'inclusive integer ranges',
    join: 'iv[0] <= last[1] + 1',
    dropEmpty: false,
    rule:
      'Intervals are INCLUSIVE INTEGER RANGES: all bounds are integers and [a, b] denotes the integers a, a+1, …, b. Two ranges must be merged whenever they overlap OR are adjacent (no integer lies between them), so [1, 3] and [4, 6] become [1, 6], while [1, 3] and [5, 6] stay separate. A range [a, a] contains one integer and is kept.',
  },
  {
    name: 'open intervals',
    join: 'iv[0] < last[1]',
    dropEmpty: true,
    rule:
      'Intervals are OPEN: [a, b] denotes (a, b), every real x with a < x < b. Two intervals must be merged whenever they share at least one point, so (1, 3) and (2, 5) become (1, 5), while (1, 3) and (3, 5) stay separate because 3 belongs to neither. An interval [a, a] is EMPTY: it must not appear in the output and never causes a merge.',
  },
] as const;

const CASES: Case[] = [
  { name: 'empty input', input: [], out: [[], [], []] },
  { name: 'unsorted overlapping', input: [[8, 9], [1, 4], [2, 6]], out: [[[1, 6], [8, 9]], [[1, 6], [8, 9]], [[1, 6], [8, 9]]] },
  { name: 'shared endpoint', input: [[1, 3], [3, 5]], out: [[[1, 5]], [[1, 5]], [[1, 3], [3, 5]]] },
  { name: 'gap of one', input: [[1, 2], [3, 4]], out: [[[1, 2], [3, 4]], [[1, 4]], [[1, 2], [3, 4]]] },
  { name: 'containment', input: [[1, 10], [2, 3], [4, 5]], out: [[[1, 10]], [[1, 10]], [[1, 10]]] },
  { name: 'single degenerate', input: [[5, 5]], out: [[[5, 5]], [[5, 5]], []] },
  { name: 'degenerate at start', input: [[5, 5], [5, 7]], out: [[[5, 7]], [[5, 7]], [[5, 7]]] },
  { name: 'negative bounds', input: [[-5, -1], [-1, 0], [2, 2]], out: [[[-5, 0], [2, 2]], [[-5, 0], [2, 2]], [[-5, -1], [-1, 0]]] },
  { name: 'point between touching', input: [[1, 3], [3, 3], [3, 5]], out: [[[1, 5]], [[1, 5]], [[1, 3], [3, 5]]] },
  { name: 'equal starts', input: [[0, 1], [0, 4], [0, 2]], out: [[[0, 4]], [[0, 4]], [[0, 4]]] },
  { name: 'degenerate inside', input: [[2, 2], [1, 3]], out: [[[1, 3]], [[1, 3]], [[1, 3]]] },
  { name: 'only points', input: [[1, 1], [2, 2]], out: [[[1, 1], [2, 2]], [[1, 2]], []] },
  { name: 'single interval', input: [[3, 7]], out: [[[3, 7]], [[3, 7]], [[3, 7]]] },
  { name: 'chain', input: [[10, 12], [1, 3], [4, 6], [7, 9]], out: [[[1, 3], [4, 6], [7, 9], [10, 12]], [[1, 12]], [[1, 3], [4, 6], [7, 9], [10, 12]]] },
];

/** Cases with non-integer bounds (not valid for the integer-range variant). */
const REAL_CASES: Array<{ name: string; input: Iv[]; out: Iv[]; variants: number[] }> = [
  { name: 'small gap (reals)', input: [[1, 2], [2.5, 4]], out: [[1, 2], [2.5, 4]], variants: [0, 2] },
  { name: 'three-way overlap (reals)', input: [[1, 3], [2.5, 3.5], [3, 5]], out: [[1, 5]], variants: [0, 2] },
  { name: 'separate ranges', input: [[1, 3], [5, 6]], out: [[1, 3], [5, 6]], variants: [1] },
  { name: 'adjacent points', input: [[3, 4], [1, 1], [2, 2]], out: [[1, 4]], variants: [1] },
];

function reference(v: number): string {
  const p = pick(VARIANTS, v);
  return `function merge(intervals) {
  const list = [];
  for (const iv of intervals) {
    const a = iv[0];
    const b = iv[1];
    if (a > b) throw new RangeError('interval start must not exceed its end');
${p.dropEmpty ? '    if (a === b) continue;\n' : ''}    list.push([a, b]);
  }
  list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && ${p.join}) {
      if (iv[1] > last[1]) last[1] = iv[1];
    } else {
      out.push([iv[0], iv[1]]);
    }
  }
  return out;
}
module.exports = { merge };
`;
}

export const implIntervalMerge: TaskFamily = {
  id: 'impl-interval-merge',
  category: 'implementation',
  difficulty: 2,
  variants: VARIANTS.length,
  referenceDeliverable: reference,
  generate(v) {
    const idx = ((v % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
    const p = VARIANTS[idx]!;
    const h = header(['merge']);
    const caseTest = (name: string, input: Iv[], out: Iv[]) => tc(`merge: ${name}`, `assert.deepStrictEqual(merge(${lit(input)}), ${lit(out)});`);
    const all = CASES.map((c) => caseTest(c.name, c.input, c.out[idx]!));
    const real = REAL_CASES.filter((c) => c.variants.includes(idx)).map((c) => caseTest(c.name, c.input, c.out));
    const mutationExpected: Iv[][] = [[[1, 4], [5, 6]], [[1, 6]], [[1, 4], [5, 6]]];
    const noMutation = tc(
      'merge: does not modify its input and returns fresh arrays',
      `const input = [[5, 6], [1, 3], [2, 4]];
const snapshot = JSON.parse(JSON.stringify(input));
const out = merge(input);
assert.deepStrictEqual(input, snapshot);
assert.deepStrictEqual(out, ${lit(mutationExpected[idx])});
assert.notStrictEqual(out, input);
for (const iv of out) for (const orig of input) assert.notStrictEqual(iv, orig);`,
    );
    const rangeError = tc('merge: start > end throws RangeError', 'assert.throws(() => merge([[1, 2], [4, 3]]), RangeError);');
    const pub = [all[1]!, all[2]!];
    return {
      id: `impl-interval-merge#${v}`,
      family: 'impl-interval-merge',
      category: 'implementation',
      variant: v,
      difficulty: 2,
      title: `Merge intervals (${p.name})`,
      statement: [
        'Implement a CommonJS module exporting { merge }.',
        'merge(intervals) takes an array of intervals, each a two-element array [start, end] of finite numbers, and returns the union of the input as a NEW array of NEW two-element arrays: the minimal list of disjoint intervals that cannot be merged any further, sorted by start ascending.',
        p.rule,
        'The input array and its inner arrays must not be modified, and no returned interval may be the same array object as an input interval. merge([]) returns [].',
        'If any interval has start > end, throw a RangeError.',
      ].join('\n'),
      deliverable: 'solution',
      starterCode: 'function merge(intervals) {\n  // TODO\n}\nmodule.exports = { merge };\n',
      publicChecks: h + pub.join(''),
      hiddenChecks: h + [...all, ...real, noMutation, rangeError].join(''),
    };
  },
};
