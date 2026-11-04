import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EVENT_SCHEMA_VERSION,
  OrganizationGenome,
  parseEvent,
  type EventDraft,
  type EventType,
  type OrgEvent,
} from '@orgworld/protocol';
import { applyEvent, initialWorldState, newId, type WorldState } from '@orgworld/core';
import { DatabaseSync } from './sqlite.ts';
import { MIGRATIONS } from './migrations.ts';

export interface RunRow {
  runId: string;
  createdAt: string;
  updatedAt: string;
  condition: string;
  mode: string;
  kind: string;
  label: string | null;
  objective: string | null;
  experimentId: string | null;
  provider: string;
  model: string;
  status: string;
  lastSequence: number;
  summary: Record<string, unknown> | null;
}

export interface GlobalEvent {
  gseq: number;
  event: OrgEvent;
}

interface EventRow {
  gseq: number;
  event_id: string;
  run_id: string;
  sequence: number;
  timestamp: string;
  type: string;
  actor_id: string | null;
  payload: string;
  caused_by: string | null;
  correlation_id: string | null;
  schema_version: number;
}

const RUN_STATUS: Partial<Record<EventType, string>> = {
  RUN_STARTED: 'running',
  RUN_RESUMED: 'running',
  RUN_PAUSED: 'paused',
  RUN_COMPLETED: 'completed',
  RUN_FAILED: 'failed',
};

/**
 * Append-only event store (ADR-002, ADR-003). Safe for multiple processes (CLI, MCP, server) via
 * SQLite WAL + BEGIN IMMEDIATE: per-run `sequence` is assigned inside the write transaction.
 */
export class EventStore {
  readonly db: DatabaseSync;
  private snapshotEvery = 500;
  private listeners = new Set<(e: OrgEvent) => void>();

  private constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  static open(path: string): EventStore {
    return new EventStore(path);
  }

  close(): void {
    this.db.close();
  }

  /** In-process subscription (same-process live updates). Cross-process consumers use `tailGlobal`. */
  subscribe(fn: (e: OrgEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      });
    }
  }

  schemaVersion(): number {
    const r = this.db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number | null };
    return r.v ?? 0;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Validates and appends events for a run atomically; returns the stored events. */
  appendMany(runId: string, drafts: EventDraft[]): OrgEvent[] {
    if (drafts.length === 0) return [];
    const stored = this.tx(() => {
      const row = this.db.prepare('SELECT max(sequence) AS s FROM events WHERE run_id = ?').get(runId) as { s: number | null };
      let seq = row.s ?? 0;
      const insert = this.db.prepare(
        'INSERT INTO events (event_id, run_id, sequence, timestamp, type, actor_id, payload, caused_by, correlation_id, schema_version) VALUES (?,?,?,?,?,?,?,?,?,?)',
      );
      const out: OrgEvent[] = [];
      for (const d of drafts) {
        seq += 1;
        const ev = parseEvent({
          eventId: newId('evt'),
          runId,
          sequence: seq,
          timestamp: new Date().toISOString(),
          type: d.type,
          actorId: d.actorId,
          payload: d.payload,
          causedBy: d.causedBy ?? null,
          correlationId: d.correlationId ?? null,
          schemaVersion: EVENT_SCHEMA_VERSION,
        });
        insert.run(ev.eventId, ev.runId, ev.sequence, ev.timestamp, ev.type, ev.actorId, JSON.stringify(ev.payload), ev.causedBy, ev.correlationId, ev.schemaVersion);
        this.project(ev);
        out.push(ev);
      }
      return out;
    });
    for (const e of stored) for (const fn of this.listeners) fn(e);
    return stored;
  }

  append<T extends EventType>(runId: string, draft: EventDraft<T>): OrgEvent<T> {
    return this.appendMany(runId, [draft as EventDraft])[0] as OrgEvent<T>;
  }

  /** Projections maintained inside the append transaction (rebuildable from events). */
  private project(e: OrgEvent): void {
    const now = e.timestamp;
    if (e.type === 'RUN_CREATED') {
      const c = e.payload.config;
      this.db
        .prepare('INSERT INTO runs (run_id, created_at, updated_at, condition, mode, kind, label, objective, experiment_id, provider, model, status, last_sequence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(e.runId, now, now, c.condition, c.mode, c.kind, c.label ?? null, c.objective ?? null, c.experimentId ?? null, c.model.provider, c.model.model, 'created', e.sequence);
    } else {
      const status = RUN_STATUS[e.type];
      if (status) this.db.prepare('UPDATE runs SET status = ?, updated_at = ?, last_sequence = ? WHERE run_id = ?').run(status, now, e.sequence, e.runId);
      else this.db.prepare('UPDATE runs SET updated_at = ?, last_sequence = ? WHERE run_id = ?').run(now, e.sequence, e.runId);
      if (e.type === 'RUN_COMPLETED') this.db.prepare('UPDATE runs SET summary = ? WHERE run_id = ?').run(JSON.stringify(e.payload.summary), e.runId);
    }
    if (e.type === 'ORGANIZATION_INSTANTIATED' || e.type === 'ORGANIZATION_MUTATED' || e.type === 'ORGANIZATION_ROLLED_BACK') {
      this.archiveGenome(e.payload.genome, e.runId);
    }
    if (e.type === 'MODEL_CALL_COMPLETED') {
      const p = e.payload;
      this.db
        .prepare('INSERT OR IGNORE INTO model_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(p.callId, e.runId, p.agentId, p.taskId, p.category, p.provider, p.model, p.usage.inputTokens, p.usage.outputTokens, p.usage.cacheReadTokens ?? 0, p.usage.cacheCreationTokens ?? 0, p.costUsd, p.latencyMs, e.timestamp);
    }
  }

  private toEvent(r: EventRow): OrgEvent {
    return parseEvent({
      eventId: r.event_id,
      runId: r.run_id,
      sequence: r.sequence,
      timestamp: r.timestamp,
      type: r.type,
      actorId: r.actor_id,
      payload: JSON.parse(r.payload),
      causedBy: r.caused_by,
      correlationId: r.correlation_id,
      schemaVersion: r.schema_version,
    });
  }

  events(runId: string, opts: { afterSequence?: number; upToSequence?: number; limit?: number; types?: EventType[] } = {}): OrgEvent[] {
    const where = ['run_id = ?', 'sequence > ?', 'sequence <= ?'];
    const args: (string | number)[] = [runId, opts.afterSequence ?? 0, opts.upToSequence ?? Number.MAX_SAFE_INTEGER];
    if (opts.types?.length) {
      where.push(`type IN (${opts.types.map(() => '?').join(',')})`);
      args.push(...opts.types);
    }
    const sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY sequence ASC${opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ''}`;
    return (this.db.prepare(sql).all(...args) as unknown as EventRow[]).map((r) => this.toEvent(r));
  }

  /** Cross-run, cross-process tail ordered by global insertion order. */
  tailGlobal(afterGseq: number, limit = 1000, runId?: string): GlobalEvent[] {
    const rows = (
      runId
        ? this.db.prepare('SELECT * FROM events WHERE gseq > ? AND run_id = ? ORDER BY gseq ASC LIMIT ?').all(afterGseq, runId, limit)
        : this.db.prepare('SELECT * FROM events WHERE gseq > ? ORDER BY gseq ASC LIMIT ?').all(afterGseq, limit)
    ) as unknown as EventRow[];
    return rows.map((r) => ({ gseq: r.gseq, event: this.toEvent(r) }));
  }

  maxGseq(): number {
    return ((this.db.prepare('SELECT max(gseq) AS g FROM events').get() as { g: number | null }).g ?? 0);
  }

  lastSequence(runId: string): number {
    return ((this.db.prepare('SELECT max(sequence) AS s FROM events WHERE run_id = ?').get(runId) as { s: number | null }).s ?? 0);
  }

  countEvents(runId?: string): number {
    const r = runId
      ? (this.db.prepare('SELECT count(*) AS n FROM events WHERE run_id = ?').get(runId) as { n: number })
      : (this.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number });
    return r.n;
  }

  /**
   * World state for a run at `upToSequence` (default: latest). Uses the nearest stored snapshot and
   * replays the remainder; snapshots are an optimisation and are verified against full replay in tests.
   */
  runState(runId: string, upToSequence?: number): WorldState {
    const limit = upToSequence ?? Number.MAX_SAFE_INTEGER;
    const snap = this.db
      .prepare('SELECT sequence, state FROM snapshots WHERE run_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1')
      .get(runId, limit) as { sequence: number; state: string } | undefined;
    const state: WorldState = snap ? (JSON.parse(snap.state) as WorldState) : initialWorldState();
    let lastSnap = snap?.sequence ?? 0;
    for (const e of this.events(runId, { afterSequence: snap?.sequence ?? 0, upToSequence: limit })) {
      applyEvent(state, e);
      if (upToSequence === undefined && e.sequence - lastSnap >= this.snapshotEvery) {
        this.db.prepare('INSERT OR IGNORE INTO snapshots (run_id, sequence, state) VALUES (?,?,?)').run(runId, e.sequence, JSON.stringify(state));
        lastSnap = e.sequence;
      }
    }
    return state;
  }

  setSnapshotInterval(n: number): void {
    this.snapshotEvery = n;
  }

  listRuns(filter: { experimentId?: string; condition?: string } = {}): RunRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.experimentId) (where.push('experiment_id = ?'), args.push(filter.experimentId));
    if (filter.condition) (where.push('condition = ?'), args.push(filter.condition));
    const rows = this.db.prepare(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`).all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: r.run_id as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      condition: r.condition as string,
      mode: r.mode as string,
      kind: r.kind as string,
      label: (r.label as string) ?? null,
      objective: (r.objective as string) ?? null,
      experimentId: (r.experiment_id as string) ?? null,
      provider: r.provider as string,
      model: r.model as string,
      status: r.status as string,
      lastSequence: r.last_sequence as number,
      summary: r.summary ? (JSON.parse(r.summary as string) as Record<string, unknown>) : null,
    }));
  }

  getRun(runId: string): RunRow | null {
    return this.listRuns().find((r) => r.runId === runId) ?? null;
  }

  /* ------------- organization archive ------------- */

  archiveGenome(genome: OrganizationGenome, sourceRunId: string | null = null): void {
    const g = OrganizationGenome.parse(genome);
    this.db
      .prepare('INSERT OR IGNORE INTO organizations (genome_id, parent_id, generation, preset, created_by, created_at, source_run_id, genome) VALUES (?,?,?,?,?,?,?,?)')
      .run(g.id, g.parentId, g.generation, g.preset, g.createdBy, new Date().toISOString(), sourceRunId, JSON.stringify(g));
  }

  getGenome(id: string): OrganizationGenome | null {
    const r = this.db.prepare('SELECT genome FROM organizations WHERE genome_id = ?').get(id) as { genome: string } | undefined;
    return r ? OrganizationGenome.parse(JSON.parse(r.genome)) : null;
  }

  listGenomes(): Array<{ genomeId: string; parentId: string | null; generation: number; preset: string; createdBy: string; createdAt: string; sourceRunId: string | null }> {
    return (this.db.prepare('SELECT genome_id, parent_id, generation, preset, created_by, created_at, source_run_id FROM organizations ORDER BY created_at ASC').all() as Array<Record<string, unknown>>).map((r) => ({
      genomeId: r.genome_id as string,
      parentId: (r.parent_id as string) ?? null,
      generation: r.generation as number,
      preset: r.preset as string,
      createdBy: r.created_by as string,
      createdAt: r.created_at as string,
      sourceRunId: (r.source_run_id as string) ?? null,
    }));
  }

  /* ------------- workspace key/value (pointers, not truth) ------------- */

  setKv(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO workspace_kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), new Date().toISOString());
  }

  getKv<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM workspace_kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }

  /* ------------- experiments ------------- */

  upsertExperiment(row: { experimentId: string; name: string; config: unknown; configHash: string; status: string; lockedAt?: string | null; results?: unknown }): void {
    const existing = this.getExperiment(row.experimentId);
    if (existing?.lockedAt && existing.configHash !== row.configHash) throw new Error(`experiment ${row.experimentId} is locked; configuration cannot change (build §37)`);
    this.db
      .prepare(
        `INSERT INTO experiments (experiment_id, name, config, config_hash, status, created_at, locked_at, results) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(experiment_id) DO UPDATE SET status = excluded.status, locked_at = COALESCE(experiments.locked_at, excluded.locked_at), results = excluded.results`,
      )
      .run(row.experimentId, row.name, JSON.stringify(row.config), row.configHash, row.status, new Date().toISOString(), row.lockedAt ?? null, row.results === undefined ? null : JSON.stringify(row.results));
  }

  getExperiment(id: string): { experimentId: string; name: string; config: unknown; configHash: string; status: string; lockedAt: string | null; results: unknown } | null {
    const r = this.db.prepare('SELECT * FROM experiments WHERE experiment_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      experimentId: r.experiment_id as string,
      name: r.name as string,
      config: JSON.parse(r.config as string),
      configHash: r.config_hash as string,
      status: r.status as string,
      lockedAt: (r.locked_at as string) ?? null,
      results: r.results ? JSON.parse(r.results as string) : null,
    };
  }

  listExperiments(): Array<{ experimentId: string; name: string; status: string; lockedAt: string | null }> {
    return (this.db.prepare('SELECT experiment_id, name, status, locked_at FROM experiments ORDER BY created_at DESC').all() as Array<Record<string, unknown>>).map((r) => ({
      experimentId: r.experiment_id as string,
      name: r.name as string,
      status: r.status as string,
      lockedAt: (r.locked_at as string) ?? null,
    }));
  }
}
