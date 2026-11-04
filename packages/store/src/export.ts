import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { strToU8, unzipSync, strFromU8, zipSync } from 'fflate';
import { EXPORT_FORMAT_VERSION, ORGWORLD_VERSION } from '@orgworld/protocol';
import { hashString } from '@orgworld/core';
import type { EventStore } from './event-store.ts';

/** Keys whose values are secrets. Deliberately does NOT match usage fields such as `inputTokens`/`maxTokens`. */
const SECRET_KEY = /^(api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key|.*_secret|.*_api_key)$/i;
const SECRET_VALUE: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function scrubSecrets<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return SECRET_VALUE.reduce((s, re) => s.replace(re, '[REDACTED]'), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export interface ExportExtras {
  /** e.g. metrics computed by @orgworld/metrics; kept out of the store to respect package boundaries. */
  [file: string]: unknown;
}

/** Build §61: portable `.orgworld-run.zip` (config, events, state, organization lineage, extras). Secrets scrubbed. */
export function exportRun(store: EventStore, runId: string, outPath: string, extras: ExportExtras = {}): { path: string; files: string[]; eventCount: number; hash: string } {
  const run = store.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const events = store.events(runId);
  const state = store.runState(runId);
  const genomeIds = Object.keys(state.genomes);
  const genomes = genomeIds.map((id) => store.getGenome(id)).filter(Boolean);
  const eventsJsonl = events.map((e) => JSON.stringify(scrubSecrets(e))).join('\n') + '\n';
  const files: Record<string, unknown> = {
    'run.json': scrubSecrets(run),
    'config.json': scrubSecrets(state.config),
    'state.json': scrubSecrets(state),
    'organizations.json': scrubSecrets(genomes),
    ...Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, scrubSecrets(v)])),
  };
  const zipInput: Record<string, Uint8Array> = { 'events.jsonl': strToU8(eventsJsonl) };
  for (const [name, v] of Object.entries(files)) zipInput[name] = strToU8(JSON.stringify(v, null, 2));
  const hash = hashString(eventsJsonl);
  const manifest = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    orgworldVersion: ORGWORLD_VERSION,
    runId,
    eventCount: events.length,
    eventsHash: hash,
    files: Object.keys(zipInput).sort(),
    exportedAt: new Date().toISOString(),
    secretsScrubbed: true,
  };
  zipInput['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zipSync(zipInput, { level: 6 }));
  return { path: outPath, files: manifest.files.concat('manifest.json'), eventCount: events.length, hash };
}

export function readExport(buf: Uint8Array): Record<string, string> {
  const files = unzipSync(buf);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}
