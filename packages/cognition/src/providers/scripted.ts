import type { CognitionProvider, CognitionRequest, CognitionResult } from '../types.ts';

export type Script = (req: CognitionRequest, callIndex: number) => unknown;

/**
 * TEST-ONLY deterministic provider (ADR-005). Every result is stamped provider:"scripted"; the UI labels such
 * runs "SCRIPTED — not real cognition" and the experiment runner refuses to aggregate them.
 */
export class ScriptedProvider implements CognitionProvider {
  readonly id = 'scripted' as const;
  private calls = 0;
  readonly requests: CognitionRequest[] = [];
  constructor(private readonly script: Script) {}
  async complete(req: CognitionRequest): Promise<CognitionResult> {
    this.requests.push(req);
    const out = this.script(req, this.calls++);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    return {
      text,
      json: typeof out === 'string' ? null : out,
      usage: { inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: Math.ceil(text.length / 4), cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0,
      model: req.model,
      provider: 'scripted',
      samplingControlled: true,
      latencyMs: 0,
    };
  }
}
