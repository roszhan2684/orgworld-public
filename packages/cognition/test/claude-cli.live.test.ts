import { describe, expect, it } from 'vitest';
import { ClaudeCliProvider } from '../src/index.ts';

// LIVE: spends real (tiny) model budget. Run with `pnpm test:live`.
describe.runIf(process.env.ORGWORLD_LIVE === '1' && process.env.ORGWORLD_ALLOW_PAID === '1')('claude-cli provider (live)', () => {
  it('returns schema-valid structured output with real usage', async () => {
    const r = await new ClaudeCliProvider().complete({
      system: 'You are a terse assistant.',
      prompt: 'What is 17 + 25? Answer via the schema.',
      model: 'haiku',
      purpose: 'live-smoke',
      jsonSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
    });
    console.log('LIVE claude-cli:', JSON.stringify({ json: r.json, usage: r.usage, costUsd: r.costUsd, model: r.model, latencyMs: r.latencyMs }));
    expect(r.json).toEqual({ answer: 42 });
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.costUsd).toBeLessThan(0.05);
  });
});
