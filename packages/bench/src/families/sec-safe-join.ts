import type { TaskFamily } from '../types.ts';

/** security / difficulty 2: path-traversal-safe join with variant extension allow-lists. */
const VARS = [{ ext: ['.txt', '.md'] }, { ext: ['.json'] }, { ext: ['.png', '.jpg', '.gif'] }];
const H = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { safeJoin } = require('./solution.js');\n";

const reference = (ext: string[]) => `const path = require('node:path');
const ALLOWED = ${JSON.stringify(ext)};
function safeJoin(base, user) {
  if (typeof user !== 'string' || user.length === 0 || user.includes('\\0')) throw new Error('invalid path');
  if (path.isAbsolute(user) || /^[a-zA-Z]:/.test(user) || user.startsWith('\\\\')) throw new Error('absolute path');
  const root = path.resolve(base);
  const full = path.resolve(root, user.split('\\\\').join('/'));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('traversal');
  if (!ALLOWED.includes(path.extname(full).toLowerCase())) throw new Error('extension not allowed');
  return full;
}
module.exports = { safeJoin };
`;
const vulnerable = (ext: string[]) => `const path = require('node:path');
const ALLOWED = ${JSON.stringify(ext)};
function safeJoin(base, user) {
  const full = path.join(base, user);
  if (!ALLOWED.some((e) => full.endsWith(e))) throw new Error('extension not allowed');
  return full;
}
module.exports = { safeJoin };
`;

export const secSafeJoin: TaskFamily = {
  id: 'sec-safe-join',
  category: 'security',
  difficulty: 2,
  variants: VARS.length,
  referenceDeliverable: (v) => reference(VARS[v % VARS.length]!.ext),
  generate(v) {
    const ext = VARS[v % VARS.length]!.ext;
    const ok = `doc${ext[0]}`;
    const t = (n: string, body: string) => `test(${JSON.stringify(n)}, () => { ${body} });`;
    const rej = (u: string) => `assert.throws(() => safeJoin('/srv/data', ${JSON.stringify(u)}));`;
    return {
      id: `sec-safe-join#${v}`, family: 'sec-safe-join', category: 'security', variant: v, difficulty: 2,
      title: `Path-traversal-safe join (${ext.join(', ')})`,
      statement: `solution.js exports safeJoin(base, userPath) used to serve user-requested files. It currently has security bugs. Fix it so that it returns the absolute resolved path inside base for legitimate requests (including nested folders like "a/b/${ok}"), and THROWS for: paths escaping base (any "..", including encoded-looking or backslash forms such as "a\\\\..\\\\..\\\\x${ext[0]}"), absolute paths, Windows drive paths ("C:..."), empty strings, strings containing a NUL byte, and files whose extension (case-insensitive) is not one of ${ext.join(', ')}. Use only node built-ins.`,
      deliverable: 'solution', starterCode: vulnerable(ext),
      publicChecks: H + [t('serves a file', `assert.strictEqual(safeJoin('/srv/data', '${ok}'), '/srv/data/${ok}');`), t('blocks ..', rej(`../etc/passwd${ext[0]}`))].join('\n') + '\n',
      hiddenChecks: H + [
        t('serves nested file', `assert.strictEqual(safeJoin('/srv/data', 'a/b/${ok}'), '/srv/data/a/b/${ok}');`),
        t('case-insensitive ext', `assert.strictEqual(safeJoin('/srv/data', 'X${ext[0]!.toUpperCase()}'), '/srv/data/X${ext[0]!.toUpperCase()}');`),
        t('inner .. that stays inside is fine', `assert.strictEqual(safeJoin('/srv/data', 'a/../${ok}'), '/srv/data/${ok}');`),
        t('blocks parent', rej(`../x${ext[0]}`)), t('blocks deep parent', rej(`a/../../x${ext[0]}`)), t('blocks backslash traversal', rej(`a\\..\\..\\x${ext[0]}`)),
        t('blocks absolute', rej(`/etc/x${ext[0]}`)), t('blocks drive', rej(`C:x${ext[0]}`)), t('blocks empty', rej('')), t('blocks NUL', rej(`a\u0000${ext[0]}`)),
        t('blocks other ext', rej('a.exe')), t('blocks sibling prefix', rej(`../data2/x${ext[0]}`)),
      ].join('\n') + '\n',
    };
  },
};
