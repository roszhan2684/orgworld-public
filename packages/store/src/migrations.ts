/** Numbered, forward-only migrations (build §48). Never edit an applied migration; add a new one. */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE events (
  gseq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT,
  payload TEXT NOT NULL,
  caused_by TEXT,
  correlation_id TEXT,
  schema_version INTEGER NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX events_run_type ON events(run_id, type);
-- Events are append-only (build §19): forbid UPDATE and DELETE at the database level.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  condition TEXT NOT NULL,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  objective TEXT,
  experiment_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);

-- Organization lineage archive: never delete (build §93).
CREATE TABLE organizations (
  genome_id TEXT PRIMARY KEY,
  parent_id TEXT,
  generation INTEGER NOT NULL,
  preset TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_run_id TEXT,
  genome TEXT NOT NULL
);
CREATE TRIGGER organizations_no_update BEFORE UPDATE ON organizations BEGIN SELECT RAISE(ABORT, 'organization archive is immutable'); END;
CREATE TRIGGER organizations_no_delete BEFORE DELETE ON organizations BEGIN SELECT RAISE(ABORT, 'organization archive is immutable'); END;

CREATE TABLE workspace_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE snapshots (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (run_id, sequence));

CREATE TABLE experiments (
  experiment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  locked_at TEXT,
  results TEXT
);

CREATE TABLE model_calls (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  category TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms REAL NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX model_calls_run ON model_calls(run_id);
`,
  },
];
