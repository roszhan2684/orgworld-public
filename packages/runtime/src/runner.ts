import {
  ORGWORLD_VERSION,
  EVOORG_VERSION,
  EVENT_SCHEMA_VERSION,
  GENOME_SCHEMA_VERSION,
  RESEARCH_PROTOCOL_VERSION,
  RunConfig,
  type CallCategory,
  type EventDraft,
  type OrgEvent,
  type OrganizationGenome,
  type RunConfigInput,
} from '@orgworld/protocol';
import {
  applyEvent,
  BudgetLedger,
  canSubmit,
  capabilitiesOf,
  diffGenomes,
  hasEdge,
  hashObject,
  hashString,
  newId,
  roleOf,
  totalTokens,
  truncate,
  type WorldState,
} from '@orgworld/core';
import type { EventStore } from '@orgworld/store';
import { CognitionError, type CognitionProvider, type CognitionResult } from '@orgworld/cognition';
import { evaluateDeliverable, publicView, runPublicChecks } from '@orgworld/bench';
import { MEETING_JSON_SCHEMA, parseAction, SELF_CONTINUING, TURN_JSON_SCHEMA, VOTE_JSON_SCHEMA, type Action } from './actions.ts';
import { IMPLEMENTED_POLICIES, resolveDecision, type Ballot } from './decisions.ts';
import { MemoryIndex, type MemoryItem } from './memory.ts';
import { allowedActions, systemPrompt, taskBrief, turnPrompt } from './prompts.ts';
import { RepoReader } from './repo-tools.ts';
import { InfrastructureError } from './errors.ts';
import { afterTaskLearning, deliberate, planPaths, taskStartLearning, usesDeliberation } from './organization.ts';
import type { TaskOutcome, TaskSpec } from './tasks.ts';

export class RunStopped extends Error {}

export { InfrastructureError } from './errors.ts';

export interface RetryPolicy {
  /** Total attempts per model call, including the first. */
  maxAttempts: number;
  /** First backoff; doubles each attempt up to maxDelayMs. A server `retry-after` is honoured if longer. */
  baseDelayMs: number;
  maxDelayMs: number;
}

/** ≈ 5 minutes of waiting in total (2+4+8+16+32+60+60+60+60 s) before a call is declared an infrastructure failure. */
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 10, baseDelayMs: 2_000, maxDelayMs: 60_000 };

export function backoffMs(policy: RetryPolicy, failedAttempt: number, retryAfterMs?: number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failedAttempt - 1));
  return Math.min(Math.max(exp, retryAfterMs ?? 0), 5 * policy.maxDelayMs);
}

export interface RunnerOptions {
  store: EventStore;
  provider: CognitionProvider;
  runId: string;
  /** Model-call retry policy for transient provider errors (default DEFAULT_RETRY). */
  retry?: Partial<RetryPolicy>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Category attributed to every model call in this run (shadow validation runs use 'validation'). */
  callCategory?: CallCategory;
  /** Objective mode only: explicit opt-in to read repository files (build §56). */
  repoRoot?: string | null;
  log?: (msg: string) => void;
}

/** Fills versions/environment so every run records what produced it (build §60, research II-§42). */
export function buildRunConfig(input: Omit<RunConfigInput, 'versions' | 'environment'> & Partial<Pick<RunConfigInput, 'versions' | 'environment'>>): RunConfig {
  return RunConfig.parse({
    ...input,
    versions: {
      orgworld: ORGWORLD_VERSION,
      evoorg: EVOORG_VERSION,
      eventSchema: EVENT_SCHEMA_VERSION,
      genomeSchema: GENOME_SCHEMA_VERSION,
      researchProtocol: RESEARCH_PROTOCOL_VERSION,
      ...(input.versions ?? {}),
    },
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, ...(input.environment ?? {}) },
  });
}

export function createRun(store: EventStore, config: RunConfig): RunConfig {
  if (store.lastSequence(config.runId) > 0) throw new Error(`run ${config.runId} already exists`);
  store.append(config.runId, { type: 'RUN_CREATED', actorId: 'runtime', payload: { config } });
  return config;
}

/** Per-task working state (internal; shared with organization.ts). */
export interface TaskCtx {
  taskId: string;
  spec: TaskSpec;
  ledger: BudgetLedger;
  queue: string[];
  turns: number;
  submitted: { artifactId: string; by: string } | null;
  lastTurnSeq: Record<string, number>;
  reasoning: Record<string, string[]>;
  pendingFeedback: Record<string, string[]>;
  pendingMemories: Record<string, MemoryItem[]>;
  structuralChangesBefore: number;
  stalls: number;
  /** Learning memories (lessons, playbook) offered at task start, scored when the task ends (C-21). */
  learningIds: string[];
  /** The plan chosen by multi-path planning and its predicted success (C-21). */
  plan: { planId: string; predicted: number; agentId: string } | null;
}

/**
 * Executes an organization (one run). Every state change goes through `emit` → EventStore → reducer.
 * Agents are separate cognition calls with separate contexts built only from what each agent knows.
 */
export class OrgRunner {
  readonly store: EventStore;
  readonly provider: CognitionProvider;
  readonly runId: string;
  readonly config: RunConfig;
  readonly state: WorldState;
  readonly memory = new MemoryIndex();
  readonly runLedger: BudgetLedger;
  private readonly category: CallCategory;
  private readonly repo: RepoReader | null;
  private readonly log: (msg: string) => void;
  private toolCalls = 0;
  private pendingStructuralChanges = 0;
  /** Shared with validation shadow runners so they retry the same way. */
  readonly retry: RetryPolicy;
  readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RunnerOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.runId = opts.runId;
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.state = opts.store.runState(opts.runId);
    if (!this.state.config) throw new Error(`run ${opts.runId} has no RUN_CREATED event`);
    this.config = this.state.config;
    this.category = opts.callCategory ?? 'task';
    this.repo = opts.repoRoot ? new RepoReader(opts.repoRoot) : null;
    this.log = opts.log ?? (() => {});
    const pr = this.config.budget.perRun;
    this.runLedger = new BudgetLedger({ maxTokens: pr.maxTokens, maxCalls: pr.maxCalls, maxUsd: pr.maxUsd });
    // Replay existing consumption so a resumed run keeps its run-level budget.
    this.runLedger.used.calls = this.state.costs.total.calls;
    this.runLedger.used.tokens = this.state.costs.total.tokens;
    this.runLedger.used.usd = this.state.costs.total.usd;
    this.loadMemory();
  }

  private loadMemory(): void {
    // Cross-task/cross-run memory only when the condition enables it (ADR-007, conflict C-13).
    if (this.config.features.crossTaskMemory) {
      let after = 0;
      for (;;) {
        const batch = this.store.tailGlobal(after, 2000);
        if (!batch.length) break;
        for (const { gseq, event } of batch) {
          after = gseq;
          if (event.type === 'MEMORY_WRITTEN') this.memory.add(event);
        }
      }
    } else {
      for (const e of this.store.events(this.runId, { types: ['MEMORY_WRITTEN'] })) this.memory.add(e as OrgEvent<'MEMORY_WRITTEN'>);
    }
  }

  get genome(): OrganizationGenome {
    if (!this.state.genome) throw new Error('organization not instantiated');
    return this.state.genome;
  }

  /** Single choke point for state change: append to store, then reduce locally. */
  emit(drafts: EventDraft[]): OrgEvent[] {
    const evs = this.store.appendMany(this.runId, drafts);
    for (const e of evs) {
      applyEvent(this.state, e);
      if (e.type === 'MEMORY_WRITTEN') this.memory.add(e);
    }
    return evs;
  }
  emit1<T extends EventDraft>(d: T): OrgEvent {
    return this.emit([d])[0]!;
  }

  /* ------------------------------------------------------------------ organization */

  /** Instantiates (or switches to) a genome, emitting agent lifecycle events for the difference. */
  adoptGenome(genome: OrganizationGenome, lead: EventDraft): OrgEvent[] {
    const before = this.state.genome;
    const drafts: EventDraft[] = [lead];
    const provider = this.config.model.provider;
    const created = (agentId: string) => {
      const a = genome.agents.find((x) => x.id === agentId)!;
      const role = genome.roles.find((r) => r.id === a.roleId)!;
      drafts.push({
        type: 'AGENT_CREATED',
        actorId: 'runtime',
        payload: { agentId: a.id, name: a.name, roleId: role.id, roleName: role.name, roleObjective: role.objective, capabilities: role.capabilities, modelProvider: provider, modelName: a.model ?? this.config.model.model, generation: genome.generation, ...(a.teamId ? { teamId: a.teamId } : {}) },
      });
    };
    if (!before) {
      for (const a of genome.agents) created(a.id);
    } else {
      const d = diffGenomes(before, genome);
      for (const id of d.agentsRemoved) drafts.push({ type: 'AGENT_REMOVED', actorId: 'runtime', payload: { agentId: id, reason: `not in genome ${genome.id}` } });
      for (const id of d.agentsAdded) created(id);
      for (const rc of d.roleChanges) {
        drafts.push({ type: 'ROLE_CHANGED', actorId: 'runtime', payload: { agentId: rc.agentId, fromRoleId: rc.from, toRoleId: rc.to } });
        created(rc.agentId);
      }
      this.pendingStructuralChanges += d.churn;
    }
    return this.emit(drafts);
  }

  instantiate(genome: OrganizationGenome, reason: string): void {
    this.adoptGenome(genome, { type: 'ORGANIZATION_INSTANTIATED', actorId: 'runtime', payload: { genome, reason } });
  }

  start(): void {
    if (this.state.status === 'created' || this.state.status === 'paused') this.emit1({ type: this.state.status === 'paused' ? 'RUN_RESUMED' : 'RUN_STARTED', actorId: 'runtime', payload: {} });
  }

  complete(summary: Record<string, unknown>): void {
    this.emit1({ type: 'RUN_COMPLETED', actorId: 'runtime', payload: { summary } });
  }

  fail(error: string, opts: { infrastructure?: boolean } = {}): void {
    this.emit1({ type: 'RUN_FAILED', actorId: 'runtime', payload: { error, ...(opts.infrastructure ? { infrastructure: true } : {}) } });
  }

  /** Cross-process control (CLI `orgworld pause|resume|stop`) checked between turns. */
  private async checkControl(): Promise<void> {
    const key = `control:${this.runId}`;
    let ctl = this.store.getKv<{ action: string }>(key);
    if (ctl?.action === 'stop') throw new RunStopped('stopped by user');
    if (ctl?.action === 'pause') {
      this.emit1({ type: 'RUN_PAUSED', actorId: 'user', payload: { reason: 'paused via control' } });
      while (ctl?.action === 'pause') {
        await new Promise((r) => setTimeout(r, 500));
        ctl = this.store.getKv<{ action: string }>(key);
      }
      if (ctl?.action === 'stop') throw new RunStopped('stopped by user');
      this.emit1({ type: 'RUN_RESUMED', actorId: 'user', payload: {} });
    }
  }

  /* ------------------------------------------------------------------ cognition */

  /** One model call with budget checks, events and retries. Internal; also used by organization.ts. */
  async think(agentId: string | null, taskId: string | null, ledger: BudgetLedger | null, purpose: string, system: string, prompt: string, schema: Record<string, unknown>, causedBy: string | null, category: CallCategory = this.category, opts: { maxOutputTokens?: number } = {}): Promise<{ result: CognitionResult; completedEventId: string } | { refused: string }> {
    for (const [scope, l] of [['task', ledger], ['run', this.runLedger]] as const) {
      if (!l) continue;
      const c = l.canStartCall();
      if (!c.ok) {
        this.emit1({ type: 'BUDGET_EXHAUSTED', actorId: 'runtime', payload: { scope, taskId, resource: c.resource, detail: c.detail } });
        return { refused: `${scope} budget exhausted (${c.detail})` };
      }
    }
    const model = (agentId && this.genome.agents.find((a) => a.id === agentId)?.model) || this.config.model.model;
    const max = this.retry.maxAttempts;
    for (let attempt = 1; attempt <= max; attempt++) {
      const callId = newId('call');
      this.emit1({ type: 'MODEL_CALL_STARTED', actorId: agentId ?? 'runtime', payload: { callId, agentId, taskId, category, purpose: truncate(purpose, 120), provider: this.provider.id, model }, causedBy });
      try {
        const result = await this.provider.complete({ system, prompt, jsonSchema: schema, model, maxOutputTokens: Math.min(opts.maxOutputTokens ?? Infinity, this.config.model.maxOutputTokensPerCall), ...(this.config.model.temperature !== undefined ? { temperature: this.config.model.temperature } : {}), purpose });
        ledger?.record(result.usage, result.costUsd);
        this.runLedger.record(result.usage, result.costUsd);
        const [done] = this.emit([
          { type: 'MODEL_CALL_COMPLETED', actorId: agentId ?? 'runtime', payload: { callId, agentId, taskId, category, provider: result.provider, model: result.model, usage: result.usage, costUsd: result.costUsd, latencyMs: result.latencyMs, samplingControlled: result.samplingControlled } },
          ...(ledger ? [budgetEvent('task', taskId, ledger)] : []),
          budgetEvent('run', null, this.runLedger),
        ]);
        return { result, completedEventId: done!.eventId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit1({ type: 'MODEL_CALL_FAILED', actorId: agentId ?? 'runtime', payload: { callId, agentId, taskId, error: truncate(`[attempt ${attempt}/${max}] ${msg}`, 500) } });
        const ce = err instanceof CognitionError ? err : null;
        if (ce?.fatal) throw new InfrastructureError(`model service refused the request (not retryable): ${msg}`, attempt);
        // Unknown errors (network resets, timeouts) are treated as transient.
        const retryable = ce ? ce.retryable : true;
        if (!retryable) throw err; // e.g. an unparseable model reply: agent-level failure, handled by the caller
        if (attempt === max) throw new InfrastructureError(`model call failed ${max} times: ${msg}`, attempt);
        const wait = backoffMs(this.retry, attempt, ce?.retryAfterMs);
        this.log(`model call failed (attempt ${attempt}/${max}); retrying in ${Math.round(wait / 1000)} s: ${truncate(msg, 160)}`);
        await this.sleep(wait);
      }
    }
    throw new Error('unreachable');
  }

  /** Organization-level reasoning (designer, LLM proposer). Counted as `controller` cost against the run budget. */
  async controllerCall(purpose: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<unknown | null> {
    const r = await this.think(null, null, null, purpose, system, prompt, schema, null, 'controller');
    return 'refused' in r ? null : r.result.json;
  }

  /* ------------------------------------------------------------------ tasks */

  async runTask(spec: TaskSpec): Promise<TaskOutcome> {
    const g = this.genome;
    const taskId = newId('task');
    const pt = this.config.budget.perTask;
    const ctx: TaskCtx = {
      taskId,
      spec,
      ledger: new BudgetLedger({ maxTokens: pt.maxTokens, maxCalls: pt.maxCalls, maxUsd: pt.maxUsd, reserveTokens: pt.reserveTokens }),
      queue: [g.entryAgentId],
      turns: 0,
      submitted: null,
      lastTurnSeq: {},
      reasoning: {},
      pendingFeedback: {},
      pendingMemories: {},
      structuralChangesBefore: this.pendingStructuralChanges,
      stalls: 0,
      learningIds: [],
      plan: null,
    };
    this.pendingStructuralChanges = 0;
    const bench = spec.kind === 'bench' ? spec.task : null;
    this.emit([
      {
        type: 'TASK_CREATED',
        actorId: 'runtime',
        payload: {
          taskId,
          parentId: null,
          title: bench ? bench.title : spec.kind === 'objective' ? spec.title : 'task',
          objective: bench ? bench.statement : spec.kind === 'objective' ? spec.objective : '',
          source: bench ? 'bench' : 'objective',
          ...(bench ? { category: bench.category, family: bench.family, publicCheckCount: publicView(bench).publicCheckCount } : {}),
          ...(spec.kind === 'bench' && spec.taskIndex !== undefined ? { taskIndex: spec.taskIndex } : {}),
          ...(spec.kind === 'bench' && spec.phaseId ? { phaseId: spec.phaseId } : {}),
          ...(spec.kind === 'bench' && spec.split ? { split: spec.split } : {}),
        },
      },
      { type: 'TASK_ASSIGNED', actorId: 'runtime', payload: { taskId, agentId: g.entryAgentId, byAgentId: null } },
      { type: 'TASK_STARTED', actorId: 'runtime', payload: { taskId } },
    ]);
    // Organizational memory retrieval at task start (only when cross-task memory is enabled).
    if (this.config.features.crossTaskMemory && this.memory.size > 0) this.recall(ctx, g.entryAgentId, taskBrief(spec).slice(0, 400), 'task-start');
    taskStartLearning(this, ctx); // lessons and playbook (C-21; no model call)
    await planPaths(this, ctx); // multi-path planning (C-21; one call when enabled)

    let stopReason: TaskOutcome['stopReason'] = 'max-turns';
    try {
      while (!ctx.submitted && ctx.turns < this.genome.policies.maxTurnsPerTask) {
        await this.checkControl();
        let agentId = ctx.queue.shift();
        let nudge: string | null = null;
        if (!agentId) {
          ctx.stalls++;
          if (ctx.stalls > 2) {
            stopReason = 'stalled';
            break;
          }
          agentId = this.genome.entryAgentId;
          nudge = 'No teammate has pending work for you and nobody is waiting on you. Decide the next step: continue, delegate, or submit the best deliverable available.';
        }
        if (this.state.agents[agentId]?.removed) continue;
        const r = await this.agentTurn(ctx, agentId, nudge);
        if (r === 'budget') {
          stopReason = 'budget';
          break;
        }
        if (r === 'entry-failed') {
          stopReason = 'entry-failed';
          break;
        }
      }
      if (ctx.submitted) stopReason = 'submitted';
    } catch (err) {
      if (err instanceof RunStopped) stopReason = 'stopped';
      else throw err;
    }
    return this.finishTask(ctx, stopReason);
  }

  private deliverInbox(ctx: TaskCtx, agentId: string): string[] {
    const pending = this.state.messageOrder.filter((id) => {
      const m = this.state.messages[id]!;
      return m.to.includes(agentId) && !m.receivedBy.includes(agentId) && (m.taskId === ctx.taskId || m.taskId === null);
    });
    if (pending.length) this.emit(pending.map((messageId) => ({ type: 'MESSAGE_RECEIVED' as const, actorId: agentId, payload: { messageId, agentId } })));
    return pending;
  }

  private enqueue(ctx: TaskCtx, agentId: string): void {
    if (!ctx.queue.includes(agentId)) ctx.queue.push(agentId);
  }

  private async agentTurn(ctx: TaskCtx, agentId: string, nudge: string | null): Promise<'ok' | 'budget' | 'entry-failed'> {
    const g = this.genome;
    ctx.turns++;
    const newMessageIds = this.deliverInbox(ctx, agentId);
    const actions = allowedActions(g, this.config, agentId, !!this.repo, ctx.spec.kind);
    const system = systemPrompt(this.state, this.config, agentId, actions);
    const prompt = turnPrompt({
      state: this.state,
      agentId,
      taskId: ctx.taskId,
      spec: ctx.spec,
      turn: ctx.turns,
      maxTurns: g.policies.maxTurnsPerTask,
      budget: ctx.ledger.remaining(),
      newMessageIds,
      feedback: ctx.pendingFeedback[agentId] ?? [],
      previousReasoning: (ctx.reasoning[agentId] ?? []).slice(-3),
      memories: ctx.pendingMemories[agentId] ?? [],
      nudge,
    });
    ctx.pendingFeedback[agentId] = [];
    ctx.pendingMemories[agentId] = [];
    this.emit1({ type: 'AGENT_STATUS_CHANGED', actorId: agentId, payload: { agentId, status: 'thinking', activity: `turn ${ctx.turns}: reading ${newMessageIds.length} new message(s)`, taskId: ctx.taskId } });
    let res: Awaited<ReturnType<OrgRunner['think']>>;
    try {
      res = await this.think(agentId, ctx.taskId, ctx.ledger, `${roleOf(g, agentId)?.name ?? agentId} turn ${ctx.turns}`, system, prompt, TURN_JSON_SCHEMA as unknown as Record<string, unknown>, null);
    } catch (err) {
      if (err instanceof InfrastructureError) throw err; // not the agent's failure: stop the run (C-19)
      const msg = err instanceof Error ? err.message : String(err);
      const isEntry = agentId === g.entryAgentId;
      this.emit1({ type: 'AGENT_FAILED', actorId: 'runtime', payload: { agentId, error: truncate(msg, 400), recovery: isEntry ? 'abort' : 'continue' } });
      return isEntry ? 'entry-failed' : 'ok';
    }
    if ('refused' in res) return 'budget';
    const { result, completedEventId } = res;
    const body = result.json as { reasoning?: unknown; actions?: unknown } | null;
    if (!body || !Array.isArray(body.actions)) {
      this.emit1({ type: 'ACTION_REJECTED', actorId: 'runtime', payload: { agentId, action: 'response', reason: 'response was not a JSON object with an actions array', taskId: ctx.taskId }, causedBy: completedEventId });
      (ctx.pendingFeedback[agentId] ??= []).push('Your last reply was not valid JSON {reasoning, actions}. Reply with valid JSON.');
      this.enqueue(ctx, agentId);
      return 'ok';
    }
    const reasoning = typeof body.reasoning === 'string' ? body.reasoning : '';
    (ctx.reasoning[agentId] ??= []).push(truncate(reasoning || '(no reasoning given)', 300));
    let continueSelf = false;
    let handedOff = false;
    const list = body.actions.slice(0, g.policies.maxActionsPerTurn);
    if (body.actions.length > list.length)
      this.emit1({ type: 'ACTION_REJECTED', actorId: 'runtime', payload: { agentId, action: 'actions', reason: `only ${g.policies.maxActionsPerTurn} actions per turn; ${body.actions.length - list.length} dropped`, taskId: ctx.taskId }, causedBy: completedEventId });
    for (const raw of list) {
      if (ctx.submitted) break;
      const parsed = parseAction(raw);
      if (!parsed.ok) {
        this.reject(ctx, agentId, parsed.type, parsed.reason, completedEventId);
        continue;
      }
      const a = parsed.action;
      if (!actions.includes(a.type)) {
        this.reject(ctx, agentId, a.type, `your role is not permitted to use ${a.type}`, completedEventId);
        continue;
      }
      const out = await this.execute(ctx, agentId, a, completedEventId);
      if (out === 'continue') continueSelf = true;
      if (out === 'handoff') handedOff = true;
    }
    if (!ctx.submitted) {
      if (continueSelf && !handedOff) this.enqueue(ctx, agentId);
      else if (!handedOff && !continueSelf) {
        // waited / only beliefs etc.: idle until messages arrive
        this.emit1({ type: 'AGENT_STATUS_CHANGED', actorId: agentId, payload: { agentId, status: 'waiting', activity: 'waiting for teammates', taskId: ctx.taskId } });
      }
    }
    return 'ok';
  }

  reject(ctx: TaskCtx, agentId: string, action: string, reason: string, causedBy: string | null): void {
    this.emit1({ type: 'ACTION_REJECTED', actorId: 'runtime', payload: { agentId, action, reason, taskId: ctx.taskId }, causedBy });
    (ctx.pendingFeedback[agentId] ??= []).push(`Your ${action} action was rejected: ${reason}`);
    this.enqueue(ctx, agentId);
  }

  knows(agentId: string, artifactId: string): boolean {
    return !!this.state.agents[agentId]?.knownArtifactIds.includes(artifactId);
  }

  private async execute(ctx: TaskCtx, agentId: string, a: Action, cause: string): Promise<'continue' | 'handoff' | 'none'> {
    const g = this.genome;
    const bench = ctx.spec.kind === 'bench' ? ctx.spec.task : null;
    switch (a.type) {
      case 'send_message': {
        const to = [...new Set(a.to)];
        const bad = to.filter((t) => !hasEdge(g, agentId, t));
        if (bad.length) return this.reject(ctx, agentId, a.type, `no communication edge to ${bad.join(', ')}; you can message: ${g.edges.filter((e) => e.from === agentId).map((e) => e.to).join(', ') || 'nobody'}`, cause), 'none';
        const attach = [...new Set(a.attach ?? [])];
        const unknown = attach.filter((id) => !this.knows(agentId, id));
        if (unknown.length) return this.reject(ctx, agentId, a.type, `you cannot attach artifacts you do not know: ${unknown.join(', ')}`, cause), 'none';
        const messageId = newId('msg');
        const drafts: EventDraft[] = [{ type: 'MESSAGE_SENT', actorId: agentId, payload: { messageId, from: agentId, to, kind: a.kind, content: a.content, taskId: ctx.taskId, artifactIds: attach, tokenCost: Math.ceil(a.content.length / 4) }, causedBy: cause }];
        if (a.kind === 'DELEGATION') for (const t of to) drafts.push({ type: 'TASK_ASSIGNED', actorId: agentId, payload: { taskId: ctx.taskId, agentId: t, byAgentId: agentId } });
        this.emit(drafts);
        for (const t of to) this.enqueue(ctx, t);
        return 'handoff';
      }
      case 'write_code':
      case 'write_tests': {
        if (bench && bench.deliverable === 'tests' && a.type === 'write_code' && !capabilitiesOf(g, agentId).includes('write_tests')) {
          // allowed: code artifacts are still useful as notes; nothing special
        }
        const parents = this.state.agents[agentId]!.knownArtifactIds.filter((id) => this.state.artifacts[id]?.taskId === ctx.taskId && ['code', 'tests', 'review', 'test_report'].includes(this.state.artifacts[id]!.kind)).slice(-3);
        const artifactId = newId('art');
        this.emit1({ type: 'ARTIFACT_CREATED', actorId: agentId, payload: { artifactId, kind: a.type === 'write_code' ? 'code' : 'tests', title: a.title, taskId: ctx.taskId, authorId: agentId, content: a.code, contentHash: hashString(a.code), parents, visibleTo: [agentId] }, causedBy: cause });
        (ctx.pendingFeedback[agentId] ??= []).push(`Created ${a.type === 'write_code' ? 'code' : 'tests'} artifact ${artifactId} "${a.title}".`);
        return 'continue';
      }
      case 'run_checks': {
        if (!bench) return this.reject(ctx, agentId, a.type, 'no checks exist for objectives', cause), 'none';
        if (!this.knows(agentId, a.artifactId)) return this.reject(ctx, agentId, a.type, `unknown artifact ${a.artifactId}`, cause), 'none';
        const art = this.state.artifacts[a.artifactId]!;
        const want = bench.deliverable === 'tests' ? 'tests' : 'code';
        if (art.kind !== want) return this.reject(ctx, agentId, a.type, `checks run on ${want} artifacts; ${a.artifactId} is ${art.kind}`, cause), 'none';
        const maxTools = this.config.budget.perRun.maxToolCalls;
        if (maxTools !== undefined && this.toolCalls >= maxTools) return this.reject(ctx, agentId, a.type, 'run tool-call budget exhausted', cause), 'none';
        this.toolCalls++;
        const experimentRunId = newId('chk');
        this.emit1({ type: 'EXPERIMENT_STARTED', actorId: agentId, payload: { experimentRunId, taskId: ctx.taskId, agentId, artifactId: a.artifactId, kind: 'public_checks' }, causedBy: cause });
        const r = await runPublicChecks(bench, art.content);
        const reportArtifactId = newId('art');
        const report = `${r.passed}/${r.total} public checks passed${r.timedOut ? ' (TIMED OUT)' : ''}${r.crashed ? ' (CRASHED)' : ''}\n${r.output}`;
        this.emit([
          { type: 'ARTIFACT_CREATED', actorId: agentId, payload: { artifactId: reportArtifactId, kind: 'test_report', title: `checks for ${a.artifactId}: ${r.passed}/${r.total}`, taskId: ctx.taskId, authorId: agentId, content: truncate(report, 8000), contentHash: hashString(report), parents: [a.artifactId], visibleTo: [agentId] } },
          { type: 'EXPERIMENT_COMPLETED', actorId: agentId, payload: { experimentRunId, taskId: ctx.taskId, agentId, passed: r.passed, failed: r.failed, total: r.total, durationMs: r.durationMs, timedOut: r.timedOut, output: truncate(r.output, 8000), reportArtifactId } },
        ]);
        (ctx.pendingFeedback[agentId] ??= []).push(`Public checks on ${a.artifactId}: ${r.passed}/${r.total} passed${r.crashed ? ' (crashed — see report)' : ''}. Report artifact ${reportArtifactId}:\n${truncate(r.output, 2500)}`);
        return 'continue';
      }
      case 'review': {
        if (!this.knows(agentId, a.artifactId)) return this.reject(ctx, agentId, a.type, `unknown artifact ${a.artifactId}`, cause), 'none';
        const target = this.state.artifacts[a.artifactId]!;
        const artifactId = newId('art');
        const content = `${a.verdict.toUpperCase()}: ${a.comments}`;
        const drafts: EventDraft[] = [{ type: 'ARTIFACT_CREATED', actorId: agentId, payload: { artifactId, kind: 'review', title: `${a.verdict} ${a.artifactId}`, taskId: ctx.taskId, authorId: agentId, content, contentHash: hashString(content), parents: [a.artifactId], visibleTo: [agentId] }, causedBy: cause }];
        let handoff = false;
        // Documented semantics: a review is addressed to the artifact's author when a communication edge exists.
        if (target.authorId !== agentId && hasEdge(g, agentId, target.authorId)) {
          drafts.push({ type: 'MESSAGE_SENT', actorId: agentId, payload: { messageId: newId('msg'), from: agentId, to: [target.authorId], kind: 'REVIEW_RESPONSE', content: truncate(content, 4000), taskId: ctx.taskId, artifactIds: [artifactId], tokenCost: Math.ceil(content.length / 4) }, causedBy: cause });
          handoff = true;
        }
        this.emit(drafts);
        if (handoff) this.enqueue(ctx, target.authorId);
        return handoff ? 'handoff' : 'continue';
      }
      case 'submit': {
        if (!canSubmit(g, agentId)) return this.reject(ctx, agentId, a.type, 'you are not permitted to submit', cause), 'none';
        if (!this.knows(agentId, a.artifactId)) return this.reject(ctx, agentId, a.type, `unknown artifact ${a.artifactId}`, cause), 'none';
        const art = this.state.artifacts[a.artifactId]!;
        if (art.taskId !== ctx.taskId) return this.reject(ctx, agentId, a.type, 'artifact belongs to a different task', cause), 'none';
        if (bench) {
          const want = bench.deliverable === 'tests' ? 'tests' : 'code';
          if (art.kind !== want) return this.reject(ctx, agentId, a.type, `the deliverable must be a ${want} artifact`, cause), 'none';
        }
        ctx.submitted = { artifactId: a.artifactId, by: agentId };
        this.emit1({ type: 'AGENT_STATUS_CHANGED', actorId: agentId, payload: { agentId, status: 'working', activity: `submitted ${a.artifactId}`, taskId: ctx.taskId } });
        return 'none';
      }
      case 'record_belief': {
        if (!this.config.features.beliefs) return this.reject(ctx, agentId, a.type, 'beliefs are disabled in this condition', cause), 'none';
        this.emit1({ type: 'BELIEF_UPDATED', actorId: agentId, payload: { agentId, beliefId: newId('bel'), claim: a.claim, confidence: a.confidence, evidence: this.state.agents[agentId]!.knownArtifactIds.slice(-2) }, causedBy: cause });
        return 'none';
      }
      case 'remember': {
        const agent = this.state.agents[agentId]!;
        if (a.scope === 'team' && !agent.teamId) return this.reject(ctx, agentId, a.type, 'you are not in a team', cause), 'none';
        this.emit1({
          type: 'MEMORY_WRITTEN',
          actorId: agentId,
          payload: {
            memoryId: newId('mem'),
            scope: a.scope,
            kind: a.kind,
            ...(a.scope === 'private' ? { ownerAgentId: agentId } : {}),
            ...(a.scope === 'team' && agent.teamId ? { teamId: agent.teamId } : {}),
            content: a.content,
            provenance: { runId: this.runId, taskId: ctx.taskId, genomeId: g.id, sourceEventIds: [cause], evidenceArtifactIds: agent.knownArtifactIds.filter((id) => this.state.artifacts[id]?.taskId === ctx.taskId).slice(-3) },
          },
          causedBy: cause,
        });
        return 'none';
      }
      case 'recall':
        this.recall(ctx, agentId, a.query, cause);
        return 'continue';
      case 'propose_decision':
        await this.runDecision(ctx, agentId, a, cause);
        return 'continue';
      case 'call_meeting':
        await this.runMeeting(ctx, agentId, a, cause);
        return 'continue';
      case 'read_file':
      case 'list_files': {
        if (!this.repo) return this.reject(ctx, agentId, a.type, 'repository access is not enabled for this run', cause), 'none';
        let text: string;
        let ok = true;
        try {
          text = a.type === 'read_file' ? this.repo.read(a.path) : this.repo.list(a.path);
        } catch (err) {
          ok = false;
          text = err instanceof Error ? err.message : String(err);
        }
        this.toolCalls++;
        this.emit1({ type: 'TOOL_INVOKED', actorId: agentId, payload: { tool: a.type, group: 'read', input: { path: a.path }, ok, ...(ok ? {} : { error: text }) }, causedBy: cause });
        if (ok) {
          const artifactId = newId('art');
          this.emit1({ type: 'ARTIFACT_CREATED', actorId: agentId, payload: { artifactId, kind: 'research_note', title: `${a.type} ${a.path}`, taskId: ctx.taskId, authorId: agentId, content: text, contentHash: hashString(text), parents: [], visibleTo: [agentId] }, causedBy: cause });
        }
        (ctx.pendingFeedback[agentId] ??= []).push(`${a.type} ${a.path}: ${ok ? '\n' + truncate(text, 4000) : 'ERROR ' + text}`);
        return 'continue';
      }
      case 'wait':
        return 'none';
    }
  }

  recall(ctx: TaskCtx, agentId: string, query: string, cause: string): void {
    const t0 = performance.now();
    const agent = this.state.agents[agentId]!;
    const { items, denied } = this.memory.retrieve(query, agentId, agent.teamId, this.genome.policies.memoryRead);
    this.emit1({ type: 'MEMORY_RETRIEVED', actorId: agentId, payload: { agentId, query: truncate(query, 300), itemIds: items.map((i) => i.memoryId), latencyMs: Math.round((performance.now() - t0) * 100) / 100, deniedItemIds: denied }, causedBy: cause === 'task-start' ? null : cause });
    ctx.pendingMemories[agentId] = [...(ctx.pendingMemories[agentId] ?? []), ...items];
  }

  contacts(agentId: string, requested: string[]): string[] {
    return [...new Set(requested)].filter((p) => p !== agentId && hasEdge(this.genome, agentId, p) && !this.state.agents[p]?.removed);
  }

  private async runDecision(ctx: TaskCtx, agentId: string, a: Extract<Action, { type: 'propose_decision' }>, cause: string): Promise<void> {
    if (usesDeliberation(this.config)) return deliberate(this, ctx, agentId, a, cause); // C-21 extensions
    const g = this.genome;
    const policy = g.policies.decision;
    if (!IMPLEMENTED_POLICIES.has(policy)) return this.reject(ctx, agentId, a.type, `decision policy ${policy} is not implemented in v0.1`, cause);
    if (!a.options.includes(a.recommendation)) return this.reject(ctx, agentId, a.type, 'recommendation must be one of the options', cause);
    const voters = this.contacts(agentId, g.edges.filter((e) => e.from === agentId).map((e) => e.to)).slice(0, 4);
    if (!voters.length) return this.reject(ctx, agentId, a.type, 'nobody you can reach to vote', cause);
    const decisionId = newId('dec');
    const evidence = this.state.agents[agentId]!.knownArtifactIds.filter((id) => this.state.artifacts[id]?.taskId === ctx.taskId).slice(-3);
    this.emit1({ type: 'DECISION_CREATED', actorId: agentId, payload: { decisionId, question: a.question, options: a.options, proposerId: agentId, recommendation: a.recommendation, evidence, policy, participants: [agentId, ...voters], taskId: ctx.taskId }, causedBy: cause });
    const ballots: Ballot[] = [{ agentId, option: a.recommendation, weight: 1 + (this.state.agents[agentId]?.stats.successfulSubmissions ?? 0), isEntry: agentId === g.entryAgentId, canReview: capabilitiesOf(g, agentId).includes('review') }];
    this.emit1({ type: 'VOTE_CAST', actorId: agentId, payload: { decisionId, agentId, option: a.recommendation, rationale: 'proposer recommendation', weight: ballots[0]!.weight } });
    const proposerReason = (ctx.reasoning[agentId] ?? []).slice(-1)[0] ?? '';
    for (const v of voters) {
      const sys = systemPrompt(this.state, this.config, v, ['wait']);
      const prompt = `${taskBrief(ctx.spec)}\n\nDECISION REQUESTED by ${agentId}: ${a.question}\nOptions: ${a.options.map((o) => JSON.stringify(o)).join(', ')}\nProposer recommends ${JSON.stringify(a.recommendation)} because: ${proposerReason}\n\nVote for exactly one option (copy it verbatim) with a one-sentence rationale. Reply JSON {"option": "...", "rationale": "..."}.`;
      let res: Awaited<ReturnType<OrgRunner['think']>>;
      try {
        res = await this.think(v, ctx.taskId, ctx.ledger, `vote on ${decisionId}`, sys, prompt, VOTE_JSON_SCHEMA as unknown as Record<string, unknown>, cause);
      } catch (err) {
        if (err instanceof InfrastructureError) throw err;
        this.emit1({ type: 'AGENT_FAILED', actorId: 'runtime', payload: { agentId: v, error: truncate(String(err), 300), recovery: 'continue' } });
        continue;
      }
      if ('refused' in res) break;
      const vote = res.result.json as { option?: string; rationale?: string } | null;
      if (!vote?.option || !a.options.includes(vote.option)) {
        this.emit1({ type: 'ACTION_REJECTED', actorId: 'runtime', payload: { agentId: v, action: 'vote', reason: `invalid option ${JSON.stringify(vote?.option)} — abstention recorded`, taskId: ctx.taskId } });
        continue;
      }
      const b: Ballot = { agentId: v, option: vote.option, weight: 1 + (this.state.agents[v]?.stats.successfulSubmissions ?? 0), isEntry: v === g.entryAgentId, canReview: capabilitiesOf(g, v).includes('review') };
      ballots.push(b);
      this.emit1({ type: 'VOTE_CAST', actorId: v, payload: { decisionId, agentId: v, option: b.option, rationale: truncate(vote.rationale ?? '', 1000), weight: b.weight }, causedBy: res.completedEventId });
    }
    const r = resolveDecision(policy, a.options, ballots, a.recommendation);
    this.emit1({ type: 'DECISION_COMPLETED', actorId: 'runtime', payload: { decisionId, chosen: r.chosen, confidence: Math.max(0, Math.min(1, r.confidence)), policy, tally: r.tally, rationale: r.rationale, opposition: r.opposition } });
    (ctx.pendingFeedback[agentId] ??= []).push(`Decision ${decisionId} resolved by ${policy}: ${r.chosen} (${r.rationale}).`);
  }

  private async runMeeting(ctx: TaskCtx, agentId: string, a: Extract<Action, { type: 'call_meeting' }>, cause: string): Promise<void> {
    const participants = this.contacts(agentId, a.participants);
    if (!participants.length) return this.reject(ctx, agentId, a.type, 'meeting participants must be agents you can message', cause);
    const meetingId = newId('mtg');
    const all = [agentId, ...participants];
    this.emit([
      { type: 'MEETING_CREATED', actorId: agentId, payload: { meetingId, convenerId: agentId, participants: all, reason: truncate(a.agenda, 200), agenda: a.agenda, taskId: ctx.taskId, inputArtifactIds: [] }, causedBy: cause },
      { type: 'MEETING_STARTED', actorId: agentId, payload: { meetingId } },
    ]);
    const transcript: string[] = [];
    let tokenCost = 0;
    for (const p of participants) {
      const sys = systemPrompt(this.state, this.config, p, ['wait']);
      const prompt = `${taskBrief(ctx.spec)}\n\nMEETING called by ${agentId}. Agenda: ${a.agenda}\nTranscript so far:\n${transcript.join('\n') || '(you speak first)'}\n\nContribute once, concisely. Reply JSON {"kind": "PROPOSAL|EVIDENCE|CHALLENGE|ANSWER|STATUS_UPDATE", "content": "..."}.`;
      let res: Awaited<ReturnType<OrgRunner['think']>>;
      try {
        res = await this.think(p, ctx.taskId, ctx.ledger, `meeting ${meetingId}`, sys, prompt, MEETING_JSON_SCHEMA as unknown as Record<string, unknown>, cause);
      } catch (err) {
        if (err instanceof InfrastructureError) throw err;
        this.emit1({ type: 'AGENT_FAILED', actorId: 'runtime', payload: { agentId: p, error: truncate(String(err), 300), recovery: 'continue' } });
        continue;
      }
      if ('refused' in res) break;
      const c = res.result.json as { kind?: string; content?: string } | null;
      const kind = (['PROPOSAL', 'EVIDENCE', 'CHALLENGE', 'ANSWER', 'STATUS_UPDATE'] as const).find((k) => k === c?.kind) ?? 'STATUS_UPDATE';
      const content = truncate(c?.content ?? '', 3000) || '(no contribution)';
      tokenCost += totalTokens(res.result.usage);
      transcript.push(`${p}: [${kind}] ${content}`);
      this.emit1({ type: 'MESSAGE_SENT', actorId: p, payload: { messageId: newId('msg'), from: p, to: all.filter((x) => x !== p), kind, content, taskId: ctx.taskId, artifactIds: [], meetingId, tokenCost: Math.ceil(content.length / 4) }, causedBy: res.completedEventId });
    }
    this.emit1({ type: 'MEETING_ENDED', actorId: agentId, payload: { meetingId, outcome: `${transcript.length} contribution(s)`, decisionIds: [], tokenCost } });
    // Meeting messages are known to all participants (reducer marks them); mark them received to avoid re-delivery.
    const ids = this.state.messageOrder.filter((id) => this.state.messages[id]!.meetingId === meetingId);
    const recv: EventDraft[] = [];
    for (const id of ids) for (const p of all) if (this.state.messages[id]!.to.includes(p) && !this.state.messages[id]!.receivedBy.includes(p)) recv.push({ type: 'MESSAGE_RECEIVED', actorId: p, payload: { messageId: id, agentId: p } });
    if (recv.length) this.emit(recv);
    (ctx.pendingFeedback[agentId] ??= []).push(`Meeting ${meetingId} transcript:\n${transcript.join('\n')}`);
  }

  private async finishTask(ctx: TaskCtx, stopReason: TaskOutcome['stopReason']): Promise<TaskOutcome> {
    const bench = ctx.spec.kind === 'bench' ? ctx.spec.task : null;
    let artifactId = ctx.submitted?.artifactId ?? null;
    let forced = false;
    if (!artifactId && stopReason !== 'stopped') {
      // Uniform rule for all conditions: if nothing was submitted, the newest deliverable-kind artifact is evaluated (flagged forced).
      const want = bench?.deliverable === 'tests' ? 'tests' : 'code';
      const latest = [...this.state.artifactOrder].reverse().map((id) => this.state.artifacts[id]!).find((a) => a.taskId === ctx.taskId && a.kind === want);
      if (latest) {
        artifactId = latest.artifactId;
        forced = true;
      }
    }
    const t = this.state.tasks[ctx.taskId]!;
    let score = 0;
    let evaluated = false;
    if (bench) {
      const content = artifactId ? this.state.artifacts[artifactId]!.content : null;
      const ev = await evaluateDeliverable(bench, content);
      evaluated = true;
      score = ev.score;
      this.emit1({ type: 'EVALUATION_COMPLETED', actorId: 'evaluator', payload: { taskId: ctx.taskId, evaluator: 'hidden-tests', score: ev.score, passed: ev.passed, total: ev.total, details: truncate(ev.details, 8000), artifactId } });
    } else {
      this.emit1({ type: 'EVALUATION_COMPLETED', actorId: 'evaluator', payload: { taskId: ctx.taskId, evaluator: 'none', score: 0, passed: 0, total: 0, details: 'objective mode: no hidden evaluator. Success below means only that a deliverable was produced, not that it is correct.', artifactId } });
    }
    const R = this.config.reward;
    const st = this.state.tasks[ctx.taskId]!;
    const terms: Record<string, number> = {
      quality: R.taskQuality * score,
      tokenCost: -R.lambdaCostPer1kTokens * (st.tokens / 1000),
      structural: -R.muStructural * ctx.structuralChangesBefore,
      coordination: -R.coordinationPer10Messages * (st.messages / 10),
      verification: R.verification * (Object.values(this.state.checkRuns).some((c) => c.taskId === ctx.taskId) ? 1 : 0),
    };
    const total = Object.values(terms).reduce((a, b) => a + b, 0);
    const success = bench ? score >= R.successThreshold : !!artifactId;
    const drafts: EventDraft[] = [];
    if (bench) drafts.push({ type: 'REWARD_RECORDED', actorId: 'evaluator', payload: { taskId: ctx.taskId, total, success, terms, rewardConfigHash: hashObject(R) } });
    if (stopReason === 'stopped' || stopReason === 'entry-failed' || (!artifactId && stopReason !== 'submitted'))
      drafts.push({ type: 'TASK_FAILED', actorId: 'runtime', payload: { taskId: ctx.taskId, reason: artifactId ? stopReason : `${stopReason}: no deliverable produced`, score } });
    else drafts.push({ type: 'TASK_COMPLETED', actorId: 'runtime', payload: { taskId: ctx.taskId, success, score, submittedArtifactId: artifactId, submittedBy: ctx.submitted?.by ?? null, forced } });
    const outcomeEvents = this.emit(drafts);
    await afterTaskLearning(this, ctx, { success, score, stopReason, outcomeEventId: outcomeEvents[outcomeEvents.length - 1]!.eventId, artifactId }); // C-21 (when enabled)
    this.log(`task ${bench?.id ?? t.title}: ${success ? 'SUCCESS' : 'FAIL'} score=${score.toFixed(2)} turns=${ctx.turns} stop=${stopReason}`);
    return {
      taskId: ctx.taskId,
      benchTaskId: bench?.id ?? null,
      category: bench?.category ?? null,
      success,
      score,
      reward: total,
      evaluated,
      forced,
      submittedBy: ctx.submitted?.by ?? null,
      turns: ctx.turns,
      tokens: st.tokens,
      calls: st.calls,
      usd: st.usd,
      messages: st.messages,
      genomeId: this.genome.id,
      stopReason,
    };
  }
}

function budgetEvent(scope: 'task' | 'run', taskId: string | null, l: BudgetLedger): EventDraft {
  return {
    type: 'BUDGET_UPDATED',
    actorId: 'runtime',
    payload: { scope, taskId, tokensUsed: l.used.tokens, tokensLimit: l.limits.maxTokens ?? null, callsUsed: l.used.calls, callsLimit: l.limits.maxCalls ?? null, usdUsed: l.used.usd, usdLimit: l.limits.maxUsd ?? null },
  };
}
