/** Deterministic JSON (sorted keys) — used for hashing configs/genomes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

/** cyrb53-based 2×53-bit hash rendered as hex. Pure JS so it runs in the browser too. Not cryptographic. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const a = (h2 >>> 0).toString(16).padStart(8, '0');
  const b = (h1 >>> 0).toString(16).padStart(8, '0');
  const c = hashSecond(str, seed);
  return a + b + c;
}
function hashSecond(str: string, seed: number): string {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
export const hashObject = (v: unknown): string => hashString(stableStringify(v));

export function newId(prefix: string): string {
  const uuid = globalThis.crypto.randomUUID().replace(/-/g, '');
  return `${prefix}_${uuid.slice(0, 16)}`;
}

/** Seeded PRNG (mulberry32). All research randomness must come through this. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick on empty array');
    return arr[this.int(arr.length)] as T;
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
    }
    return arr;
  }
  /** Gamma(k,1) via Marsaglia–Tsang; used for Beta sampling (Thompson). */
  gamma(k: number): number {
    if (k < 1) return this.gamma(k + 1) * Math.pow(this.next(), 1 / k);
    const d = k - 1 / 3,
      c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  beta(a: number, b: number): number {
    const x = this.gamma(a);
    return x / (x + this.gamma(b));
  }
  normal(): number {
    const u = 1 - this.next(),
      v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…');
