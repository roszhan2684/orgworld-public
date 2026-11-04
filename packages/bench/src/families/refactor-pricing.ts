import type { TaskFamily } from '../types.ts';

/** refactoring / difficulty 2: remove duplication + magic numbers while preserving behaviour exactly. */
const VARS = [{ rate: 0.15, min: 120 }, { rate: 0.2, min: 50 }, { rate: 0.1, min: 250 }];
const H = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { priceBook, priceCourse, priceTicket } = require('./solution.js');\n";

const starter = ({ rate, min }: { rate: number; min: number }) => `function priceBook(amount, member) {
  let total = amount;
  if (member && amount >= ${min}) {
    total = amount - amount * ${rate};
  }
  total = Math.round(total * 100) / 100;
  return total;
}
function priceCourse(amount, member) {
  let total = amount;
  if (member && amount >= ${min}) {
    total = amount - amount * ${rate};
  }
  total = Math.round(total * 100) / 100;
  return total + 5;
}
function priceTicket(amount, member) {
  let total = amount;
  if (member && amount >= ${min}) {
    total = amount - amount * ${rate};
  }
  total = Math.round(total * 100) / 100;
  return Math.max(total, 1);
}
module.exports = { priceBook, priceCourse, priceTicket };
`;
const reference = ({ rate, min }: { rate: number; min: number }) => `const DISCOUNT_RATE = ${rate};
const DISCOUNT_MIN = ${min};
const round2 = (x) => Math.round(x * 100) / 100;
function discounted(amount, member) {
  return round2(member && amount >= DISCOUNT_MIN ? amount - amount * DISCOUNT_RATE : amount);
}
const priceBook = (amount, member) => discounted(amount, member);
const priceCourse = (amount, member) => discounted(amount, member) + 5;
const priceTicket = (amount, member) => Math.max(discounted(amount, member), 1);
module.exports = { priceBook, priceCourse, priceTicket };
`;

export const refactorPricing: TaskFamily = {
  id: 'refactor-pricing',
  category: 'refactoring',
  difficulty: 2,
  variants: VARS.length,
  referenceDeliverable: (v) => reference(VARS[v % VARS.length]!),
  generate(v) {
    const p = VARS[v % VARS.length]!;
    const cases: Array<[string, number, boolean]> = [['priceBook', p.min, true], ['priceBook', p.min - 1, true], ['priceCourse', p.min * 2, true], ['priceCourse', 10, false], ['priceTicket', 0.5, false], ['priceTicket', p.min + 33.33, true]];
    const ref = new Function('module', reference(p).replace('module.exports =', 'module.exports =')) as (m: { exports: Record<string, (a: number, b: boolean) => number> }) => void;
    const m = { exports: {} as Record<string, (a: number, b: boolean) => number> };
    ref(m);
    const beh = cases.map(([f, a, b]) => `test(${JSON.stringify(`${f}(${a},${b})`)}, () => assert.strictEqual(${f}(${a}, ${b}), ${m.exports[f]!(a, b)}));`);
    const src = "const src = require('node:fs').readFileSync(__dirname + '/solution.js', 'utf8');\n";
    const structural = [
      `test('rate literal appears at most once', () => assert.ok((src.match(/${String(p.rate).replace('.', '\\.')}(?![0-9])/g) || []).length <= 1));`,
      `test('minimum literal appears at most once', () => assert.ok((src.match(/\\b${p.min}\\b/g) || []).length <= 1));`,
      `test('rounding expression appears at most once', () => assert.ok((src.match(/Math\\.round/g) || []).length <= 1));`,
    ];
    return {
      id: `refactor-pricing#${v}`, family: 'refactor-pricing', category: 'refactoring', variant: v, difficulty: 2,
      title: `Refactor duplicated pricing logic (rate ${p.rate}, min ${p.min})`,
      statement: `solution.js works but duplicates the discount logic three times. Refactor it. Constraints (checked automatically): behaviour of priceBook, priceCourse and priceTicket must be exactly preserved for all inputs; the same three functions must be exported; the literal ${p.rate} may appear at most once, the literal ${p.min} at most once, and Math.round at most once in the file.`,
      deliverable: 'solution', starterCode: starter(p),
      publicChecks: H + beh.slice(0, 2).join('\n') + '\n',
      hiddenChecks: H + src + [...beh, ...structural].join('\n') + '\n',
    };
  },
};
