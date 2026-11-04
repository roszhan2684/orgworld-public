import { createRequire } from 'node:module';

// node:sqlite is stability 1.1 in Node 22 (ADR-003). Suppress only its ExperimentalWarning.
const origEmit = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && msg.includes('SQLite is an experimental feature')) return;
  return (origEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;

type SqliteModule = typeof import('node:sqlite');
const sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = InstanceType<SqliteModule['DatabaseSync']>;
