import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CheckResult {
  passed: number;
  failed: number;
  total: number;
  timedOut: boolean;
  durationMs: number;
  /** Truncated TAP output (failure diagnostics included). */
  output: string;
  /** True if the test file could not run at all (syntax error in submission, crash, etc.). */
  crashed: boolean;
}

export interface SandboxOptions {
  timeoutMs?: number;
  maxOldSpaceMb?: number;
}

/**
 * Runs a node:test file against submitted files in an isolated temp dir using Node's permission model:
 * fs reads limited to the sandbox dir, no fs writes, no child processes, no workers (build §56).
 * NOTE: network access is NOT restricted by Node 22's permission model (documented limitation).
 */
export async function runNodeTests(files: Record<string, string>, testFile: string, opts: SandboxOptions = {}): Promise<CheckResult> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgworld-sbx-')));
  const start = Date.now();
  try {
    for (const [name, content] of Object.entries(files)) {
      if (name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new Error(`illegal sandbox file name ${name}`);
      writeFileSync(join(dir, name), content);
    }
    if (!(testFile in files)) throw new Error(`test file ${testFile} not provided`);
    const args = [
      '--permission',
      `--allow-fs-read=${dir}`,
      `--max-old-space-size=${opts.maxOldSpaceMb ?? 128}`,
      '--test-reporter=tap',
      '--no-warnings',
      join(dir, testFile),
    ];
    const res = await new Promise<{ out: string; code: number | null; timedOut: boolean }>((resolve) => {
      const child = spawn(process.execPath, args, { cwd: dir, env: { NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let timedOut = false;
      const cap = (b: Buffer) => {
        if (out.length < 200_000) out += b.toString('utf8');
      };
      child.stdout.on('data', cap);
      child.stderr.on('data', cap);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs ?? 10_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ out, code, timedOut });
      });
    });
    const num = (k: string) => {
      const m = res.out.match(new RegExp(`^# ${k} (\\d+)`, 'm'));
      return m ? Number(m[1]) : null;
    };
    const total = num('tests');
    const passed = num('pass');
    const failed = num('fail');
    const crashed = total === null || total === 0;
    return {
      total: total ?? 0,
      passed: crashed ? 0 : (passed ?? 0),
      failed: crashed ? 0 : (failed ?? 0),
      timedOut: res.timedOut,
      durationMs: Date.now() - start,
      output: summarizeTap(res.out.replaceAll(dir, '<sandbox>')),
      crashed,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Keeps summary lines and failing-test diagnostics, drops passing-test noise. */
function summarizeTap(tap: string): string {
  const lines = tap.split('\n');
  const keep: string[] = [];
  let inFail = false;
  for (const l of lines) {
    if (/^not ok /.test(l) || /^# (tests|pass|fail|cancelled|duration_ms)/.test(l)) keep.push(l);
    if (/^not ok /.test(l)) inFail = true;
    else if (/^ok /.test(l)) inFail = false;
    else if (inFail && /^\s+(error|expected|actual|message|code):/.test(l)) keep.push(l);
    else if (!/^(TAP version|ok |\s|# Subtest)/.test(l) && l.trim() && !l.startsWith('#')) keep.push(l); // syntax errors, crashes
  }
  const s = keep.join('\n');
  return s.length > 6000 ? s.slice(0, 6000) + '\n…(truncated)' : s;
}
