import { CognitionError, type CognitionProvider, type CognitionRequest, type CognitionResult } from '../types.ts';

export interface OllamaOptions {
  baseUrl?: string;
  seed?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Free, local cognition via Ollama (no money involved). Supports JSON-schema structured output, temperature and
 * seed, so sampling IS controlled (resolves conflict C-07 for runs that use it). Cost is always 0.
 */
export class OllamaProvider implements CognitionProvider {
  readonly id = 'ollama' as const;
  constructor(private readonly opts: OllamaOptions = {}) {}

  async complete(req: CognitionRequest): Promise<CognitionResult> {
    const started = Date.now();
    const options: Record<string, unknown> = { num_predict: req.maxOutputTokens ?? 2048, temperature: req.temperature ?? 0 };
    if (this.opts.seed !== undefined) options.seed = this.opts.seed;
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          stream: true,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
          ...(req.jsonSchema ? { format: req.jsonSchema } : {}),
          options,
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? 600_000),
      });
    } catch (err) {
      // Connection refused/reset is transient (the runner backs off, then stops the run as an infrastructure failure).
      // A request timeout is not retried: the same slow call would just time out again.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new CognitionError(`cannot reach Ollama (is \`ollama serve\` running?): ${err instanceof Error ? err.message : String(err)}`, !timedOut);
    }
    if (!res.ok) throw new CognitionError(`Ollama ${res.status}: ${(await res.text()).slice(0, 400)}`, res.status >= 500);
    // Streamed NDJSON: avoids fetch's 300 s header timeout on slow (e.g. CPU-only) machines.
    let text = '';
    let data: { model?: string; prompt_eval_count?: number; eval_count?: number } = {};
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string; model?: string; prompt_eval_count?: number; eval_count?: number };
        if (chunk.error) throw new CognitionError(`Ollama: ${chunk.error}`, true);
        text += chunk.message?.content ?? '';
        if (chunk.done) data = chunk;
      }
    }
    let json: unknown | null = null;
    if (req.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      text,
      json,
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0,
      model: data.model ?? req.model,
      provider: 'ollama',
      samplingControlled: true,
      latencyMs: Date.now() - started,
    };
  }
}
