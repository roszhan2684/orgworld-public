import type { TaskFamily } from '../types.ts';
import { header, lit, mutate, pick, tc } from './_util.ts';

/**
 * debugging / difficulty 2: a pagination helper with 2 subtle bugs per variant
 * (wrong page count formula + wrong default; input mutation via splice + off-by-one hasNext;
 * `||` default swallowing an invalid 0 + reporting the requested instead of the effective page size).
 */
interface Variant {
  name: string;
  spec: string[];
  reference: string;
  bugs: Array<[string, string]>;
  oracle: (n: number, page: number, size?: number) => Record<string, unknown> | 'RangeError';
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const VARIANTS: Variant[] = [
  {
    name: '1-based, clamped',
    spec: [
      'paginate(items, page, pageSize = 10)',
      '- Pages are numbered from 1. pageSize must be an integer >= 1, otherwise throw a RangeError; when pageSize is undefined the default 10 is used.',
      '- totalPages = Math.ceil(items.length / pageSize) (so 0 for an empty list).',
      '- The effective page is `page` clamped into the range [1, max(1, totalPages)].',
      '- Returns { items, page, pageSize, totalPages, hasPrev, hasNext } where items is a NEW array with the elements of the effective page, page is the effective page, hasPrev = page > 1 and hasNext = page < totalPages.',
    ],
    reference: `function paginate(items, page, pageSize = 10) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  const totalPages = Math.ceil(items.length / pageSize);
  const current = Math.min(Math.max(1, page), Math.max(1, totalPages));
  const start = (current - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: current,
    pageSize,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
  };
}
module.exports = { paginate };
`,
    bugs: [
      ['function paginate(items, page, pageSize = 10) {', 'function paginate(items, page, pageSize = 20) {'],
      ['  const totalPages = Math.ceil(items.length / pageSize);', '  const totalPages = Math.floor(items.length / pageSize) + 1;'],
    ],
    oracle(n, page, size = 10) {
      if (!Number.isInteger(size) || size < 1) return 'RangeError';
      const totalPages = Math.ceil(n / size);
      const cur = Math.min(Math.max(1, page), Math.max(1, totalPages));
      const start = (cur - 1) * size;
      return { items: range(n).slice(start, start + size), page: cur, pageSize: size, totalPages, hasPrev: cur > 1, hasNext: cur < totalPages };
    },
  },
  {
    name: '0-based, out-of-range is empty',
    spec: [
      'paginate(items, page, pageSize = 25)',
      '- Pages are numbered from 0. pageSize must be an integer >= 1, otherwise throw a RangeError; when pageSize is undefined the default 25 is used.',
      '- totalPages = max(1, Math.ceil(items.length / pageSize)) — an empty list has exactly one (empty) page.',
      '- For an in-range page (0 <= page < totalPages): items is a NEW array with that page\'s elements, hasPrev = page > 0, hasNext = page < totalPages - 1.',
      '- For an out-of-range page: items = [], hasPrev = false, hasNext = false.',
      '- Returns { items, page, pageSize, totalPages, hasPrev, hasNext } with page returned unchanged. The input array must never be modified.',
    ],
    reference: `function paginate(items, page, pageSize = 25) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  if (page < 0 || page >= totalPages) {
    return { items: [], page, pageSize, totalPages, hasPrev: false, hasNext: false };
  }
  const start = page * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalPages,
    hasPrev: page > 0,
    hasNext: page < totalPages - 1,
  };
}
module.exports = { paginate };
`,
    bugs: [
      ['    items: items.slice(start, start + pageSize),', '    items: items.splice(start, pageSize),'],
      ['    hasNext: page < totalPages - 1,', '    hasNext: page < totalPages,'],
    ],
    oracle(n, page, size = 25) {
      if (!Number.isInteger(size) || size < 1) return 'RangeError';
      const totalPages = Math.max(1, Math.ceil(n / size));
      if (page < 0 || page >= totalPages) return { items: [], page, pageSize: size, totalPages, hasPrev: false, hasNext: false };
      const start = page * size;
      return { items: range(n).slice(start, start + size), page, pageSize: size, totalPages, hasPrev: page > 0, hasNext: page < totalPages - 1 };
    },
  },
  {
    name: '1-based, capped page size',
    spec: [
      'paginate(items, page, pageSize)',
      '- Pages are numbered from 1. When pageSize is undefined the default 10 is used. Otherwise pageSize must be an integer >= 1, else throw a RangeError (in particular pageSize 0 is an error, not "use the default").',
      '- Page sizes above 100 are capped: the effective page size is min(pageSize, 100), and it is the effective size that is used everywhere and returned.',
      '- totalPages = Math.ceil(items.length / effectivePageSize) (0 for an empty list).',
      '- The effective page is `page` clamped into [1, max(1, totalPages)].',
      '- Returns { items, page, pageSize, totalPages, hasPrev, hasNext }: items is a NEW array with the elements of the effective page, page and pageSize are the effective values, hasPrev = page > 1, hasNext = page < totalPages.',
    ],
    reference: `const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
function paginate(items, page, pageSize) {
  if (pageSize === undefined) pageSize = DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  const size = Math.min(pageSize, MAX_PAGE_SIZE);
  const totalPages = Math.ceil(items.length / size);
  const current = Math.min(Math.max(1, page), Math.max(1, totalPages));
  const start = (current - 1) * size;
  return {
    items: items.slice(start, start + size),
    page: current,
    pageSize: size,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
  };
}
module.exports = { paginate };
`,
    bugs: [
      ['  if (pageSize === undefined) pageSize = DEFAULT_PAGE_SIZE;', '  pageSize = pageSize || DEFAULT_PAGE_SIZE;'],
      ['    pageSize: size,', '    pageSize,'],
    ],
    oracle(n, page, size = 10) {
      if (!Number.isInteger(size) || size < 1) return 'RangeError';
      const eff = Math.min(size, 100);
      const totalPages = Math.ceil(n / eff);
      const cur = Math.min(Math.max(1, page), Math.max(1, totalPages));
      const start = (cur - 1) * eff;
      return { items: range(n).slice(start, start + eff), page: cur, pageSize: eff, totalPages, hasPrev: cur > 1, hasNext: cur < totalPages };
    },
  },
];

/** [itemCount, page, pageSize|undefined] */
const CASES: Array<[number, number, number | undefined]> = [
  [25, 1, undefined],
  [25, 2, undefined],
  [25, 3, undefined],
  [30, 3, undefined],
  [30, 2, 10],
  [20, 1, 10],
  [20, 2, 10],
  [7, 1, 3],
  [7, 3, 3],
  [9, 3, 3],
  [9, 0, 3],
  [9, 2, 3],
  [9, 4, 3],
  [9, -2, 3],
  [0, 1, undefined],
  [0, 0, undefined],
  [0, 1, 5],
  [5, 1, 1],
  [5, 5, 1],
  [60, 1, undefined],
  [60, 2, 25],
  [50, 1, 25],
  [50, 2, 25],
  [130, 2, 500],
  [250, 1, 150],
  [250, 3, 150],
];
const BAD_SIZES = [0, -1, 2.5, '10', null, NaN];

export const debugPagination: TaskFamily = {
  id: 'debug-pagination',
  category: 'debugging',
  difficulty: 2,
  variants: VARIANTS.length,
  referenceDeliverable: (v) => pick(VARIANTS, v).reference,
  generate(v) {
    const p = pick(VARIANTS, v);
    const h = header(['paginate']) + 'const list = (n) => Array.from({ length: n }, (_, i) => i + 1);\n';
    const call = (n: number, page: number, size: number | undefined) => `paginate(list(${n}), ${page}${size === undefined ? '' : `, ${size}`})`;
    const caseTests = CASES.map(([n, page, size]) => {
      const exp = p.oracle(n, page, size);
      return tc(`${n} items, page ${page}, pageSize ${size ?? 'default'}`, `assert.deepStrictEqual(${call(n, page, size)}, ${lit(exp)});`);
    });
    const badSizes = tc(
      'invalid page sizes throw RangeError',
      BAD_SIZES.map((s) => `assert.throws(() => paginate(list(5), 1, ${s === null ? 'null' : Number.isNaN(s) ? 'NaN' : lit(s)}), RangeError, ${lit(String(s))});`).join('\n'),
    );
    const noMutation = tc(
      'does not modify the input and returns a fresh items array',
      `const input = list(12);
const r1 = paginate(input, ${p.name.startsWith('0') ? 0 : 1}, 5);
const r2 = paginate(input, ${p.name.startsWith('0') ? 1 : 2}, 5);
assert.deepStrictEqual(input, list(12));
assert.notStrictEqual(r1.items, input);
assert.deepStrictEqual(r2.items, [6, 7, 8, 9, 10]);`,
    );
    const pub = [caseTests[0]!, caseTests[7]!];
    return {
      id: `debug-pagination#${v}`,
      family: 'debug-pagination',
      category: 'debugging',
      variant: v,
      difficulty: 2,
      title: `Fix the paginator (${p.name})`,
      statement: [
        'The CommonJS module in the starter code exports { paginate } but contains bugs. Fix it so that it implements exactly this specification (keep the same export):',
        ...p.spec,
        'items is an array (never modified). page is an integer (possibly out of range or negative).',
      ].join('\n'),
      deliverable: 'solution',
      starterCode: mutate(p.reference, ...p.bugs),
      publicChecks: h + pub.join(''),
      hiddenChecks: h + [...caseTests, badSizes, noMutation].join(''),
    };
  },
};
