# ADR-001: pnpm TypeScript monorepo with consolidated packages

## Context
Build §47 recommends a monorepo with ~13 packages. The research core (EvoOrg) must stay independent of Claude-specific code (build §0.13) and the web view independent of cognition (§0.14). The repo must also be a Claude Code plugin root (§38) whose runtime works without `npm install` on the user's machine.

## Decision
- pnpm workspaces (pnpm 11, Node ≥ 22.13), ESM TypeScript everywhere. Packages export `src/index.ts` directly inside the workspace (no per-package build); vitest runs TS natively.
- Packages consolidated to 10 with one responsibility each: `protocol, core, store, cognition, bench, runtime, metrics, evoorg, experiment, server` + `cli`, `integrations/mcp`, `apps/web`. Mapping from build §47: `agent-runtime + organization-runtime + memory → runtime`; `event-store + replay → store + core reducer`; `evaluator → bench (sandbox) + metrics`; `experiment-runner → experiment`; `world-engine → core.deriveAgentActivity + apps/web`; `model-adapters → cognition`; `shared → protocol/core`.
- Shipping: `esbuild` bundles `cli` and `mcp` into `dist/orgworld.mjs` and `dist/orgworld-mcp.mjs` (all deps inlined; `node:sqlite` is built in → no native modules). The web app is pre-built to `dist/web/`. The plugin references only `dist/`.

## Alternatives
- 13 packages as listed: more boundaries than responsibilities at v0.1; rejected as premature complexity (§0.12).
- Turborepo/Nx: unnecessary orchestration for this size.
- Python for ML: not needed for v0.1 bandit/evolution (§47 allows isolating `ml/` later).

## Consequences
- Dependency direction is enforced by package.json `dependencies`; `evoorg` may import `cognition`'s *interface* only.
- Committed `dist/` is required for GitHub-installed plugins (no build step at install).

## Evidence
- `node:sqlite` works on the installed Node v22.14.0 without flags (tested 2026-10-28; emits ExperimentalWarning only).
- `pnpm -r test` / `pnpm typecheck` results recorded in `docs/verification/`.
