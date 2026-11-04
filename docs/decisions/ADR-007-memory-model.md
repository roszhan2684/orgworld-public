# ADR-007: Scoped memory with provenance, ablatable for research

## Context
Build §15–16 require private/team/org/episodic/semantic/decision/failure memory with provenance and measurable retrieval. Conflict C-13: cross-task memory confounds the Paper #1 claim that *structure* is what persists.

## Decision
- `MemoryItem {id, scope: private|team|org, kind: episodic|semantic|decision|failure, ownerAgentId?, teamId?, content, provenance {runId, taskId, genomeId, sourceEventIds[], evidenceArtifactIds[], outcome?}, createdAt}` — writes without provenance are rejected.
- Access check in runtime: private → owner only; team → members; org → all agents whose genome policy grants `memory.read`. Unauthorized reads emit `ACTION_REJECTED` (tested).
- Retrieval: deterministic lexical scoring (BM25-lite) in v0.1; `MEMORY_RETRIEVED{query, itemIds, latencyMs, tokenCost}`; later `MEMORY_USED{itemId, affectedDecision, correct?}` closes the loop.
- `features.crossTaskMemory` defaults to **false** in research presets and **true** in the product preset.

## Alternatives
Vector DB embeddings (requires an embedding provider; deferred).

## Consequences
Phase-7 acceptance ("Run A influences Run B, provenance inspectable") is verified in product mode; research presets keep the genome as the sole persistent learned object unless a condition opts in.

## Evidence
`packages/runtime/test/memory.test.ts` (scope enforcement, provenance required, cross-run retrieval).
