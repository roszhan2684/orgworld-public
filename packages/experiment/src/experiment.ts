import { ExperimentConfig, EvolutionConfig, FeatureFlags, type ExperimentConfigInput, type OrganizationGenome } from '@orgworld/protocol';
import { hashObject, presetGenome, validateGenome } from '@orgworld/core';
import type { EventStore } from '@orgworld/store';
import type { CognitionProvider } from '@orgworld/cognition';
import { FAMILIES, generateStream } from '@orgworld/bench';
import { buildRunConfig, createRun, InfrastructureError, OrgRunner, type RetryPolicy } from '@orgworld/runtime';
import { ci95, pairedBootstrap, runMetrics, type RunMetrics } from '@orgworld/metrics';
import { designForTask, EvolutionController, OrgPolicy, type HistoryItem, type PolicyKind } from '@orgworld/evoorg';

const NOT_IMPLEMENTED = new Set(['agentconductor-style', 'metagen-style', 'tacomas-style', 'oracle']);

export interface ConditionResult {
  conditionId: string;
  condition: string;
  runs: string[];
  metrics: RunMetrics[];
  cumulativeReward: ReturnType<typeof ci95>;
  successRate: ReturnType<typeof ci95>;
  lifetimeTokens: ReturnType<typeof ci95>;
  lifetimeUsd: ReturnType<typeof ci95>;
  /** Fraction of tasks run with a reviewer reachable from the entry agent (safety study, II-§63). */
  reviewerCoverage: ReturnType<typeof ci95>;
  /** Success rate on security-category tasks (runs without security tasks are omitted). */
  securitySuccess: ReturnType<typeof ci95>;
}

export type ComparisonMetric = 'cumulativeReward' | 'reviewerCoverage' | 'securitySuccess' | 'lifetimeTokens';

export interface ExperimentResult {
  experimentId: string;
  configHash: string;
  /** infra-stopped: the model service failed; re-running the same command resumes (C-19). */
  status: 'completed' | 'budget-stopped' | 'infra-stopped';
  scripted: boolean;
  conditions: ConditionResult[];
  /**
   * Paired bootstrap (a − b) over repetitions with identical task sequences. Default: EvoOrg minus each other
   * condition on cumulative reward; with `comparisons` in the config, each listed pair on every ComparisonMetric.
   */
  comparisons: Array<{ a: string; b: string; metric: ComparisonMetric; meanDiff: number; lo: number; hi: number; n: number }>;
  notes: string[];
}

export interface RunExperimentOptions {
  store: EventStore;
  config: ExperimentConfigInput;
  experimentId?: string;
  /** Creates the cognition provider (one per run). Paid providers are refused upstream unless explicitly allowed. */
  provider: () => CognitionProvider;
  log?: (m: string) => void;
  /** Model-call retry policy passed to every runner (tests use tiny delays). */
  retry?: Partial<RetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
}

const COMPARISON_METRICS: Record<ComparisonMetric, (m: RunMetrics) => number> = {
  cumulativeReward: (m) => m.cumulativeReward,
  reviewerCoverage: (m) => m.verification.rate,
  securitySuccess: (m) => m.successByCategory.security?.rate ?? NaN,
  lifetimeTokens: (m) => m.lifetime.tokens,
};

/** Why a stored run cannot be used in aggregates, or null if it can (C-19). */
function unusableReason(store: EventStore, runId: string, status: string): string | null {
  if (status === 'completed') return null;
  if (status === 'failed') {
    const f = store.events(runId).find((e) => e.type === 'RUN_FAILED');
    return f && f.type === 'RUN_FAILED' && f.payload.infrastructure ? `infrastructure failure: ${f.payload.error.slice(0, 160)}` : null;
  }
  return `interrupted (status ${status})`;
}

/**
 * Money already spent by this experiment in earlier invocations, so a resumed experiment keeps its $ ceiling.
 * Each run counts its own model calls once: main runs minus the validation cost attributed to them, plus every
 * validation shadow run (which holds that cost directly, even if its parent stopped before attributing it).
 */
export function experimentSpendUsd(store: EventStore, experimentId: string): number {
  let usd = 0;
  for (const r of store.listRuns({ experimentId })) {
    const s = store.runState(r.runId);
    const shadow = s.config?.label?.startsWith('validation shadow') ?? false;
    usd += shadow ? s.costs.total.usd : s.costs.total.usd - s.costs.byCategory.validation.usd;
  }
  return usd;
}

/**
 * Research experiment runner (build §63–§67, research II-§23–§41, III §3–§5). Locks the configuration, runs every
 * condition × repetition on the SAME task stream, enforces matched budgets and a total $ ceiling, keeps every run
 * (including failures), and aggregates with CIs and paired bootstrap. Never fabricates or drops results.
 */
export async function runExperiment(opts: RunExperimentOptions): Promise<ExperimentResult> {
  const cfg = ExperimentConfig.parse(opts.config);
  for (const c of cfg.conditions) if (NOT_IMPLEMENTED.has(c.condition)) throw new Error(`condition ${c.condition} is registered but not implemented in v0.1 (conflict C-05)`);
  const ids = new Set(cfg.conditions.map((c) => c.id));
  for (const p of cfg.comparisons ?? []) if (!ids.has(p.a) || !ids.has(p.b)) throw new Error(`comparison ${p.a} − ${p.b} names an unknown condition id`);
  // Every starting organization must satisfy its own Ω before anything is spent.
  const startGenome = (c: (typeof cfg.conditions)[number]): OrganizationGenome => {
    const base = presetGenome(c.preset);
    const g = c.constraints ? { ...base, constraints: { ...base.constraints, ...c.constraints } } : base;
    const v = validateGenome(g);
    if (!v.ok) throw new Error(`condition ${c.id}: starting organization violates its constraints: ${v.errors.join('; ')}`);
    return g;
  };
  for (const c of cfg.conditions) startGenome(c);
  const configHash = hashObject(cfg);
  const experimentId = opts.experimentId ?? `exp_${configHash.slice(0, 12)}`;
  const { store } = opts;
  // Pre-registration lock (II-§67): config hash frozen; changing it later throws.
  store.upsertExperiment({ experimentId, name: cfg.experiment.name, config: cfg, configHash, status: 'locked', lockedAt: new Date().toISOString() });
  const log = opts.log ?? (() => {});
  const notes: string[] = [];
  let spentUsd = experimentSpendUsd(store, experimentId);
  if (spentUsd > 0) log(`resuming: $${spentUsd.toFixed(4)} already spent by earlier invocations`);
  let status: ExperimentResult['status'] = 'completed';
  const runsBy: Record<string, string[]> = {};

  outer: for (let rep = 0; rep < cfg.repetitions; rep++) {
    const stream = generateStream({ ...cfg.stream, seed: cfg.stream.seed + rep }, FAMILIES);
    for (const cond of cfg.conditions) {
      // Resumable and append-only: a usable stored run is kept; an infrastructure-failed or interrupted one stays
      // in the store, is excluded from aggregates, and the slot is re-attempted under a new id (C-19).
      const base = `${experimentId}-${cond.id}-r${rep + 1}`;
      let runId = base;
      for (let attempt = 2; ; attempt++) {
        const row = store.getRun(runId);
        const why = row ? unusableReason(store, runId, row.status) : null;
        if (!why) break;
        notes.push(`${runId} kept but excluded from aggregates (${why}); re-attempted as ${base}-a${attempt}`);
        runId = `${base}-a${attempt}`;
      }
      if (store.getRun(runId)) {
        (runsBy[cond.id] ??= []).push(runId);
        continue; // never re-run or overwritten
      }
      const genome: OrganizationGenome = startGenome(cond);
      const evolution = EvolutionConfig.parse({ ...(cond.evolution ?? {}), enabled: cond.condition === 'evoorg' || cond.condition === 'random-evolution', ...(cond.condition === 'random-evolution' ? { proposer: 'random' } : {}) });
      const runCfg = buildRunConfig({
        runId,
        mode: 'experiment',
        kind: 'stream',
        condition: cond.condition,
        label: `${cfg.experiment.name} · ${cond.id} · rep ${rep + 1}`,
        experimentId,
        streamId: `${cfg.stream.kind}-${cfg.stream.seed + rep}`,
        genome,
        model: cfg.controls.model,
        budget: cfg.controls.budget,
        reward: cfg.controls.reward,
        seeds: { benchmark: cfg.stream.seed + rep, taskOrder: cfg.stream.seed + rep, organization: rep + 1, mutation: rep + 1 },
        features: FeatureFlags.parse({ ...cfg.controls.features, ...(cond.features ?? {}) }),
        ablations: cond.ablations,
        evolution,
        policy: cond.policy ?? { kind: 'none', candidates: [] },
      });
      createRun(store, runCfg);
      (runsBy[cond.id] ??= []).push(runId);
      const provider = opts.provider();
      const runner = new OrgRunner({ store, provider, runId, log: (m) => log(`[${cond.id} r${rep + 1}] ${m}`), ...(opts.retry ? { retry: opts.retry } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) });
      runner.instantiate(genome, `preset ${cond.preset}`);
      runner.start();
      const controller = new EvolutionController({ runner, provider, config: evolution, ablations: cond.ablations, seed: rep + 1 });
      const pol = cond.policy && cond.policy.kind !== 'none' && cond.policy.candidates.length ? new OrgPolicy(cond.policy.kind as PolicyKind, cond.policy.candidates, rep + 1) : null;
      const history: HistoryItem[] = [];
      let phase = -1;
      try {
        for (const st of stream) {
          if (cfg.controls.maxTotalUsd !== undefined && spentUsd + runner.state.costs.total.usd >= cfg.controls.maxTotalUsd) {
            status = 'budget-stopped';
            notes.push(`stopped at ${runId} task ${st.index}: experiment $ ceiling ${cfg.controls.maxTotalUsd} reached`);
            runner.complete({ stopped: 'experiment budget ceiling', tasks: history.length });
            spentUsd += runner.state.costs.total.usd;
            break outer;
          }
          if (st.phaseIndex !== phase) {
            phase = st.phaseIndex;
            runner.emit1({ type: 'PHASE_CHANGED', actorId: 'runtime', payload: { phaseIndex: phase, phaseId: st.phaseId, mix: cfg.stream.phases[phase]?.mix ?? {} } });
          }
          const spec = { kind: 'bench' as const, task: st.task, taskIndex: st.index, phaseId: st.phaseId, split: cfg.stream.split };
          if (cond.condition === 'per-task-adaptive') {
            const g = await designForTask(runner, spec, { base: genome });
            runner.adoptGenome(g, { type: 'ORGANIZATION_INSTANTIATED', actorId: 'controller', payload: { genome: g, reason: 'per-task design (no persistence)' } });
          } else if (cond.ablations.includes('no-persistence') && history.length) {
            runner.adoptGenome(genome, { type: 'ORGANIZATION_INSTANTIATED', actorId: 'runtime', payload: { genome, reason: 'A1 no-persistence reset' } });
          }
          let chosen: string | null = null;
          if (pol) {
            const sel = pol.select(st.task.category);
            chosen = sel.chosen;
            runner.emit([
              { type: 'RL_STATE_OBSERVED', actorId: 'controller', payload: { policyKind: pol.kind, taskId: null, features: { category: st.task.category, phase: st.phaseId } } },
              { type: 'RL_ACTION_SELECTED', actorId: 'controller', payload: { policyKind: pol.kind, label: sel.label, taskId: null, candidates: sel.candidates, chosen } },
            ]);
            const g = presetGenome(chosen);
            if (runner.genome.preset !== g.preset) runner.adoptGenome(g, { type: 'ORGANIZATION_INSTANTIATED', actorId: 'controller', payload: { genome: g, reason: `${sel.label} choice` } });
          }
          const outcome = await runner.runTask(spec);
          if (pol && chosen) pol.update(st.task.category, chosen, outcome.success);
          history.push({ index: st.index, spec, outcome });
          if (cond.condition !== 'per-task-adaptive') await controller.afterTask(history, phase);
        }
        if (runner.state.status === 'running') runner.complete({ tasks: history.length, successes: history.filter((h) => h.outcome.success).length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof InfrastructureError) {
          // The model service failed, not the agents: keep the run, exclude it, and stop so a later invocation resumes.
          runner.fail(msg, { infrastructure: true });
          spentUsd += runner.state.costs.total.usd;
          (runsBy[cond.id] ??= []).pop();
          status = 'infra-stopped';
          notes.push(`stopped at ${runId}: ${msg}. The run is kept but excluded from aggregates; run the same command again to resume.`);
          break outer;
        }
        runner.fail(msg); // failed runs are kept (build §96)
        notes.push(`run ${runId} failed: ${msg}`);
      }
      spentUsd += runner.state.costs.total.usd;
    }
  }

  // Aggregate (metrics include validation shadow costs via MUTATION_VALIDATED attribution).
  const conditions: ConditionResult[] = cfg.conditions.map((c) => {
    const runs = runsBy[c.id] ?? [];
    const metrics = runs.map((id) => runMetrics(store.events(id)));
    return {
      conditionId: c.id,
      condition: c.condition,
      runs,
      metrics,
      cumulativeReward: ci95(metrics.map((m) => m.cumulativeReward)),
      successRate: ci95(metrics.map((m) => m.successRate)),
      lifetimeTokens: ci95(metrics.map((m) => m.lifetime.tokens)),
      lifetimeUsd: ci95(metrics.map((m) => m.lifetime.usd)),
      reviewerCoverage: ci95(metrics.map((m) => m.verification.rate)),
      securitySuccess: ci95(metrics.map(COMPARISON_METRICS.securitySuccess).filter(Number.isFinite)),
    };
  });
  const scripted = conditions.some((c) => c.metrics.some((m) => m.scripted));
  if (scripted) notes.push('SCRIPTED provider used: these numbers test the pipeline and are NOT research results.');
  const evo = conditions.find((c) => c.condition === 'evoorg');
  const comparisons: ExperimentResult['comparisons'] = [];
  const byId = new Map(conditions.map((c) => [c.conditionId, c]));
  const pairs = cfg.comparisons ?? (evo ? conditions.filter((c) => c !== evo).map((c) => ({ a: evo.conditionId, b: c.conditionId })) : []);
  const metricsFor: ComparisonMetric[] = cfg.comparisons ? (Object.keys(COMPARISON_METRICS) as ComparisonMetric[]) : ['cumulativeReward'];
  for (const p of pairs) {
    const A = byId.get(p.a)!;
    const B = byId.get(p.b)!;
    const n = Math.min(A.metrics.length, B.metrics.length); // repetitions run in order, so the first n are paired
    if (n < 1) continue;
    for (const metric of metricsFor) {
      const f = COMPARISON_METRICS[metric];
      const xs = A.metrics.slice(0, n).map(f);
      const ys = B.metrics.slice(0, n).map(f);
      const keep = xs.map((x, i) => Number.isFinite(x) && Number.isFinite(ys[i]!));
      const a = xs.filter((_, i) => keep[i]);
      const b = ys.filter((_, i) => keep[i]);
      if (!a.length) continue;
      const r = pairedBootstrap(a, b);
      comparisons.push({ a: p.a, b: p.b, metric, meanDiff: r.meanDiff, lo: r.lo, hi: r.hi, n: a.length });
    }
  }
  const result: ExperimentResult = { experimentId, configHash, status, scripted, conditions, comparisons, notes };
  store.upsertExperiment({ experimentId, name: cfg.experiment.name, config: cfg, configHash, status, results: { ...result, conditions: conditions.map(({ metrics: _m, ...rest }) => rest) } });
  return result;
}

/** Research data export (build §62): one row per run, flat columns for Python/R/Jupyter. */
export function resultsCsv(r: ExperimentResult): string {
  const head = ['experiment_id', 'condition_id', 'condition', 'run_id', 'provider', 'scripted', 'tasks', 'successes', 'success_rate', 'cumulative_reward', 'lifetime_tokens', 'lifetime_usd', 'validation_tokens', 'messages_per_task', 'generation', 'mutations_accepted', 'mutations_rejected', 'churn_per100', 'first_half_life', 'contaminated', 'reviewer_coverage', 'reviewer_coverage_by_phase', 'first_uncovered_task', 'security_success_rate', 'audit_complete'];
  const rows = r.conditions.flatMap((c) =>
    c.metrics.map((m, i) => [
      r.experimentId, c.conditionId, c.condition, c.runs[i], m.provider, m.scripted, m.tasks, m.successes, m.successRate.toFixed(4), m.cumulativeReward.toFixed(4), m.lifetime.tokens, m.lifetime.usd.toFixed(6), m.lifetime.byCategory.validation.tokens, m.communication.messagesPerTask.toFixed(3), m.generation, m.mutations.accepted, m.mutations.rejected, m.churn.per100.toFixed(3), m.halfLives[0]?.halfLife ?? '', m.contaminated,
      m.verification.rate.toFixed(4),
      Object.entries(m.verification.byPhase).map(([p, b]) => `${p}:${b.rate.toFixed(4)}`).join(' '),
      m.verification.firstUncoveredIndex ?? '',
      m.successByCategory.security ? m.successByCategory.security.rate.toFixed(4) : '',
      m.audit.complete,
    ]),
  );
  return [head, ...rows].map((r2) => r2.map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v))).join(',')).join('\n') + '\n';
}
