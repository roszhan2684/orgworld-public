import type { TaskFamily } from '../types.ts';
import { header, lit, pick, tc } from './_util.ts';

/**
 * implementation / difficulty 3: tokenizer + recursive-descent evaluator for a small arithmetic grammar whose
 * precedence/associativity rules differ per variant (standard with right-assoc ^ binding tighter than unary minus;
 * unary-tight with left-assoc ^; no precedence at all). Many interacting requirements: unary minus placement,
 * associativity, strict number syntax, SyntaxError vs RangeError.
 */
const VARIANTS = [
  {
    name: 'standard precedence',
    rule: [
      'Precedence, from tightest to loosest:',
      '  1. parentheses;',
      '  2. ^ — RIGHT-associative: 2^3^2 = 2^(3^2) = 512;',
      '  3. unary minus — binds LOOSER than ^: -2^2 = -(2^2) = -4. The right operand of ^ may itself start with unary minus: 2^-1 = 0.5;',
      '  4. * / % — left-associative;',
      '  5. + - — left-associative.',
      'Any operand may start with unary minus (2*-3 = -6, 1 - -1 = 2).',
    ].join('\n'),
  },
  {
    name: 'unary-tight precedence',
    rule: [
      'Precedence, from tightest to loosest:',
      '  1. parentheses;',
      '  2. unary minus — binds TIGHTER than ^: -2^2 = (-2)^2 = 4;',
      '  3. ^ — LEFT-associative: 2^3^2 = (2^3)^2 = 64;',
      '  4. * / % — left-associative;',
      '  5. + - — left-associative.',
      'Any operand may start with unary minus (2*-3 = -6, 2^-1 = 0.5, 1 - -1 = 2).',
    ].join('\n'),
  },
  {
    name: 'no precedence (calculator order)',
    rule: [
      'There is NO operator precedence: all binary operators (+ - * / % ^) have the same precedence and are applied strictly left to right, like a pocket calculator: 2+3*4 = 20, 2^3^2 = 64, 1+2^2 = 9.',
      'Parentheses group as usual: 2+(3*4) = 14.',
      'Unary minus applies only to the operand immediately after it (a number, a parenthesised group, or another unary minus): -2^2 = (-2)^2 = 4, 2*-3 = -6, 2^-1 = 0.5.',
    ].join('\n'),
  },
] as const;

const TOKENIZER = `function tokenize(src) {
  const toks = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\\t') { i++; continue; }
    if (isDigit(c)) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === '.') {
        j++;
        const k = j;
        while (j < src.length && isDigit(src[j])) j++;
        if (j === k) throw new SyntaxError('malformed number');
      }
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if ('+-*/%^()'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new SyntaxError('unexpected character ' + JSON.stringify(c));
  }
  return toks;
}
function apply(op, a, b) {
  if ((op === '/' || op === '%') && b === 0) throw new RangeError('division by zero');
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return a / b;
  if (op === '%') return a % b;
  return Math.pow(a, b);
}
`;

const PARSERS = [
  `  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = toks[p++].t; v = apply(op, v, term()); }
    return v;
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') { const op = toks[p++].t; v = apply(op, v, unary()); }
    return v;
  }
  function unary() {
    if (peek() === '-') { p++; return -unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === '^') { p++; return apply('^', base, unary()); }
    return base;
  }`,
  `  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = toks[p++].t; v = apply(op, v, term()); }
    return v;
  }
  function term() {
    let v = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') { const op = toks[p++].t; v = apply(op, v, power()); }
    return v;
  }
  function power() {
    let v = unary();
    while (peek() === '^') { p++; v = apply('^', v, unary()); }
    return v;
  }
  function unary() {
    if (peek() === '-') { p++; return -unary(); }
    return primary();
  }`,
  `  function expr() {
    let v = unary();
    while (peek() !== undefined && '+-*/%^'.includes(peek())) { const op = toks[p++].t; v = apply(op, v, unary()); }
    return v;
  }
  function unary() {
    if (peek() === '-') { p++; return -unary(); }
    return primary();
  }`,
];

function reference(v: number): string {
  const parser = pick(PARSERS, v);
  return `${TOKENIZER}function evaluate(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => (toks[p] ? toks[p].t : undefined);
${parser}
  function primary() {
    const t = toks[p++];
    if (!t) throw new SyntaxError('unexpected end of input');
    if (t.t === 'num') return t.v;
    if (t.t === '(') {
      const v = expr();
      if (peek() !== ')') throw new SyntaxError('expected )');
      p++;
      return v;
    }
    throw new SyntaxError('unexpected token ' + t.t);
  }
  const v = expr();
  if (p !== toks.length) throw new SyntaxError('unexpected token ' + toks[p].t);
  return v;
}
module.exports = { evaluate };
`;
}

type ValueCase = [expr: string, values: [number, number, number]];
const same = (x: number): [number, number, number] => [x, x, x];

const VALUE_CASES: ValueCase[] = [
  ['1 + 2', same(3)],
  ['  42  ', same(42)],
  ['7 / 2', same(3.5)],
  ['(1 + 2) * 3', same(9)],
  ['--2', same(2)],
  ['-(-3)', same(3)],
  ['2 * -3', same(-6)],
  ['1 - -1', same(2)],
  ['7 % 3', same(1)],
  ['-7 % 3', same(-1)],
  ['10 - 4 - 3', same(3)],
  ['100 / 10 / 5', same(2)],
  ['2 ^ -1', same(0.5)],
  ['1.5 * 4', same(6)],
  ['0.1 + 0.2', same(0.3)],
  ['\t3\t*\t(4 - 1)', same(9)],
  ['((2))', same(2)],
  ['2 ^ 10', same(1024)],
  ['6 / 2 * 3', same(9)],
  ['2 + 3 * 4', [14, 14, 20]],
  ['2 ^ 3 ^ 2', [512, 64, 64]],
  ['-2 ^ 2', [-4, 4, 4]],
  ['1 + 2 ^ 2', [5, 5, 9]],
  ['2 * 3 ^ 2', [18, 18, 36]],
  ['-(2 + 3) ^ 2', [-25, 25, 25]],
  ['8 - 2 ^ 2 * 3', [-4, -4, 108]],
  ['2 * (3 + 4) - 5 % 3', [12, 12, 0]],
  ['-2 ^ -2', [-0.25, 0.25, 0.25]],
  ['2 ^ 2 ^ 3', [256, 64, 64]],
  ['1 - 2 * 3 + 4', [-1, -1, 1]],
];

const SYNTAX_ERRORS = ['', '   ', '1 +', '* 2', '(1 + 2', '1 + 2)', '1 2', '2 $ 3', '.5', '5.', '1.2.3', '+3', '()', '2 (3)', '3 -', '1 + * 2'];
const RANGE_ERRORS = ['1 / 0', '5 % 0', '1 / (2 - 2)'];

export const implExprEval: TaskFamily = {
  id: 'impl-expr-eval',
  category: 'implementation',
  difficulty: 3,
  variants: VARIANTS.length,
  referenceDeliverable: reference,
  generate(v) {
    const idx = ((v % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
    const p = VARIANTS[idx]!;
    const h = header(['evaluate']) + "const near = (got, want) => assert.ok(typeof got === 'number' && Math.abs(got - want) < 1e-9, 'got ' + got + ', want ' + want);\n";
    const valueTest = ([e, vals]: ValueCase) => tc(`evaluate ${lit(e)}`, `near(evaluate(${lit(e)}), ${vals[idx]});`);
    const values = VALUE_CASES.map(valueTest);
    const syntax = SYNTAX_ERRORS.map((e) => tc(`SyntaxError for ${lit(e)}`, `assert.throws(() => evaluate(${lit(e)}), SyntaxError);`));
    const range = RANGE_ERRORS.map((e) => tc(`RangeError for ${lit(e)}`, `assert.throws(() => evaluate(${lit(e)}), RangeError);`));
    const pub = [values[0]!, values[21]!, syntax[4]!];
    return {
      id: `impl-expr-eval#${v}`,
      family: 'impl-expr-eval',
      category: 'implementation',
      variant: v,
      difficulty: 3,
      title: `Arithmetic expression evaluator (${p.name})`,
      statement: [
        'Implement a CommonJS module exporting { evaluate }. evaluate(expr) parses and evaluates the arithmetic expression in the string expr and returns a number.',
        'Tokens: number literals (one or more digits, optionally followed by "." and one or more digits — e.g. 7, 3.25; ".5", "5." and "1.2.3" are malformed), the binary operators + - * / % ^, unary minus "-", and the parentheses ( ). Spaces and tab characters may appear between tokens and are ignored. Any other character is malformed.',
        'Semantics: + - * / % are JavaScript addition, subtraction, multiplication, division and remainder; a ^ b is Math.pow(a, b). Unary minus negates its operand and may be repeated (--2 = 2). There is NO unary plus.',
        p.rule,
        'Errors: malformed input — empty or whitespace-only input, unknown characters, malformed numbers, a missing operand, unbalanced parentheses, empty parentheses, two operands with no operator between them, or a unary plus — throws a SyntaxError. Division or remainder by zero (right operand equal to 0) throws a RangeError. Do not use eval/Function.',
      ].join('\n'),
      deliverable: 'solution',
      starterCode: 'function evaluate(expr) {\n  // TODO: tokenize, parse, evaluate\n}\nmodule.exports = { evaluate };\n',
      publicChecks: h + pub.join(''),
      hiddenChecks: h + [...values, ...syntax, ...range].join(''),
    };
  },
};
