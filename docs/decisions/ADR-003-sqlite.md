# ADR-003: SQLite via built-in `node:sqlite`

## Context
Build §48: local-first, portable, migrations. The plugin must run on user machines without native compilation.

## Decision
Use Node's built-in `node:sqlite` (`DatabaseSync`) in WAL mode with `busy_timeout`. Schema migrations are numbered SQL files applied in a `schema_migrations` table. Tables: `events` (truth), `runs`, `organizations`, `model_calls`, `experiments`, `artifacts_index`, `metrics` (projections).

## Alternatives
- `better-sqlite3`: faster/mature but a native addon → breaks "install plugin and run" and pnpm 11 build-script approval.
- Postgres: violates local-first.

## Consequences
`node:sqlite` is experimental (stability 1.1) in Node 22 — pin `engines.node >= 22.13` and isolate all SQL behind `packages/store` so a swap is local. ExperimentalWarning is suppressed only for that specific warning.

## Evidence
Smoke test on Node v22.14.0 (2026-10-28): create/insert/select OK without flags.
