# Dependency-Ordered Build Plan

Order follows the package dependency graph (ARCHITECTURE §1) and build §83 phases. A step starts only when its dependencies have **passing tests**. Parallelisable steps (marked ∥) are delegated to isolated subagents working in disjoint directories against a frozen interface.

| # | Step | Depends on | Build phase | Acceptance evidence |
|---|---|---|---|---|
| 0 | Research map, conflicts, architecture, ADRs, event protocol | — | P0 | docs reviewed; every research item mapped |
| 1 | Workspace scaffold (pnpm, tsconfig, vitest, eslint/prettier, CI) | 0 | P0 | `pnpm install && pnpm typecheck` |
| 2 | `protocol`: Zod schemas for events/entities/genome/configs | 1 | P0/P1 | schema unit tests |
| 3 | `core`: reducer, budget ledger, genome ops + Ω, activity derivation | 2 | P1 | unit + property tests; budget never negative |
| 4 | `store`: SQLite event store, sequencing, tail, snapshots, export | 2,3 | P2 | golden replay test; concurrent-writer ordering test |
| 5 | `cognition`: claude-cli, anthropic-api, scripted | 2 | P3 | contract tests (scripted); 1 live claude-cli call recorded |
| 6 ∥ | `bench`: EvoOrgBench families + sandbox evaluator + stream generator | 2 | P3/P13 | every family: reference solution passes hidden tests, starter fails them; sandbox denies fs-write/exec |
| 7 | `runtime`: single-agent execution of a bench task | 3,4,5,6 | P3 | **live** single-agent run persisted + exported |
| 8 | `runtime`: multi-agent (12-role preset + generalists), messages, delegation, artifacts, decisions, meetings | 7 | P4 | **live** collaborative run succeeds; events show real inter-agent messages |
| 9 | `metrics` | 4 | P8/P13 | unit tests on synthetic event logs with hand-computed answers |
| 10 | `server` (HTTP+WS, tailing) + `cli` (init/run/status/watch/replay/export/why/doctor) | 4,7,9 | P5/P6 | integration tests; CLI smoke against temp workspace |
| 11 ∥ | `apps/web`: world + inspector + event feed + replay | 3,10 | P5/P8 | Playwright: positions match `deriveAgentActivity`; scrub/replay |
| 12 | `integrations/mcp` + plugin packaging (.claude-plugin, skills, agents, hooks, .mcp.json, marketplace) | 10 | P6 | MCP contract tests; `claude plugin validate .` passes |
| 13 | Memory scopes, provenance, cross-run persistence | 8 | P7 | Run A memory retrieved in Run B with provenance |
| 14 | `evoorg` Stage 1 policies (random/heuristic/thompson) | 9 | P9 | policy eval suite |
| 15 | `evoorg` Stage 3 evolution controller + validation + rollback | 8,9,14 | P11 | controlled adaptation recorded live (≥1 accepted or rejected mutation with validation scores) |
| 16 | `experiment` runner: B0–B3, B7, B8, oracle, ablations, locking, export | 14,15 | P13 | pilot (II-§36) executes; CSV export |
| 17 | Evolution/experiment/metrics web views | 11,16 | P12/P8 | Playwright |
| 18 | Counterfactual re-execution, transfer, forgetting probes | 15,16 | P14 | probe events + metrics |
| 19 | Hardening: perf benchmarks (10–250 agents synthetic), a11y, docs, release | all | P15 | benchmark report |

Deferred to Research v1 (registered, not faked): AgentConductor/MetaGen/TacoMAS-style baselines (C-05), reasoning & tool-use streams, ≥3 model families (C-08), Stage-2 learned policy.
