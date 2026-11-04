/** Statistical plan (research II-§41): mean, SD, 95% CI, paired bootstrap, effect size. Seeded for reproducibility. */

export const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);

export function sd(x: number[]): number {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1));
}

/** Two-sided Student-t critical value for 95% CI (exact table for small df, normal beyond). */
export function t95(df: number): number {
  const table = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  return df >= 1 && df <= 30 ? table[df]! : 1.96;
}

export function ci95(x: number[]): { mean: number; lo: number; hi: number; sd: number; n: number } {
  const m = mean(x);
  const s = sd(x);
  const h = x.length > 1 ? (t95(x.length - 1) * s) / Math.sqrt(x.length) : NaN;
  return { mean: m, lo: m - h, hi: m + h, sd: s, n: x.length };
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap CI of the mean paired difference a_i − b_i (identical task sequences across conditions). */
export function pairedBootstrap(a: number[], b: number[], opts: { iterations?: number; seed?: number } = {}): { meanDiff: number; lo: number; hi: number; pGreater: number } {
  if (a.length !== b.length || a.length === 0) throw new Error('paired bootstrap needs equal-length non-empty samples');
  const d = a.map((v, i) => v - b[i]!);
  const R = rng(opts.seed ?? 12345);
  const it = opts.iterations ?? 5000;
  const means: number[] = [];
  for (let k = 0; k < it; k++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(R() * d.length)]!;
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  return { meanDiff: mean(d), lo: means[Math.floor(0.025 * it)]!, hi: means[Math.floor(0.975 * it) - 1]!, pGreater: means.filter((m) => m > 0).length / it };
}

/** Hedges' g (bias-corrected Cohen's d) for two independent samples. */
export function hedgesG(a: number[], b: number[]): number {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const sp = Math.sqrt(((na - 1) * sd(a) ** 2 + (nb - 1) * sd(b) ** 2) / (na + nb - 2));
  if (sp === 0) return 0;
  const d = (mean(a) - mean(b)) / sp;
  return d * (1 - 3 / (4 * (na + nb) - 9));
}
