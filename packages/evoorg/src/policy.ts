import { Rng } from '@orgworld/core';

/**
 * Stage-1 per-task organization selection (ADR-006). Labels are exact (build §82): this is a bandit, not "RL".
 * Reward signal: task success (Bernoulli) → Beta posteriors per (feature bucket, candidate).
 */
export type PolicyKind = 'random' | 'heuristic' | 'thompson';
export const POLICY_LABEL = { random: 'random baseline', heuristic: 'heuristic policy', thompson: 'bandit policy' } as const;

export interface Selection {
  chosen: string;
  candidates: Array<{ id: string; score: number }>;
  label: (typeof POLICY_LABEL)[PolicyKind];
}

export class OrgPolicy {
  private readonly rng: Rng;
  private readonly post = new Map<string, { a: number; b: number }>();
  constructor(
    readonly kind: PolicyKind,
    readonly candidates: string[],
    seed: number,
    /** heuristic: category → preferred candidate (transparent rule table). */
    private readonly rules: Record<string, string> = {},
  ) {
    if (!candidates.length) throw new Error('policy needs ≥1 candidate');
    this.rng = new Rng(seed);
  }

  private key(bucket: string, c: string) {
    return `${bucket}|${c}`;
  }

  select(bucket: string): Selection {
    const label = POLICY_LABEL[this.kind];
    if (this.kind === 'random') {
      const chosen = this.candidates[this.rng.int(this.candidates.length)]!;
      return { chosen, candidates: this.candidates.map((id) => ({ id, score: 1 / this.candidates.length })), label };
    }
    if (this.kind === 'heuristic') {
      const chosen = this.rules[bucket] && this.candidates.includes(this.rules[bucket]!) ? this.rules[bucket]! : this.candidates[0]!;
      return { chosen, candidates: this.candidates.map((id) => ({ id, score: id === chosen ? 1 : 0 })), label };
    }
    // Thompson sampling: scores are the actual posterior samples used for the choice.
    const samples = this.candidates.map((id) => {
      const p = this.post.get(this.key(bucket, id)) ?? { a: 1, b: 1 };
      return { id, score: this.rng.beta(p.a, p.b) };
    });
    const chosen = samples.reduce((best, s) => (s.score > best.score ? s : best)).id;
    return { chosen, candidates: samples, label };
  }

  update(bucket: string, candidate: string, success: boolean): void {
    if (this.kind !== 'thompson') return;
    const k = this.key(bucket, candidate);
    const p = this.post.get(k) ?? { a: 1, b: 1 };
    this.post.set(k, success ? { a: p.a + 1, b: p.b } : { a: p.a, b: p.b + 1 });
  }

  posterior(bucket: string, candidate: string): { a: number; b: number } {
    return this.post.get(this.key(bucket, candidate)) ?? { a: 1, b: 1 };
  }
}
