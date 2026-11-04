import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { EVENT_SCHEMA_VERSION, ORGWORLD_VERSION } from '@orgworld/protocol';
import { agentKnowledge, newId } from '@orgworld/core';
import type { EventStore } from '@orgworld/store';
import { runMetrics } from '@orgworld/metrics';

export interface ServerOptions {
  store: EventStore;
  /** Preferred port; on collision the next ports are tried, then an OS-assigned port (build §45). */
  port?: number;
  host?: string;
  /** Directory with the built web app (index.html). */
  webRoot?: string | null;
  pollMs?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100_000) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Local API (build §49): HTTP /api/v1 for queries/commands, WebSocket /api/v1/stream for live events.
 * Tails SQLite by global sequence, so runs executed by other processes (CLI, MCP) stream live.
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { store } = opts;
  const host = opts.host ?? '127.0.0.1';
  const webRoot = opts.webRoot && existsSync(join(opts.webRoot, 'index.html')) ? resolve(opts.webRoot) : null;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const p = url.pathname;
    try {
      if (p.startsWith('/api/v1/')) {
        const parts = p.slice('/api/v1/'.length).split('/').filter(Boolean).map(decodeURIComponent);
        const q = (k: string) => url.searchParams.get(k);
        const num = (k: string) => (q(k) !== null ? Number(q(k)) : undefined);
        if (parts[0] === 'health') return json(res, 200, { ok: true, version: ORGWORLD_VERSION, eventSchema: EVENT_SCHEMA_VERSION, dbSchema: store.schemaVersion(), events: store.countEvents() });
        if (parts[0] === 'runs' && parts.length === 1) return json(res, 200, store.listRuns({ ...(q('experimentId') ? { experimentId: q('experimentId')! } : {}) }));
        if (parts[0] === 'runs' && parts[1]) {
          const runId = parts[1];
          const run = store.getRun(runId);
          if (!run) return json(res, 404, { error: `unknown run ${runId}` });
          if (parts.length === 2) return json(res, 200, run);
          if (parts[2] === 'events') return json(res, 200, store.events(runId, { afterSequence: num('after') ?? 0, ...(num('upTo') !== undefined ? { upToSequence: num('upTo')! } : {}), limit: Math.min(num('limit') ?? 5000, 20000) }));
          if (parts[2] === 'state') return json(res, 200, store.runState(runId, num('seq')));
          if (parts[2] === 'knowledge' && parts[3]) {
            const k = agentKnowledge(store.runState(runId, num('seq')), parts[3]);
            return k ? json(res, 200, k) : json(res, 404, { error: 'unknown agent' });
          }
          if (parts[2] === 'metrics') return json(res, 200, runMetrics(store.events(runId)));
          if (parts[2] === 'control' && req.method === 'POST') {
            const body = (await readBody(req)) as { action?: string };
            if (!['pause', 'resume', 'stop'].includes(body.action ?? '')) return json(res, 400, { error: 'action must be pause|resume|stop' });
            const state = store.runState(runId);
            if (state.config?.mode === 'experiment' && body.action === 'stop')
              store.append(runId, { type: 'CONTAMINATION_RECORDED', actorId: 'user', payload: { source: 'http', action: 'stop', detail: 'run stopped by user during a locked experiment' } });
            store.setKv(`control:${runId}`, { action: body.action, at: new Date().toISOString(), id: newId('ctl') });
            return json(res, 200, { ok: true, action: body.action });
          }
        }
        if (parts[0] === 'organizations' && parts.length === 1) return json(res, 200, store.listGenomes());
        if (parts[0] === 'organizations' && parts[1]) {
          const g = store.getGenome(parts[1]);
          return g ? json(res, 200, g) : json(res, 404, { error: 'unknown genome' });
        }
        if (parts[0] === 'experiments' && parts.length === 1) return json(res, 200, store.listExperiments());
        if (parts[0] === 'experiments' && parts[1]) {
          const e = store.getExperiment(parts[1]);
          return e ? json(res, 200, { ...e, runs: store.listRuns({ experimentId: parts[1] }) }) : json(res, 404, { error: 'unknown experiment' });
        }
        return json(res, 404, { error: 'not found' });
      }
      // static web app
      if (!webRoot) return json(res, 404, { error: 'web app not built (run pnpm build)' });
      const rel = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
      let file = resolve(webRoot, '.' + sep + rel);
      if (!file.startsWith(webRoot)) return json(res, 403, { error: 'forbidden' });
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html');
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      res.end(readFileSync(file));
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const server: Server = createServer((req, res) => void handle(req, res));
  const wss = new WebSocketServer({ noServer: true });
  const subs = new Map<WebSocket, { runId: string | null; lastSeq: number; minGseq: number }>();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/v1/stream') return socket.destroy();
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const runId = url.searchParams.get('runId');
      const after = Number(url.searchParams.get('after') ?? 0);
      // Per-viewer cursor: backfill up to now, then only strictly newer events (no duplicates).
      const sub = { runId, lastSeq: after, minGseq: store.maxGseq() };
      subs.set(ws, sub);
      if (runId) {
        const backlog = store.events(runId, { afterSequence: after });
        if (backlog.length) sub.lastSeq = backlog[backlog.length - 1]!.sequence;
        ws.send(JSON.stringify({ type: 'backfill', runId, events: backlog }));
      }
      ws.send(JSON.stringify({ type: 'hello', gseq: lastGseq, version: ORGWORLD_VERSION }));
      ws.on('close', () => subs.delete(ws));
    });
  });

  let lastGseq = store.maxGseq();
  const timer = setInterval(() => {
    if (subs.size === 0) {
      lastGseq = store.maxGseq();
      return;
    }
    const batch = store.tailGlobal(lastGseq, 2000);
    if (!batch.length) return;
    lastGseq = batch[batch.length - 1]!.gseq;
    for (const [ws, sub] of subs) {
      const evs = batch
        .filter((b) => (sub.runId ? b.event.runId === sub.runId && b.event.sequence > sub.lastSeq : b.gseq > sub.minGseq))
        .map((b) => b.event);
      if (sub.runId && evs.length) sub.lastSeq = evs[evs.length - 1]!.sequence;
      if (evs.length && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'events', events: evs, gseq: lastGseq }));
      // Notify global listeners about new runs.
      if (!sub.runId) {
        const created = batch.filter((b) => b.event.type === 'RUN_CREATED').map((b) => b.event.runId);
        if (created.length && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'runs', created }));
      }
    }
  }, opts.pollMs ?? 200);

  const port = await listen(server, opts.port ?? 4317, host);
  return {
    port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        clearInterval(timer);
        for (const ws of subs.keys()) ws.terminate();
        wss.close();
        server.close(() => r());
      }),
  };
}

async function listen(server: Server, preferred: number, host: string): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolveP, reject) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.off('listening', onOk);
        reject(e);
      };
      const onOk = () => {
        server.off('error', onErr);
        resolveP((server.address() as AddressInfo).port);
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    });
  for (let p = preferred; p < preferred + 10 && preferred !== 0; p++) {
    try {
      return await tryPort(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  return tryPort(0);
}
