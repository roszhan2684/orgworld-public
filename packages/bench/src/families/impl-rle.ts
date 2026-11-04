import type { TaskFamily } from '../types.ts';

/**
 * EXEMPLAR FAMILY (pattern for all others).
 * implementation / difficulty 1: run-length encode + decode with a variant-specific output format.
 */
const FORMATS = [
  { name: 'count-first', enc: (c: string, n: number) => `${n}${c}`, example: '"aaab" → "3a1b"' },
  { name: 'char-first', enc: (c: string, n: number) => `${c}${n}`, example: '"aaab" → "a3b1"' },
  { name: 'bracketed', enc: (c: string, n: number) => `${c}[${n}]`, example: '"aaab" → "a[3]b[1]"' },
] as const;

function reference(v: number): string {
  const f = FORMATS[v % FORMATS.length]!;
  const encBody = f.name === 'count-first' ? 'out += n + c;' : f.name === 'char-first' ? 'out += c + n;' : "out += c + '[' + n + ']';";
  const decRe = f.name === 'count-first' ? '/(\\d+)(\\D)/g' : f.name === 'char-first' ? '/(\\D)(\\d+)/g' : '/(.)\\[(\\d+)\\]/g';
  const decBody = f.name === 'count-first' ? 'out += m[2].repeat(Number(m[1]));' : 'out += m[1].repeat(Number(m[2]));';
  return `function encode(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i]; let n = 0;
    while (i < s.length && s[i] === c) { i++; n++; }
    ${encBody}
  }
  return out;
}
function decode(s) {
  let out = ''; const re = ${decRe}; let m;
  while ((m = re.exec(s)) !== null) { ${decBody} }
  return out;
}
module.exports = { encode, decode };
`;
}

export const implRle: TaskFamily = {
  id: 'impl-rle',
  category: 'implementation',
  difficulty: 1,
  variants: FORMATS.length,
  referenceDeliverable: reference,
  generate(v) {
    const f = FORMATS[v % FORMATS.length]!;
    const e = (s: string) => {
      let out = '';
      for (let i = 0; i < s.length; ) {
        const c = s[i]!;
        let n = 0;
        while (i < s.length && s[i] === c) (i++, n++);
        out += f.enc(c, n);
      }
      return out;
    };
    const pub = ['aaab', 'abc'];
    const hidden = ['', 'a', 'zzzzzzzzzzzz', 'aabbbcccc', 'abababab', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyz'];
    const t = (s: string) => `test(${JSON.stringify('encode ' + s)}, () => assert.strictEqual(encode(${JSON.stringify(s)}), ${JSON.stringify(e(s))}));`;
    const rt = (s: string) => `test(${JSON.stringify('roundtrip ' + s)}, () => assert.strictEqual(decode(encode(${JSON.stringify(s)})), ${JSON.stringify(s)}));`;
    const header = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { encode, decode } = require('./solution.js');\n";
    return {
      id: `impl-rle#${v}`,
      family: 'impl-rle',
      category: 'implementation',
      variant: v,
      difficulty: 1,
      title: `Run-length encoding (${f.name})`,
      statement: `Implement a CommonJS module exporting { encode, decode }.\nencode(s) run-length encodes a string of letters using the ${f.name} format, e.g. ${f.example}. Runs may be longer than 9.\ndecode(s) reverses encode exactly. encode('') === ''.`,
      deliverable: 'solution',
      starterCode: "function encode(s) {\n  // TODO\n}\nfunction decode(s) {\n  // TODO\n}\nmodule.exports = { encode, decode };\n",
      publicChecks: header + pub.map(t).join('\n') + '\n',
      hiddenChecks: header + [...hidden.map(t), ...hidden.map(rt)].join('\n') + '\n',
    };
  },
};
