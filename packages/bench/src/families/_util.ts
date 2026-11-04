/**
 * Shared helpers for EvoOrgBench task families (not a family itself).
 * Everything here produces plain JavaScript source strings that run inside the sandbox.
 */

export const NODE_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\n";

/** Standard header for a node:test check file that destructures the given exports from ./solution.js. */
export function header(names: readonly string[]): string {
  return `${NODE_TEST}const { ${names.join(', ')} } = require('./solution.js');\n`;
}

/** One node:test case. */
export function tc(name: string, body: string): string {
  return `test(${JSON.stringify(name)}, () => {\n${body}\n});\n`;
}

/** JSON literal for embedding values in generated test source. */
export const lit = (v: unknown): string => JSON.stringify(v);

/** Variant-wrapping accessor (exemplar uses `v % length`). */
export function pick<T>(arr: readonly T[], v: number): T {
  return arr[((v % arr.length) + arr.length) % arr.length]!;
}

/**
 * Applies textual edits to a source string. Each anchor must occur exactly once, so a typo in a
 * mutant/bug definition fails loudly at generate() time instead of silently producing an equivalent copy.
 */
export function mutate(src: string, ...edits: ReadonlyArray<readonly [string, string]>): string {
  let out = src;
  for (const [from, to] of edits) {
    const parts = out.split(from);
    if (parts.length !== 2) throw new Error(`mutation anchor must occur exactly once (found ${parts.length - 1}): ${from}`);
    out = parts.join(to);
  }
  if (out === src) throw new Error('mutation produced identical source');
  return out;
}

/** Statement shared by all testing-category tasks. */
export function testingStatement(opts: { exportsLine: string; mutantCount: number; extra?: string }): string {
  return [
    'Write a test file for the JavaScript module shown in the starter code (a CommonJS module; it will be saved as solution.js next to your test file).',
    `The module exports ${opts.exportsLine}. The implementation shown is CORRECT and its doc comments are the specification.`,
    "Your deliverable is a node:test file: it must load the module with require('./solution.js'), use require('node:test') and require('node:assert'), and contain at least one test().",
    'Scoring: your tests are first run against the correct implementation — every test must pass there, otherwise the score is 0.',
    `They are then run against ${opts.mutantCount} hidden buggy variants of the module (each differs from the correct one in specified behaviour); your score is the fraction of buggy variants for which at least one of your tests fails.`,
    'Only test behaviour that the doc comments specify. Tests run with no network and no file-system writes, with a 10 second timeout.',
    opts.extra ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Non-empty evaluator-only marker for testing-category tasks (scoring uses `mutants`, not this file). */
export function testingHidden(id: string, mutantCount: number): string {
  return `// EvoOrgBench evaluator note for ${id}: testing-category deliverable, scored by the kill rate over ${mutantCount} hidden mutants (BenchTask.mutants).\n// The agent tests must also pass on BenchTask.reference. This file is intentionally not executed.\n`;
}

/**
 * Runtime helpers for refactoring tasks: the ORIGINAL (starter) module is embedded in the check file, so
 * "behaviour must be preserved exactly" is checked by comparing the submission against the original on
 * the same freshly built inputs (return values deep-equal, or same error class and message).
 */
export function refactorPrelude(starter: string): string {
  return `${NODE_TEST}const solution = require('./solution.js');
const __original = (function () {
  const module = { exports: {} };
  (function (module, exports) {
${starter}
  })(module, module.exports);
  return module.exports;
})();
function same(fn, makeArgs) {
  let exp, expErr, got, gotErr;
  try { exp = __original[fn](...makeArgs()); } catch (e) { expErr = e; }
  assert.strictEqual(typeof solution[fn], 'function', fn + ' must be exported as a function');
  try { got = solution[fn](...makeArgs()); } catch (e) { gotErr = e; }
  if (expErr) {
    assert.ok(gotErr, fn + ' should throw ' + expErr.constructor.name + ': ' + expErr.message);
    assert.strictEqual(gotErr.constructor.name, expErr.constructor.name);
    assert.strictEqual(gotErr.message, expErr.message);
  } else {
    if (gotErr) throw gotErr;
    assert.deepStrictEqual(got, exp);
  }
}
`;
}

/**
 * A small, dependency-free JavaScript tokenizer used by structural checks. It skips comments, recognises
 * string / template / regex literals (so braces or keywords inside them are not counted), and records the
 * line of every token. Exposes __structure() → { toks, maxDepth, maxSpan } computed lazily from solution.js.
 */
export const STRUCTURAL_JS = String.raw`
const __KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const __PUNCTS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
function __tokenize(src) {
  const toks = [];
  const stack = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  const push = (type, value, ln) => toks.push({ type, value, line: ln });
  const regexOk = () => {
    const t = toks[toks.length - 1];
    if (!t) return true;
    if (t.type === 'ident') return __KW_BEFORE_REGEX.has(t.value);
    if (t.type === 'punct') return t.value !== ')' && t.value !== ']' && t.value !== '}';
    return false;
  };
  const readTemplate = () => {
    const startLine = line;
    let raw = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { if (src[i + 1] === '\n') line++; raw += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === '${'`'}') { i++; push('tmpl', raw, startLine); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; push('tmpl', raw, startLine); stack.push('tmpl'); return; }
      if (c === '\n') line++;
      raw += c;
      i++;
    }
    throw new Error('unterminated template literal');
  };
  if (src.startsWith('#!')) while (i < n && src[i] !== '\n') i++;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let raw = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { if (src[i + 1] === '\n') line++; raw += src[i] + (src[i + 1] || ''); i += 2; continue; }
        raw += src[i];
        i++;
      }
      i++;
      push('str', raw, startLine);
      continue;
    }
    if (c === '${'`'}') { i++; readTemplate(); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-') && !/^0[xX]/.test(src.slice(i, j))) j += 2;
        else j++;
      }
      push('num', src.slice(i, j), line);
      i = j;
      continue;
    }
    if (/[A-Za-z_$#\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(src[j])) j++;
      push('ident', src.slice(i, j), line);
      i = j;
      continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (inClass) { if (d === ']') inClass = false; }
        else if (d === '[') inClass = true;
        else if (d === '/') break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      push('regex', src.slice(i, j), line);
      i = j;
      continue;
    }
    if (c === '{') { stack.push('{'); push('punct', '{', line); i++; continue; }
    if (c === '}') {
      const top = stack.pop();
      if (top === 'tmpl') { i++; readTemplate(); continue; }
      push('punct', '}', line);
      i++;
      continue;
    }
    let p = __PUNCTS.find((q) => src.startsWith(q, i));
    if (p === '?.' && /[0-9]/.test(src[i + 2] || '')) p = undefined;
    p = p || c;
    push('punct', p, line);
    i += p.length;
  }
  return toks;
}
let __cached = null;
function __structure() {
  if (__cached) return __cached;
  const src = require('node:fs').readFileSync(__dirname + '/solution.js', 'utf8');
  const toks = __tokenize(src);
  let depth = 0;
  let maxDepth = 0;
  let maxSpan = 0;
  const opens = [];
  for (const t of toks) {
    if (t.type !== 'punct') continue;
    if (t.value === '{') { depth++; if (depth > maxDepth) maxDepth = depth; opens.push(t.line); }
    else if (t.value === '}') { depth--; const o = opens.pop(); if (o !== undefined && t.line - o + 1 > maxSpan) maxSpan = t.line - o + 1; }
  }
  __cached = { toks, maxDepth, maxSpan };
  return __cached;
}
function __numLiteralCounts() {
  const counts = new Map();
  for (const t of __structure().toks) {
    if (t.type !== 'num') continue;
    const v = Number(t.value.replace(/_/g, '').replace(/n$/, ''));
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}
function __stringLiteralCount(value) {
  return __structure().toks.filter((t) => (t.type === 'str' || t.type === 'tmpl') && t.value === value).length;
}
`;

/** Structural-check test cases shared by refactoring families. */
export const structural = {
  noVar: () => tc('structure: the var keyword is not used', "const bad = __structure().toks.filter((t) => t.type === 'ident' && t.value === 'var');\nassert.strictEqual(bad.length, 0, 'var used on line(s) ' + bad.map((t) => t.line).join(', '));"),
  noLooseEquality: () =>
    tc('structure: no loose equality operators', "const bad = __structure().toks.filter((t) => t.type === 'punct' && (t.value === '==' || t.value === '!='));\nassert.strictEqual(bad.length, 0, 'loose equality on line(s) ' + bad.map((t) => t.line).join(', '));"),
  noTernary: () => tc('structure: no conditional (ternary) operator', "const bad = __structure().toks.filter((t) => t.type === 'punct' && t.value === '?');\nassert.strictEqual(bad.length, 0, '?: used on line(s) ' + bad.map((t) => t.line).join(', '));"),
  noSwitch: () => tc('structure: no switch statement', "const bad = __structure().toks.filter((t) => t.type === 'ident' && t.value === 'switch');\nassert.strictEqual(bad.length, 0, 'switch used on line(s) ' + bad.map((t) => t.line).join(', '));"),
  maxDepth: (d: number) => tc(`structure: brace nesting depth <= ${d}`, `const s = __structure();\nassert.ok(s.maxDepth <= ${d}, 'max brace depth is ' + s.maxDepth);`),
  maxSpan: (n: number) => tc(`structure: no { } block spans more than ${n} lines`, `const s = __structure();\nassert.ok(s.maxSpan <= ${n}, 'longest { } block spans ' + s.maxSpan + ' lines');`),
  numLiteralsOnce: (exempt: number[]) =>
    tc(
      'structure: each numeric literal (other than the exempt ones) appears at most once',
      `const exempt = new Set(${lit(exempt)});\nconst dup = [...__numLiteralCounts()].filter(([v, c]) => !exempt.has(v) && c > 1);\nassert.deepStrictEqual(dup, [], 'repeated numeric literals [value, count]: ' + JSON.stringify(dup));`,
    ),
  stringOnce: (value: string) =>
    tc(`structure: the string literal ${lit(value)} appears at most once`, `const c = __stringLiteralCount(${lit(value)});\nassert.ok(c <= 1, ${lit(value)} + ' appears ' + c + ' times');`),
  sameExports: (names: string[]) =>
    tc('structure: exports exactly the original names', `assert.deepStrictEqual(Object.keys(solution).sort(), ${lit([...names].sort())});`),
};

export const STRUCTURE_NOTE =
  'Structural checks are computed from the source text of your solution.js with a simple tokenizer: comments are ignored, and so is everything inside string literals, template literals and regular-expression literals (e.g. braces or keywords inside them do not count).';
