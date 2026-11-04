import { CognitionError, type CognitionProvider, type CognitionRequest, type CognitionResult } from '../types.ts';

export interface PricingCard {
  /** USD per million tokens. Must be supplied by configuration — never guessed. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface Pricing extends PricingCard {
  /** A second rate card for long prompts (e.g. Claude Haiku 5.5 above 100,000 prompt tokens). */
  longContext?: PricingCard & { aboveInputTokens: number };
}

export interface AnthropicApiOptions {
  apiKey: string;
  pricing: Record<string, Pricing>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** 408/409/429 and every 5xx (incl. 529 overloaded) are transient; the runner retries them with backoff. */
const RETRYABLE = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;
/** Requests that cannot succeed as configured: bad request, auth, billing, permission, unknown model, too large. */
const FATAL = new Set([400, 401, 402, 403, 404, 413]);

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Messages API provider: honours max_tokens, so budgets can be capped exactly (C-11). */
export class AnthropicApiProvider implements CognitionProvider {
  readonly id = 'anthropic-api' as const;
  constructor(private readonly opts: AnthropicApiOptions) {
    if (!opts.apiKey) throw new CognitionError('ANTHROPIC_API_KEY is required for the anthropic-api provider', false, { fatal: true });
  }

  async complete(req: CognitionRequest): Promise<CognitionResult> {
    const price = this.opts.pricing[req.model];
    if (!price) throw new CognitionError(`no pricing configured for model ${req.model}; refusing to run with unknown cost`, false, { fatal: true });
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 2048,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    };
    // Current models (Haiku 5.5, Sonnet 5.5, Opus 5.5) reject non-default sampling parameters, so temperature is
    // sent only when explicitly configured, and the result is labelled sampling-controlled only then (C-07).
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.jsonSchema) {
      // Forced tool choice: accepted by Claude Haiku 5.5; Sonnet 5.5 / Opus 5.5 reject it (see IMPLEMENTATION_CONFLICTS C-20).
      body.tools = [{ name: 'respond', description: 'Return your response.', input_schema: req.jsonSchema }];
      body.tool_choice = { type: 'tool', name: 'respond' };
    }
    const started = Date.now();
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs ?? 180_000),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      const after = retryAfterMs(res);
      throw new CognitionError(`Anthropic API ${res.status}: ${text}`, RETRYABLE(res.status), { fatal: FATAL.has(res.status), ...(after !== undefined ? { retryAfterMs: after } : {}) });
    }
    const data = (await res.json()) as {
      model: string;
      content: Array<{ type: string; text?: string; input?: unknown }>;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    const text = data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const tool = data.content.find((c) => c.type === 'tool_use');
    const u = data.usage;
    const usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0 };
    return { text, json: tool ? (tool.input ?? null) : null, usage, costUsd: costOf(price, usage), model: data.model, provider: 'anthropic-api', samplingControlled: req.temperature !== undefined, latencyMs: Date.now() - started };
  }
}

/** USD for one response. The long-context card applies when the whole prompt (incl. cache) exceeds its threshold. */
export function costOf(price: Pricing, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const card: PricingCard = price.longContext && prompt > price.longContext.aboveInputTokens ? price.longContext : price;
  return (usage.inputTokens * card.inputPerMTok + usage.outputTokens * card.outputPerMTok + usage.cacheReadTokens * card.cacheReadPerMTok + usage.cacheCreationTokens * card.cacheWritePerMTok) / 1e6;
}
