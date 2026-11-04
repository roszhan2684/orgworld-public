# ADR-002: Event sourcing as the single source of truth

## Context
Build §19–20 require append-only events, replay without LLM calls, and a UI that never invents state. The research doc (II-§44–45, §77) requires complete per-task and per-mutation logs and recomputable figures (II-§43).

## Decision
- Every state change is an event `{eventId, runId, sequence, timestamp, type, actorId, payload, causedBy, correlationId, schemaVersion}` validated by Zod at append time.
- `sequence` is assigned by the store inside a SQLite transaction (`max(sequence)+1` per run) → strictly ordered, gap-free per run. A global autoincrement `gseq` orders events across runs (for workspace-level reductions such as the persistent organization).
- `core.reduce` is a pure function; `WorldState = events.reduce(reduce, initial)`. Snapshots are an optimisation only and are verified against full replay in tests.
- Metrics are pure functions over events (`packages/metrics`) — exported runs reproduce every number.
- Event schema version bumps require a migration function `upcast(eventV_n) → eventV_{n+1}`; the golden replay test (`packages/core/test/golden.test.ts`) pins reducer output.

## Alternatives
- CRUD tables updated in place: loses history; makes replay/time-machine and provenance impossible.
- Event log in JSONL only: simple but no transactional sequencing across processes (CLI + MCP + server write concurrently).

## Consequences
- Projections can always be rebuilt; JSON mirrors in `.orgworld/` are convenience only.
- Large artifact bodies are stored content-addressed on disk and referenced by hash in events to keep the log small.

## Evidence
Golden replay test + property test "replay(prefix) is a prefix-consistent state" — see `docs/verification/PHASE-2.md`.
