# Capability Status (2026-11-04)

`IMPLEMENTED` = code + passing automated tests. `VERIFIED` = exercised end-to-end with recorded evidence. `NOT DONE` = absent. Live = real model cognition; scripted = deterministic test provider (mechanics only, never a result).

Test suite: `pnpm typecheck` → 0 errors; `pnpm vitest run --project unit` → 13 files, 130 tests passing (2026-11-04).

| Phase | Capability | Status | Evidence |
|---|---|---|---|
| 0 | Research map, conflicts (C-00…C-17), architecture, ADR-001…007 | IMPLEMENTED | docs/ — researcher review of reconstructed formulas (C-16) and C-00 still open |
| 1 | Domain schemas (Zod), reducer, budget ledger, genome ops + Ω | VERIFIED | core tests incl. 1,000-sequence budget property test |
| 2 | Append-only event store, replay, snapshots, export | VERIFIED | golden replay test; DB triggers block UPDATE/DELETE; 4-process concurrent writers gap-free; secret-scrubbed export |
| 3 | Single-agent baseline on a real task | VERIFIED (live, 1 run) | evidence/phase3-single-agent.orgworld-run.zip — claude-cli/haiku, hidden tests 1.0, 3 calls, $0.003 |
| 4 | Fixed multi-agent org: delegation, messages, artifacts, decisions, meetings | VERIFIED (live, 1 run: 4-role specialist pool) | evidence/phase4-specialists.orgworld-run.zip — planner delegated, implementer coded + reported, score 1.0, $0.004. 12-role preset exists but has not run live. Decisions/meetings verified with scripted provider only |
| 5 | 3D web world (Three.js village), inspector, view-as-agent, event feed, live stream, replay scrubber | VERIFIED (browser) | Playwright/Chromium E2E: UI agent state == backend state on a real recorded run; click-to-inspect via 3D picking; view-as; scrub; live WebSocket events from another writer; screenshot evidence/web-world-3d.png |
| 6 | Claude Code plugin (manifest, marketplace, 5 skills, observer agent, MCP), CLI | VERIFIED | `claude plugin validate .` passes; installed from the repo marketplace into a fresh git repo (scope local): 5 skills + 1 agent + MCP listed, installed CLI initialised the repo, installed MCP served 9 tools; uninstalled cleanly. Install via `/plugin marketplace add roszhan2684/orgworld-public` (public GitHub repo, MIT) not yet exercised |
| 7 | Scoped memory with provenance, cross-run retrieval | VERIFIED (scripted) | runtime memory test: run A org memory retrieved in run B with provenance; private memory scoped to owner |
| 8 | Research views (network, evolution, metrics, replay) | PARTIAL | in web app; experiment comparison view NOT DONE |
| 9 | Stage-1 bandit / heuristic / random policies | IMPLEMENTED | policy eval: Thompson regret < 0.5× random over 10 seeds |
| 10 | Sequential (within-task) RL | NOT DONE | conflict C-12; no heuristic in-task policy yet |
| 11 | Structural evolution: genome, mutations, validation by paired shadow re-execution, rollback, lineage | VERIFIED (scripted) | experiment pipeline test: proposal with evidence → paired re-execution → accepted, gen 1, validation cost attributed |
| 12 | Evolution UI | PARTIAL | entry list in web app; lineage graph NOT DONE |
| 13 | Experiment runner: B0–B3, B7, B8, ablations, locking, CSV | VERIFIED (scripted) | identical streams across conditions; scripted results flagged "not research results". Pilot pre-registered (experiments/pilot/); Claude Haiku 5.5 replication and safety pilot pre-registered as drafts (experiments/pilot-claude/, experiments/safety/). Model-service failures are retried with backoff, never scored as tasks, excluded and re-attempted on resume; the $ ceiling survives a resume (C-19, scripted tests). **No real experiment run yet** |
| — | Safety (II-§63): Ω switchable per condition, reviewer coverage, security success, mutation audit | VERIFIED (scripted) | experiment test: without Ω the idle reviewer is pruned (coverage < 1 from task 5); with Ω the same proposals are rejected ("invalid: Ω: …") and coverage stays 1.0; every accepted change has evidence + validation. Real-model behaviour unknown until the safety pilot runs |
| 14 | Counterfactual replay, transfer, forgetting probes | NOT DONE | only validation re-execution exists |
| 15 | Hardening: CI, perf/scale benchmarks, a11y audit, release | PARTIAL | CI workflow written (not yet run on GitHub); scale benchmarks NOT DONE |
| — | Literature baselines (AgentConductor/MetaGen/TacoMAS-style) | NOT DONE | refused explicitly by the runner (C-05) |
| — | ≥3 model families | BLOCKED | C-08 |

**Cost so far:** two live runs, $0.0073 total (before the no-paid rule). Since then every run is free: paid providers are refused unless `--allow-paid` (re-checked 2026-11-04: both Claude configs exit with the refusal, nothing locked or spent).
**Claude API path:** priced per call from the model config (Claude Haiku 5.5 prices read 2026-11-04). Request shape verified only against a mocked API; the first real call is the smoke test, and a refused request stops the run without scoring (C-19). Sonnet 5.5 / Opus 5.5 need the structured-outputs change first (C-20, OPEN).
**Blocker for free real runs:** qwen2.5-coder:7b is downloaded, but the installed Ollama (`/usr/local/bin/ollama`, Intel Homebrew build) runs under Rosetta on CPU only: 2.3 tok/s generation, 3.1 tok/s prompt reading (measured 2026-10-29), ≈8 min per agent turn. A native Apple-silicon Ollama (Metal) is needed; downloading it was blocked by the session's permission policy, so the user must install it (e.g. the Ollama.app from ollama.com).
