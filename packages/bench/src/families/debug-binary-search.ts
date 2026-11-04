import type { TaskFamily } from '../types.ts';
import { header, lit, mutate, pick, tc } from './_util.ts';

/**
 * debugging / difficulty 1: binary-search helpers with a classic off-by-one / wrong-bound bug.
 * Variants: lowerBound with a wrong initial hi; upperBound with a wrong hi update; inclusive range count that
 * uses the wrong bound and forgets lo > hi.
 */
const LOWER = `function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
`;
const UPPER = `function upperBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
`;

const VARIANTS = [
  {
    name: 'lowerBound / contains',
    names: ['lowerBound', 'contains'],
    spec: [
      '- lowerBound(arr, x): the smallest index i (0 <= i <= arr.length) such that arr[i] >= x; returns arr.length when every element is < x (and 0 for an empty array).',
      '- contains(arr, x): true if some element of arr is === x, else false.',
    ],
    reference: `${LOWER}function contains(arr, x) {
  const i = lowerBound(arr, x);
  return i < arr.length && arr[i] === x;
}
module.exports = { lowerBound, contains };
`,
    bugs: [['  let hi = arr.length;\n', '  let hi = arr.length - 1;\n']] as Array<[string, string]>,
  },
  {
    name: 'upperBound / countOf',
    names: ['lowerBound', 'upperBound', 'countOf'],
    spec: [
      '- lowerBound(arr, x): the smallest index i (0 <= i <= arr.length) such that arr[i] >= x (arr.length if none).',
      '- upperBound(arr, x): the smallest index i (0 <= i <= arr.length) such that arr[i] > x (arr.length if none).',
      '- countOf(arr, x): the number of elements === x.',
    ],
    reference: `${LOWER}${UPPER}function countOf(arr, x) {
  return upperBound(arr, x) - lowerBound(arr, x);
}
module.exports = { lowerBound, upperBound, countOf };
`,
    bugs: [['    if (arr[mid] <= x) lo = mid + 1;\n    else hi = mid;\n', '    if (arr[mid] <= x) lo = mid + 1;\n    else hi = mid - 1;\n']] as Array<[string, string]>,
  },
  {
    name: 'inclusive range count',
    names: ['lowerBound', 'upperBound', 'countBetween'],
    spec: [
      '- lowerBound(arr, x): the smallest index i (0 <= i <= arr.length) such that arr[i] >= x (arr.length if none).',
      '- upperBound(arr, x): the smallest index i (0 <= i <= arr.length) such that arr[i] > x (arr.length if none).',
      '- countBetween(arr, lo, hi): the number of elements v with lo <= v <= hi (both bounds INCLUSIVE); 0 when lo > hi.',
    ],
    reference: `${LOWER}${UPPER}function countBetween(arr, lo, hi) {
  if (lo > hi) return 0;
  return upperBound(arr, hi) - lowerBound(arr, lo);
}
module.exports = { lowerBound, upperBound, countBetween };
`,
    bugs: [
      ['  if (lo > hi) return 0;\n', ''],
      ['  return upperBound(arr, hi) - lowerBound(arr, lo);\n', '  return lowerBound(arr, hi) - lowerBound(arr, lo);\n'],
    ] as Array<[string, string]>,
  },
] as const;

const ARRAYS: number[][] = [[], [5], [1, 3], [1, 2, 2, 2, 3, 7, 9], [-4, -4, 0, 10], [2, 2, 2, 2]];
const lb = (a: number[], x: number) => {
  let i = 0;
  while (i < a.length && a[i]! < x) i++;
  return i;
};
const ub = (a: number[], x: number) => {
  let i = 0;
  while (i < a.length && a[i]! <= x) i++;
  return i;
};
const probes = (a: number[]) => [...new Set([-10, 0, 2, 3, 4, 100, ...a, ...a.map((x) => x + 1), ...a.map((x) => x - 1)])].sort((p, q) => p - q);

export const debugBinarySearch: TaskFamily = {
  id: 'debug-binary-search',
  category: 'debugging',
  difficulty: 1,
  variants: VARIANTS.length,
  referenceDeliverable: (v) => pick(VARIANTS, v).reference,
  generate(v) {
    const idx = ((v % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
    const p = VARIANTS[idx]!;
    const h = header(p.names);
    const lbTests = ARRAYS.map((a) => tc(`lowerBound on ${lit(a)}`, probes(a).map((x) => `assert.strictEqual(lowerBound(${lit(a)}, ${x}), ${lb(a, x)}, 'x=${x}');`).join('\n')));
    const ubTests = ARRAYS.map((a) => tc(`upperBound on ${lit(a)}`, probes(a).map((x) => `assert.strictEqual(upperBound(${lit(a)}, ${x}), ${ub(a, x)}, 'x=${x}');`).join('\n')));
    let specific: string[];
    let pub: string[];
    if (idx === 0) {
      specific = ARRAYS.map((a) =>
        tc(`contains on ${lit(a)}`, probes(a).map((x) => `assert.strictEqual(contains(${lit(a)}, ${x}), ${a.includes(x)}, 'x=${x}');`).join('\n')),
      );
      pub = [tc('lowerBound basic', 'assert.strictEqual(lowerBound([1, 2, 2, 3], 2), 1);'), tc('contains basic', 'assert.strictEqual(contains([1, 3, 5], 3), true);')];
      specific.unshift(pub[0]!, pub[1]!, ...lbTests);
    } else if (idx === 1) {
      specific = ARRAYS.map((a) =>
        tc(`countOf on ${lit(a)}`, probes(a).map((x) => `assert.strictEqual(countOf(${lit(a)}, ${x}), ${a.filter((y) => y === x).length}, 'x=${x}');`).join('\n')),
      );
      pub = [tc('upperBound basic', 'assert.strictEqual(upperBound([1, 2, 2, 3], 2), 3);'), tc('countOf basic', 'assert.strictEqual(countOf([1, 2, 2, 3], 2), 2);')];
      specific.unshift(pub[0]!, pub[1]!, ...lbTests, ...ubTests);
    } else {
      const ranges: Array<[number, number]> = [[0, 5], [2, 2], [2, 3], [3, 2], [-10, 100], [4, 6], [-4, 0], [10, 10], [11, 20], [7, 9]];
      specific = ARRAYS.map((a) =>
        tc(
          `countBetween on ${lit(a)}`,
          ranges.map(([lo, hi]) => `assert.strictEqual(countBetween(${lit(a)}, ${lo}, ${hi}), ${a.filter((y) => lo <= y && y <= hi).length}, '[${lo}, ${hi}]');`).join('\n'),
        ),
      );
      pub = [tc('countBetween basic', 'assert.strictEqual(countBetween([1, 2, 3, 4], 2, 3), 2);'), tc('upperBound basic', 'assert.strictEqual(upperBound([1, 2, 2, 3], 2), 3);')];
      specific.unshift(pub[0]!, pub[1]!, ...lbTests, ...ubTests);
    }
    const frozen = tc(
      'does not modify the input array',
      `const arr = Object.freeze([1, 2, 2, 5, 8]);
${p.names.map((n) => `${n}(arr, 2${n === 'countBetween' ? ', 5' : ''});`).join('\n')}
assert.deepStrictEqual([...arr], [1, 2, 2, 5, 8]);`,
    );
    return {
      id: `debug-binary-search#${v}`,
      family: 'debug-binary-search',
      category: 'debugging',
      variant: v,
      difficulty: 1,
      title: `Fix the binary search (${p.name})`,
      statement: [
        `The CommonJS module in the starter code is supposed to export { ${p.names.join(', ')} } with the behaviour below, but it contains at least one bug. Find and fix the bug(s); keep the same exports.`,
        'arr is always an array of numbers sorted in ascending order (it may be empty and may contain duplicates); the functions must not modify it. x, lo and hi are numbers.',
        ...p.spec,
      ].join('\n'),
      deliverable: 'solution',
      starterCode: mutate(p.reference, ...p.bugs),
      publicChecks: h + pub.join(''),
      hiddenChecks: h + [...specific, frozen].join(''),
    };
  },
};
