import { PAID_PROVIDERS, type ModelConfig } from '@orgworld/protocol';
import { ClaudeCliProvider } from './providers/claude-cli.ts';
import { AnthropicApiProvider, type Pricing } from './providers/anthropic-api.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { CognitionError, type CognitionProvider } from './types.ts';

export * from './types.ts';
export { ClaudeCliProvider, resolveClaudeBin, tryParseJson } from './providers/claude-cli.ts';
export { AnthropicApiProvider, costOf, type Pricing, type PricingCard } from './providers/anthropic-api.ts';
export { OllamaProvider } from './providers/ollama.ts';
export { ScriptedProvider, type Script } from './providers/scripted.ts';

export class PaidCognitionRefused extends CognitionError {
  constructor(provider: string) {
    super(
      `provider "${provider}" costs money and paid cognition is disabled. ` +
        'Use the free local provider (ollama) or explicitly opt in with --allow-paid / ORGWORLD_ALLOW_PAID=1.',
      false,
    );
    this.name = 'PaidCognitionRefused';
  }
}

export const isPaidProvider = (id: string): boolean => PAID_PROVIDERS.includes(id);

/** Spend guard: paid providers require an explicit opt-in. Default is OFF everywhere (CLI, MCP, plugin, tests). */
export function paidAllowed(explicit?: boolean): boolean {
  return explicit === true || process.env.ORGWORLD_ALLOW_PAID === '1';
}

/** Factory for real providers. `scripted` must be constructed explicitly by tests (never from config). */
export function createProvider(model: ModelConfig, opts: { allowPaid?: boolean; pricing?: Record<string, Pricing> } = {}): CognitionProvider {
  if (isPaidProvider(model.provider) && !paidAllowed(opts.allowPaid)) throw new PaidCognitionRefused(model.provider);
  switch (model.provider) {
    case 'claude-cli':
      return new ClaudeCliProvider();
    case 'anthropic-api':
      // Prices come from the run's model config (or the caller); with none, the provider refuses to run (fatal).
      return new AnthropicApiProvider({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', pricing: opts.pricing ?? model.pricing ?? {} });
    case 'ollama':
      return new OllamaProvider(model.seed !== undefined ? { seed: model.seed } : {});
    case 'scripted':
      throw new CognitionError('the scripted provider is test-only and cannot be created from configuration', false);
  }
}
