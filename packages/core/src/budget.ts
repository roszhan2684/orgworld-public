import type { Usage } from '@orgworld/protocol';

export interface BudgetLimits {
  maxTokens?: number | undefined;
  maxCalls?: number | undefined;
  maxUsd?: number | undefined;
  /** Refuse a new call when remaining tokens < reserve (conflict C-11). */
  reserveTokens?: number | undefined;
}

export interface BudgetUsage {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  usd: number;
}

/** All processed tokens count against the budget: fresh input + cache reads + cache writes + output. */
export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
}

export type BudgetCheck = { ok: true } | { ok: false; resource: 'tokens' | 'calls' | 'usd'; detail: string };

/**
 * Enforceable budget (build §35, research III Control 1–3).
 * Invariant: `remaining()` values are never negative; overruns (at most one call) are recorded via `overrun`.
 */
export class BudgetLedger {
  readonly used: BudgetUsage = { tokens: 0, inputTokens: 0, outputTokens: 0, calls: 0, usd: 0 };
  constructor(readonly limits: BudgetLimits) {
    for (const [k, v] of Object.entries(limits)) if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new Error(`invalid budget limit ${k}=${v}`);
  }

  canStartCall(): BudgetCheck {
    const L = this.limits;
    if (L.maxCalls !== undefined && this.used.calls >= L.maxCalls) return { ok: false, resource: 'calls', detail: `${this.used.calls}/${L.maxCalls} calls used` };
    if (L.maxTokens !== undefined && L.maxTokens - this.used.tokens < (L.reserveTokens ?? 0))
      return { ok: false, resource: 'tokens', detail: `${this.used.tokens}/${L.maxTokens} tokens used (reserve ${L.reserveTokens ?? 0})` };
    if (L.maxUsd !== undefined && this.used.usd >= L.maxUsd) return { ok: false, resource: 'usd', detail: `$${this.used.usd.toFixed(4)}/$${L.maxUsd} used` };
    return { ok: true };
  }

  record(usage: Usage, costUsd: number): void {
    if (costUsd < 0 || !Number.isFinite(costUsd)) throw new Error(`invalid cost ${costUsd}`);
    this.used.calls += 1;
    this.used.tokens += totalTokens(usage);
    this.used.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
    this.used.outputTokens += usage.outputTokens;
    this.used.usd += costUsd;
  }

  remaining(): { tokens: number | null; calls: number | null; usd: number | null } {
    const L = this.limits;
    return {
      tokens: L.maxTokens === undefined ? null : Math.max(0, L.maxTokens - this.used.tokens),
      calls: L.maxCalls === undefined ? null : Math.max(0, L.maxCalls - this.used.calls),
      usd: L.maxUsd === undefined ? null : Math.max(0, L.maxUsd - this.used.usd),
    };
  }

  get overrun(): boolean {
    const L = this.limits;
    return (L.maxTokens !== undefined && this.used.tokens > L.maxTokens) || (L.maxUsd !== undefined && this.used.usd > L.maxUsd);
  }
}
