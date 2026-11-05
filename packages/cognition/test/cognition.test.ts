import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnthropicApiProvider, ClaudeCliProvider, CognitionError, costOf, createProvider, OllamaProvider, PaidCognitionRefused, ScriptedProvider, tryParseJson } from '../src/index.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');
const req = { system: 'SYS', prompt: 'PROMPT', model: 'haiku', purpose: 't' };

describe('claude-cli provider (offline, fake binary)', () => {
  it('passes the stripped-context flags, sends prompt via stdin, aggregates usage across models', async () => {
    const p = new ClaudeCliProvider({ bin: fake });
    const r = await p.complete({ ...req, jsonSchema: { type: 'object' } });
    const so = r.json as { args: string[]; stdin: string; cwd: string };
    for (const flag of ['-p', '--tools', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '--no-session-persistence', '--system-prompt', '--json-schema'])
      expect(so.args).toContain(flag);
    expect(so.args[so.args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(so.stdin).toBe('PROMPT');
    expect(so.cwd).toMatch(/orgworld-cog-/); // empty dir: no repo CLAUDE.md leaks into agent context
    expect(r.usage).toEqual({ inputTokens: 110, outputTokens: 22, cacheReadTokens: 5, cacheCreationTokens: 1000 });
    expect(r.costUsd).toBe(0.0123);
    expect(r.provider).toBe('claude-cli');
    expect(r.samplingControlled).toBe(false);
  });
  it('surfaces CLI errors as CognitionError', async () => {
    const prev = process.env.FAKE_CLAUDE_MODE;
    process.env.FAKE_CLAUDE_MODE = 'error';
    try {
      await expect(new ClaudeCliProvider({ bin: fake }).complete(req)).rejects.toBeInstanceOf(CognitionError);
    } finally {
      if (prev === undefined) delete process.env.FAKE_CLAUDE_MODE;
      else process.env.FAKE_CLAUDE_MODE = prev;
    }
  });
});

describe('anthropic-api provider (mock fetch)', () => {
  const pricing = { m: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 } };
  it('computes cost from configured pricing and returns tool JSON', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ model: 'm', content: [{ type: 'tool_use', input: { ok: true } }], usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AnthropicApiProvider({ apiKey: 'k', pricing, fetchImpl });
    const r = await p.complete({ ...req, model: 'm', temperature: 0.2, maxOutputTokens: 77, jsonSchema: { type: 'object' } });
    expect(r.json).toEqual({ ok: true });
    expect(r.costUsd).toBeCloseTo(1 + 0.5);
    expect(r.samplingControlled).toBe(true);
    expect(sent).toMatchObject({ temperature: 0.2, max_tokens: 77, tool_choice: { type: 'tool', name: 'respond' } });
  });
  it('refuses unknown pricing and missing key', async () => {
    await expect(new AnthropicApiProvider({ apiKey: 'k', pricing }).complete({ ...req, model: 'unpriced' })).rejects.toThrow(/no pricing/);
    expect(() => new AnthropicApiProvider({ apiKey: '', pricing })).toThrow(/ANTHROPIC_API_KEY/);
    await expect(new AnthropicApiProvider({ apiKey: 'k', pricing }).complete({ ...req, model: 'unpriced' })).rejects.toMatchObject({ fatal: true });
  });
  it('omits temperature unless configured and labels sampling as uncontrolled (current models reject it)', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ model: 'm', content: [{ type: 'tool_use', input: {} }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new AnthropicApiProvider({ apiKey: 'k', pricing, fetchImpl }).complete({ ...req, model: 'm', jsonSchema: { type: 'object' } });
    expect('temperature' in sent).toBe(false);
    expect(r.samplingControlled).toBe(false);
  });
  it('classifies HTTP errors: 429/529/5xx retryable with retry-after; 400/401/402/403/404 fatal', async () => {
    const respond = (status: number, headers: Record<string, string> = {}) =>
      new AnthropicApiProvider({ apiKey: 'k', pricing, fetchImpl: (async () => new Response('{"error":{}}', { status, headers })) as unknown as typeof fetch }).complete({ ...req, model: 'm' });
    await expect(respond(529)).rejects.toMatchObject({ retryable: true, fatal: false });
    await expect(respond(429, { 'retry-after': '12' })).rejects.toMatchObject({ retryable: true, fatal: false, retryAfterMs: 12_000 });
    await expect(respond(503)).rejects.toMatchObject({ retryable: true });
    for (const s of [400, 401, 402, 403, 404]) await expect(respond(s)).rejects.toMatchObject({ retryable: false, fatal: true });
  });
  it('applies the long-context rate card above its threshold (Claude Haiku 5.5 pricing, 2026-11-04)', () => {
    const haiku = { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125, longContext: { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05, cacheWritePerMTok: 0.625 } };
    expect(costOf(haiku, { inputTokens: 100_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeCloseTo(0.01 + 0.0005, 12);
    expect(costOf(haiku, { inputTokens: 100_001, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeCloseTo(0.0500005 + 0.0025, 12);
  });
  it('takes pricing from the model config', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const p = createProvider({ provider: 'anthropic-api', model: 'm', maxOutputTokensPerCall: 10, pricing }, { allowPaid: true });
      // no network: an unpriced model is refused before any request is made
      await expect(p.complete({ ...req, model: 'other' })).rejects.toThrow(/no pricing configured for model other/);
      expect(p.id).toBe('anthropic-api');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('scripted provider', () => {
  it('is deterministic, labelled, and cannot be created from config', async () => {
    const p = new ScriptedProvider((_r, i) => ({ i }));
    expect((await p.complete(req)).json).toEqual({ i: 0 });
    expect((await p.complete(req)).provider).toBe('scripted');
    expect(() => createProvider({ provider: 'scripted', model: 'x', maxOutputTokensPerCall: 1 })).toThrow(/test-only/);
  });
});

describe('tryParseJson', () => {
  it('handles fenced and embedded JSON', () => {
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('Sure! {"a":2} done')).toEqual({ a: 2 });
    expect(tryParseJson('nope')).toBeNull();
  });
});

describe('spend guard (no money unless explicitly allowed)', () => {
  it('refuses paid providers by default and allows the free local one', () => {
    const prev = process.env.ORGWORLD_ALLOW_PAID;
    delete process.env.ORGWORLD_ALLOW_PAID;
    try {
      expect(() => createProvider({ provider: 'claude-cli', model: 'haiku', maxOutputTokensPerCall: 10 })).toThrow(PaidCognitionRefused);
      expect(() => createProvider({ provider: 'anthropic-api', model: 'x', maxOutputTokensPerCall: 10 })).toThrow(PaidCognitionRefused);
      expect(createProvider({ provider: 'ollama', model: 'qwen2.5-coder:7b', maxOutputTokensPerCall: 10 }).id).toBe('ollama');
      expect(createProvider({ provider: 'claude-cli', model: 'haiku', maxOutputTokensPerCall: 10 }, { allowPaid: true }).id).toBe('claude-cli');
    } finally {
      if (prev !== undefined) process.env.ORGWORLD_ALLOW_PAID = prev;
    }
  });
});

describe('ollama provider (mock fetch, free)', () => {
  it('sends schema/seed/temperature, reports zero cost and controlled sampling', async () => {
    let sent: any = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ message: { content: '{"a":' } }) + '\n' + JSON.stringify({ model: 'qwen', message: { content: '1}' }, done: true, prompt_eval_count: 50, eval_count: 7 }) + '\n', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new OllamaProvider({ seed: 9, fetchImpl }).complete({ ...req, model: 'qwen', temperature: 0.1, jsonSchema: { type: 'object' } });
    expect(r).toMatchObject({ json: { a: 1 }, costUsd: 0, provider: 'ollama', samplingControlled: true, usage: { inputTokens: 50, outputTokens: 7 } });
    expect(sent).toMatchObject({ model: 'qwen', stream: true, format: { type: 'object' }, options: { seed: 9, temperature: 0.1 } });
  });
  it('explains when Ollama is not running', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(new OllamaProvider({ fetchImpl }).complete(req)).rejects.toThrow(/ollama serve/);
  });
  it('raises a request timeout as fatal infrastructure, not a failed agent turn', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const fetchImpl = (async () => { throw timeout; }) as unknown as typeof fetch;
    const err = await new OllamaProvider({ fetchImpl }).complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CognitionError);
    expect(err).toMatchObject({ retryable: false, fatal: true });
  });
});
