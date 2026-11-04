import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CognitionError, type CognitionProvider, type CognitionRequest, type CognitionResult } from '../types.ts';

export interface ClaudeCliOptions {
  bin?: string;
  /** Extra env (e.g. to point at a different config dir). Auth is inherited from the parent environment. */
  env?: NodeJS.ProcessEnv;
}

export function resolveClaudeBin(explicit?: string): string {
  const candidates = [explicit, process.env.ORGWORLD_CLAUDE_BIN, process.env.CLAUDE_CODE_EXECPATH].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'claude'; // rely on PATH
}

interface CliJson {
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
}

/**
 * Headless Claude Code (`claude -p`) with a stripped context (ADR-005): no tools, no MCP servers, no skills,
 * no settings, no session persistence, custom system prompt, run from an empty directory so no CLAUDE.md loads.
 * Each call is an isolated reasoning actor. Sampling parameters are NOT controllable (conflict C-07).
 */
export class ClaudeCliProvider implements CognitionProvider {
  readonly id = 'claude-cli' as const;
  private readonly bin: string;
  private readonly cwd: string;
  constructor(private readonly opts: ClaudeCliOptions = {}) {
    this.bin = resolveClaudeBin(opts.bin);
    this.cwd = mkdtempSync(join(tmpdir(), 'orgworld-cog-'));
  }

  async complete(req: CognitionRequest): Promise<CognitionResult> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', req.model,
      '--tools', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--setting-sources', '',
      '--no-session-persistence',
      '--system-prompt', req.system,
    ];
    if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
    const started = Date.now();
    const { stdout, stderr, code, timedOut } = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: this.cwd, env: { ...process.env, ...this.opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let to = false;
      child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
      child.on('error', (e) => reject(new CognitionError(`failed to start claude CLI (${this.bin}): ${e.message}`, false)));
      const timer = setTimeout(() => {
        to = true;
        child.kill('SIGKILL');
      }, req.timeoutMs ?? 180_000);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ stdout: out, stderr: err, code: c, timedOut: to });
      });
      child.stdin.end(req.prompt);
    });
    const latencyMs = Date.now() - started;
    if (timedOut) throw new CognitionError(`claude CLI timed out after ${req.timeoutMs ?? 180_000}ms`, true);
    let parsed: CliJson;
    try {
      parsed = JSON.parse(stdout) as CliJson;
    } catch {
      throw new CognitionError(`claude CLI returned non-JSON (exit ${code}): ${(stderr || stdout).slice(0, 500)}`, true);
    }
    if (parsed.is_error || parsed.subtype !== 'success')
      throw new CognitionError(`claude CLI error (${parsed.subtype ?? 'unknown'}): ${String(parsed.result ?? stderr).slice(0, 500)}`, true);
    // Aggregate usage across all internal iterations/models (structured output may take >1 turn).
    let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, cost = 0;
    const models = Object.keys(parsed.modelUsage ?? {});
    if (models.length) {
      for (const m of Object.values(parsed.modelUsage!)) {
        input += m.inputTokens ?? 0;
        output += m.outputTokens ?? 0;
        cacheRead += m.cacheReadInputTokens ?? 0;
        cacheCreate += m.cacheCreationInputTokens ?? 0;
        cost += m.costUSD ?? 0;
      }
    } else {
      input = parsed.usage?.input_tokens ?? 0;
      output = parsed.usage?.output_tokens ?? 0;
      cacheRead = parsed.usage?.cache_read_input_tokens ?? 0;
      cacheCreate = parsed.usage?.cache_creation_input_tokens ?? 0;
    }
    if (parsed.total_cost_usd !== undefined) cost = parsed.total_cost_usd;
    const text = parsed.result ?? '';
    let json: unknown | null = parsed.structured_output ?? null;
    if (req.jsonSchema && json === null) json = tryParseJson(text);
    return {
      text,
      json,
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreate },
      costUsd: cost,
      model: models[0] ?? req.model,
      provider: 'claude-cli',
      samplingControlled: false,
      latencyMs,
    };
  }
}

export function tryParseJson(text: string): unknown | null {
  const t = text.trim();
  const candidates = [t, t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')];
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return null;
}
