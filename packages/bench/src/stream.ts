import type { StreamSpec } from '@orgworld/protocol';
import { Rng } from './rng.ts';
import { CATEGORIES, type BenchTask, type TaskCategory, type TaskFamily } from './types.ts';

export interface StreamTask {
  index: number;
  phaseIndex: number;
  phaseId: string;
  task: BenchTask;
}

/**
 * Variant-level split so train/validation/test never share a parameterisation (build §65):
 * variant mod 10 ∈ [0,6] → train, 7 → validation, 8–9 → test. `transfer` uses held-out families instead.
 */
export function variantInSplit(variant: number, split: StreamSpec['split']): boolean {
  const r = variant % 10;
  if (split === 'train') return r <= 6;
  if (split === 'validation') return r === 7;
  if (split === 'test') return r >= 8;
  return true; // transfer: family-level holdout
}

function normalize(mix: Record<string, number>): Array<[TaskCategory, number]> {
  const entries = Object.entries(mix).filter(([, w]) => w > 0) as Array<[TaskCategory, number]>;
  for (const [c] of entries) if (!(CATEGORIES as readonly string[]).includes(c)) throw new Error(`unknown category in mix: ${c}`);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) throw new Error('phase mix has no positive weight');
  return entries.map(([c, w]) => [c, w / total]);
}

function mixAt(spec: StreamSpec, i: number): { phaseIndex: number; mix: Array<[TaskCategory, number]> } {
  const P = spec.phases.length;
  if (spec.kind === 'stationary' || P === 1) return { phaseIndex: 0, mix: normalize(spec.phases[0]!.mix) };
  const seg = spec.tasks / P;
  if (spec.kind === 'abrupt' || spec.kind === 'recurring') {
    const p = Math.min(P - 1, Math.floor(i / seg));
    return { phaseIndex: p, mix: normalize(spec.phases[p]!.mix) };
  }
  // gradual: linear interpolation between consecutive phase centres
  const pos = Math.min(P - 1, Math.max(0, (i + 0.5) / seg - 0.5));
  const lo = Math.floor(pos),
    hi = Math.min(P - 1, lo + 1),
    t = pos - lo;
  const a = Object.fromEntries(normalize(spec.phases[lo]!.mix)),
    b = Object.fromEntries(normalize(spec.phases[hi]!.mix));
  const cats = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<TaskCategory>;
  const mix = [...cats].map((c) => [c, (1 - t) * (a[c] ?? 0) + t * (b[c] ?? 0)] as [TaskCategory, number]);
  return { phaseIndex: Math.round(pos), mix };
}

/** Deterministic given (spec, families). Identical across conditions → paired comparisons (II-§41). */
export function generateStream(spec: StreamSpec, families: readonly TaskFamily[]): StreamTask[] {
  const rng = new Rng(spec.seed);
  const exclude = new Set(spec.excludeFamilies);
  const pool = families.filter((f) => !exclude.has(f.id));
  const used = new Set<string>();
  const out: StreamTask[] = [];
  for (let i = 0; i < spec.tasks; i++) {
    const { phaseIndex, mix } = mixAt(spec, i);
    let u = rng.next();
    let cat: TaskCategory = mix[mix.length - 1]![0];
    for (const [c, w] of mix) {
      if (u < w) {
        cat = c;
        break;
      }
      u -= w;
    }
    const fams = pool.filter((f) => f.category === cat);
    if (fams.length === 0) throw new Error(`no task families available for category ${cat} (after exclusions)`);
    let task: BenchTask | null = null;
    for (let attempt = 0; attempt < 200 && !task; attempt++) {
      const fam = fams[rng.int(fams.length)]!;
      const variant = rng.int(1000);
      if (!variantInSplit(variant, spec.split)) continue;
      const key = `${fam.id}#${variant % fam.variants}`;
      if (used.has(key) && attempt < 150) continue;
      used.add(key);
      task = fam.generate(variant % fam.variants);
    }
    if (!task) throw new Error(`could not sample a task for category ${cat}`);
    out.push({ index: i, phaseIndex, phaseId: spec.phases[phaseIndex]!.id, task });
  }
  return out;
}
