import { describe, expect, it } from 'vitest';
import { BudgetLedger, Rng, totalTokens } from '../src/index.ts';

const u = (i: number, o: number, cr = 0, cc = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc });

describe('BudgetLedger', () => {
  it('counts all processed tokens', () => {
    expect(totalTokens(u(10, 5, 100, 1000))).toBe(1115);
  });
  it('refuses calls when calls/tokens/usd exhausted', () => {
    const b = new BudgetLedger({ maxCalls: 2, maxTokens: 1000, reserveTokens: 100, maxUsd: 1 });
    expect(b.canStartCall().ok).toBe(true);
    b.record(u(400, 100), 0.1);
    expect(b.canStartCall().ok).toBe(true);
    b.record(u(350, 100), 0.1); // 950 used, 50 remaining < reserve
    const c = b.canStartCall();
    expect(c.ok).toBe(false);
  });
  it('property: remaining is never negative and overrun is flagged (1000 random sequences)', () => {
    const rng = new Rng(42);
    for (let trial = 0; trial < 1000; trial++) {
      const b = new BudgetLedger({ maxTokens: 1 + rng.int(5000), maxCalls: 1 + rng.int(10), maxUsd: 0.01 + rng.next(), reserveTokens: rng.int(500) });
      for (let k = 0; k < 15; k++) {
        if (!b.canStartCall().ok) break;
        b.record(u(rng.int(2000), rng.int(800)), rng.next() * 0.2);
        const r = b.remaining();
        expect(r.tokens!).toBeGreaterThanOrEqual(0);
        expect(r.calls!).toBeGreaterThanOrEqual(0);
        expect(r.usd!).toBeGreaterThanOrEqual(0);
      }
      expect(b.used.calls).toBeLessThanOrEqual(b.limits.maxCalls!);
      if (b.used.tokens > b.limits.maxTokens!) expect(b.overrun).toBe(true);
    }
  });
  it('rejects invalid limits and costs', () => {
    expect(() => new BudgetLedger({ maxTokens: -1 })).toThrow();
    expect(() => new BudgetLedger({}).record(u(1, 1), -0.5)).toThrow();
  });
});
