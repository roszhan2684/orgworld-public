import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const DENY = [/^\.git(\/|$)/, /^\.orgworld(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.env(\..*)?$/, /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|ed25519)/];

/**
 * Read-only repository access for objective mode. Only enabled with explicit opt-in (build §56: never upload
 * repository contents without explicit configuration). Paths are confined to the root; secrets-like files denied.
 */
export class RepoReader {
  private readonly root: string;
  constructor(root: string) {
    this.root = realpathSync(root);
  }
  private safe(p: string): string {
    const abs = resolve(this.root, p);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new Error(`not found: ${p}`);
    }
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new Error('path escapes repository root');
    const rel = relative(this.root, real).split(sep).join('/');
    if (DENY.some((re) => re.test(rel))) throw new Error(`access to ${rel} is denied`);
    return real;
  }
  list(p = '.'): string {
    const dir = this.safe(p);
    return readdirSync(dir)
      .filter((n) => !DENY.some((re) => re.test(relative(this.root, join(dir, n)).split(sep).join('/'))))
      .slice(0, 200)
      .map((n) => (statSync(join(dir, n)).isDirectory() ? n + '/' : n))
      .join('\n');
  }
  read(p: string, maxBytes = 12_000): string {
    const f = this.safe(p);
    if (statSync(f).isDirectory()) throw new Error('is a directory');
    const buf = readFileSync(f);
    const s = buf.subarray(0, maxBytes).toString('utf8');
    return buf.length > maxBytes ? s + `\n…(truncated, ${buf.length} bytes total)` : s;
  }
}
