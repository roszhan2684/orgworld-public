import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EventStore } from '@orgworld/store';
import { reduceEvents } from '@orgworld/core';
import { goldenDrafts, GOLDEN_RUN_ID } from '../../core/test/fixtures/golden-fixture.ts';
import { startServer, type RunningServer } from '../src/index.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function boot(port = 0) {
  const store = EventStore.open(join(mkdtempSync(join(tmpdir(), 'owsrv-')), 'orgworld.db'));
  const srv = await startServer({ store, port, pollMs: 50 });
  cleanup.push(() => store.close(), () => srv.close());
  return { store, srv };
}
const get = async (srv: RunningServer, p: string) => (await fetch(srv.url + p)).json() as Promise<any>;

describe('server /api/v1', () => {
  it('serves runs, events, state (== reducer), knowledge and metrics', async () => {
    const { store, srv } = await boot();
    store.appendMany(GOLDEN_RUN_ID, goldenDrafts());
    expect((await get(srv, '/api/v1/health')).ok).toBe(true);
    expect((await get(srv, '/api/v1/runs'))[0].runId).toBe(GOLDEN_RUN_ID);
    const events = await get(srv, `/api/v1/runs/${GOLDEN_RUN_ID}/events?after=5&limit=3`);
    expect(events.map((e: any) => e.sequence)).toEqual([6, 7, 8]);
    const state = await get(srv, `/api/v1/runs/${GOLDEN_RUN_ID}/state`);
    expect(state).toEqual(JSON.parse(JSON.stringify(reduceEvents(store.events(GOLDEN_RUN_ID)))));
    const k = await get(srv, `/api/v1/runs/${GOLDEN_RUN_ID}/knowledge/a2?seq=13`);
    expect(k.artifacts).toEqual([]);
    expect((await get(srv, `/api/v1/runs/${GOLDEN_RUN_ID}/metrics`)).successRate).toBe(1);
    expect((await fetch(srv.url + '/api/v1/runs/nope')).status).toBe(404);
  });

  it('streams live events appended by another writer over WebSocket (backfill + tail)', async () => {
    const { store, srv } = await boot();
    const drafts = goldenDrafts();
    store.appendMany(GOLDEN_RUN_ID, drafts.slice(0, 5));
    const ws = new WebSocket(srv.url.replace('http', 'ws') + `/api/v1/stream?runId=${GOLDEN_RUN_ID}&after=2`);
    const got: number[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'backfill' || m.type === 'events') for (const e of m.events) got.push(e.sequence);
        if (got.length === drafts.length - 2) resolve();
      });
    });
    await new Promise((r) => ws.once('open', r));
    store.appendMany(GOLDEN_RUN_ID, drafts.slice(5));
    await done;
    ws.close();
    expect(got).toEqual(Array.from({ length: drafts.length - 2 }, (_, i) => i + 3));
  });

  it('control endpoint writes run control and records contamination for experiment stops', async () => {
    const { store, srv } = await boot();
    store.appendMany(GOLDEN_RUN_ID, goldenDrafts().slice(0, 3)); // golden run is mode=experiment
    const r = await fetch(`${srv.url}/api/v1/runs/${GOLDEN_RUN_ID}/control`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
    expect(r.status).toBe(200);
    expect(store.getKv<{ action: string }>(`control:${GOLDEN_RUN_ID}`)!.action).toBe('stop');
    expect(store.runState(GOLDEN_RUN_ID).contaminated).toBe(true);
  });

  it('falls back to another port when the preferred one is taken', async () => {
    const blocker = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    const taken = (blocker.address() as { port: number }).port;
    cleanup.push(() => void blocker.close());
    const { srv } = await boot(taken);
    expect(srv.port).not.toBe(taken);
  });
});
