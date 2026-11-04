#!/usr/bin/env node
// Fake `claude` binary for offline tests: echoes its argv and stdin inside a CLI-shaped JSON result.
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (process.env.FAKE_CLAUDE_MODE === 'error') {
    process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error_during_execution', result: 'boom' }));
    return;
  }
  const schema = args.includes('--json-schema');
  process.stdout.write(
    JSON.stringify({
      subtype: 'success',
      is_error: false,
      result: schema ? '{"x":1}' : 'plain text',
      structured_output: schema ? { x: 1, args, stdin, cwd: process.cwd() } : undefined,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 2, output_tokens: 3 },
      modelUsage: {
        'claude-haiku-x': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 1000, costUSD: 0.01 },
        'claude-other': { inputTokens: 10, outputTokens: 2, costUSD: 0.0023 },
      },
    }),
  );
});
