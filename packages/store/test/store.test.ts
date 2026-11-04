import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { reduceEvents, presetGenome } from '@orgworld/core';
import { EventStore, exportRun, readExport, scrubSecrets } from '../src/index.ts';
import { goldenDrafts, GOLDEN_RUN_ID } from '../../core/test/fixtures/golden-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const tmp = () => mkdtempSync(join(tmpdir(), 'owstore-'));
const opened: EventStore[] = [];
const open = (p = join(tmp(), 'orgworld.db')) => {
  const s = EventStore.open(p);
  opened.push(s);
  return s;
};
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

describe('EventStore', () => {
  it('appends with gap-free per-run sequences and reproduces reducer state', () => {
    const s = open();
    const stored = s.appendMany(GOLDEN_RUN_ID, goldenDrafts());
    expect(stored.map((e) => e.sequence)).toEqual(stored.map((_, i) => i + 1));
    const fromStore = s.runState(GOLDEN_RUN_ID);
    expect(JSON.parse(JSON.stringify(fromStore))).toEqual(JSON.parse(JSON.stringify(reduceEvents(s.events(GOLDEN_RUN_ID)))));
    expect(fromStore.tasks.t1!.status).toBe('COMPLETED');
    expect(s.getRun(GOLDEN_RUN_ID)).toMatchObject({ status: 'completed', condition: 'fixed-generalist', lastSequence: stored.length });
  });

  it('is append-only at the database level (UPDATE/DELETE abort)', () => {
    const s = open();
    s.appendMany(GOLDEN_RUN_ID, goldenDrafts().slice(0, 3));
    expect(() => s.db.exec(`UPDATE events SET type = 'RUN_FAILED'`)).toThrow(/append-only/);
    expect(() => s.db.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(() => s.db.exec('DELETE FROM organizations')).toThrow(/immutable/);
    expect(s.countEvents(GOLDEN_RUN_ID)).toBe(3);
  });

  it('rejects invalid events atomically (no partial batch)', () => {
    const s = open();
    const drafts = goldenDrafts().slice(0, 3);
    // @ts-expect-error deliberately invalid payload
    drafts.push({ type: 'TASK_CREATED', actorId: 'x', payload: { taskId: '' } });
    expect(() => s.appendMany('r1', drafts)).toThrow(/Invalid payload/);
    expect(s.countEvents('r1')).toBe(0);
  });

  it('snapshots are consistent with full replay', () => {
    const s = open();
    s.setSnapshotInterval(5);
    s.appendMany(GOLDEN_RUN_ID, goldenDrafts());
    const first = JSON.parse(JSON.stringify(s.runState(GOLDEN_RUN_ID))); // creates snapshots
    const n = (s.db.prepare('SELECT count(*) AS n FROM snapshots').get() as { n: number }).n;
    expect(n).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(s.runState(GOLDEN_RUN_ID)))).toEqual(first); // served from snapshot
    for (const k of [1, 7, 13, 20]) {
      expect(JSON.parse(JSON.stringify(s.runState(GOLDEN_RUN_ID, k)))).toEqual(JSON.parse(JSON.stringify(reduceEvents(s.events(GOLDEN_RUN_ID), k))));
    }
  });

  it('multiple OS processes appending concurrently produce ordered, unique, gap-free sequences', async () => {
    const dbPath = join(tmp(), 'orgworld.db');
    open(dbPath).close();
    opened.pop();
    const writers = ['w1', 'w2', 'w3', 'w4'];
    await Promise.all(
      writers.map((w) => run(process.execPath, ['--experimental-transform-types', '--no-warnings', join(here, 'concurrent-writer.ts'), dbPath, 'runC', w, '40'])),
    );
    const s = open(dbPath);
    const evs = s.events('runC');
    expect(evs).toHaveLength(160);
    expect(evs.map((e) => e.sequence)).toEqual(Array.from({ length: 160 }, (_, i) => i + 1));
    for (const w of writers) {
      const mine = evs.filter((e) => e.actorId === w).map((e) => (e.payload as { detail: string }).detail);
      expect(mine).toEqual(Array.from({ length: 40 }, (_, i) => `${w}-${i}`)); // per-writer order preserved
    }
  }, 60_000);

  it('global tail spans runs in insertion order', () => {
    const s = open();
    s.append('a', { type: 'ANOMALY_DETECTED', actorId: null, payload: { kind: 'k', detail: '1' } });
    s.append('b', { type: 'ANOMALY_DETECTED', actorId: null, payload: { kind: 'k', detail: '2' } });
    s.append('a', { type: 'ANOMALY_DETECTED', actorId: null, payload: { kind: 'k', detail: '3' } });
    const t = s.tailGlobal(0);
    expect(t.map((x) => `${x.event.runId}:${x.event.sequence}`)).toEqual(['a:1', 'b:1', 'a:2']);
    expect(s.tailGlobal(t[0]!.gseq).length).toBe(2);
  });

  it('organization archive keeps lineage and ignores duplicates', () => {
    const s = open();
    const g = presetGenome('generalists-4');
    s.archiveGenome(g);
    s.archiveGenome(g);
    expect(s.listGenomes()).toHaveLength(1);
    expect(s.getGenome(g.id)).toEqual(g);
  });

  it('locked experiment configuration cannot change', () => {
    const s = open();
    s.upsertExperiment({ experimentId: 'e1', name: 'x', config: { a: 1 }, configHash: 'h1', status: 'locked', lockedAt: new Date().toISOString() });
    expect(() => s.upsertExperiment({ experimentId: 'e1', name: 'x', config: { a: 2 }, configHash: 'h2', status: 'locked' })).toThrow(/locked/);
    s.upsertExperiment({ experimentId: 'e1', name: 'x', config: { a: 1 }, configHash: 'h1', status: 'completed', results: { ok: 1 } });
    expect(s.getExperiment('e1')).toMatchObject({ status: 'completed', results: { ok: 1 } });
  });
});

describe('export (build §61)', () => {
  it('exports a run zip and excludes secrets', () => {
    const s = open();
    const drafts = goldenDrafts();
    drafts.push({ type: 'MESSAGE_SENT', actorId: 'a1', payload: { messageId: 'mx', from: 'a1', to: ['a2'], kind: 'DIRECT_MESSAGE', content: 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', taskId: null, artifactIds: [], tokenCost: 1 } });
    s.appendMany(GOLDEN_RUN_ID, drafts);
    const out = join(tmp(), 'run.orgworld-run.zip');
    const res = exportRun(s, GOLDEN_RUN_ID, out, { 'metrics.json': { api_key: 'should-vanish', inputTokens: 5 } });
    const files = readExport(readFileSync(out));
    expect(Object.keys(files).sort()).toEqual(['config.json', 'events.jsonl', 'manifest.json', 'metrics.json', 'organizations.json', 'run.json', 'state.json']);
    const all = Object.values(files).join('\n');
    expect(all).not.toContain('sk-ant-api03');
    expect(all).not.toContain('should-vanish');
    expect(JSON.parse(files['metrics.json']!).inputTokens).toBe(5); // usage fields are not "secrets"
    expect(files['events.jsonl']!.trim().split('\n')).toHaveLength(res.eventCount);
    expect(JSON.parse(files['manifest.json']!)).toMatchObject({ runId: GOLDEN_RUN_ID, secretsScrubbed: true });
  });
  it('scrubSecrets keeps token-usage keys', () => {
    expect(scrubSecrets({ maxTokens: 10, tokenCost: 3, password: 'x', nested: { authorization: 'Bearer y' } })).toEqual({ maxTokens: 10, tokenCost: 3, password: '[REDACTED]', nested: { authorization: '[REDACTED]' } });
  });
});
