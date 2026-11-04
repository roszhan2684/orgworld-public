# OrgWorld Architecture

**Invariant (non-negotiable):**

```text
REAL AGENT ACTION → REAL STATE CHANGE → RECORDED EVENT → PERSISTED DATA → ORGWORLD VISUALIZATION
```

Concretely: the only way state changes is `runtime` emitting a validated event into the append-only `EventStore`. World state, metrics, the web world, CLI status and MCP queries are all **reductions over stored events**. Nothing downstream of the store may invent state.

## 1. Layering

```text
                 ┌──────────────────────────── cognition (providers) ───────────────────────────┐
                 │  claude-cli (real)   anthropic-api (real, needs key)   scripted (tests only) │
                 └───────────────────────────────▲───────────────────────────────────────────────┘
                                                 │ CognitionProvider interface (ADR-005)
┌─────────┐   ┌───────────┐   ┌────────────────┴───────┐   ┌───────────┐   ┌────────────┐
│  bench  │──▶│  runtime  │──▶│  core (reducer,budget, │◀──│  evoorg   │──▶│ experiment │
│ (tasks, │   │ (agents,  │   │  genome ops)            │   │ (policy + │   │  runner    │
│ sandbox │   │  actions, │   └────────────▲───────────┘   │ evolution)│   └─────┬──────┘
│ eval)   │   │  memory)  │                │               └─────▲─────┘         │
└─────────┘   └─────┬─────┘                │                     │               │
                    │ append(event)  ┌─────┴──────┐        metrics (pure fns     │
                    └───────────────▶│   store    │◀──────── over events) ◀──────┘
                                     │ SQLite WAL │
                                     └─────┬──────┘
                                           │ tail by sequence
                                     ┌─────▼──────┐   HTTP /api/v1  +  WS /api/v1/stream
                                     │   server   │──────────────────────────────▶ apps/web (React + Phaser)
                                     └─────▲──────┘
                       cli ────────────────┤  (orgworld init/run/status/watch/replay/export/why/doctor/experiment)
                       integrations/mcp ───┘  (stdio MCP server, Zod-validated tools)
                       .claude-plugin + skills/ + agents/ + hooks/ + .mcp.json  (thin packaging over cli + mcp)
```

Dependency rule (enforced by package.json deps): `protocol ← core ← store`, `protocol ← cognition`, `bench` depends only on `protocol`; `runtime` depends on `core, store, cognition, bench`; `evoorg` depends on `core, store, metrics, runtime` and the **cognition interface only** (never on `claude-cli`); `web` depends on `protocol, core` only (it re-uses the same reducer, so "UI world state matches backend world state" is testable by construction).

## 2. Packages

| Package | Responsibility |
|---|---|
| `packages/protocol` | Zod schemas + TS types: event envelope & all payloads, entities, `OrganizationGenome`, `RunConfig`, `ExperimentConfig`, `RewardConfig`, `BudgetConfig`. Version constants (`EVENT_SCHEMA_VERSION`, `GENOME_SCHEMA_VERSION`, `EXPORT_FORMAT_VERSION`, `RESEARCH_PROTOCOL_VERSION`). |
| `packages/core` | `reduce(state, event)` → `WorldState`; `BudgetLedger`; genome operations (`applyMutation`, `validateGenome`, constraint set Ω); `deriveAgentActivity` (activity→room mapping used by the web world); seeded RNG; id generation. Pure, no I/O. |
| `packages/store` | `EventStore` on `node:sqlite` (WAL): `append` (assigns per-run `sequence` in a transaction), `query`, `tail(afterSeq)`, snapshots, projections (`runs`, `organizations`, `model_calls`, `metrics`), migrations, run export (`.orgworld-run.zip`, secrets scrubbed). |
| `packages/cognition` | `CognitionProvider.complete(request) → {text, json?, usage, costUsd, model, provider, samplingControlled}`. Providers: `claude-cli` (headless `claude -p`, stripped context, `--json-schema`), `anthropic-api` (fetch, temperature/max_tokens honoured), `scripted` (deterministic, **test-only**, stamps `provider:"scripted"` on every call so it can never be mistaken for real cognition). |
| `packages/bench` | EvoOrgBench: task families (implementation/debugging/testing/security/refactoring), seeded parametric generation, stream generator (stationary/abrupt/gradual/recurring, splits), sandboxed evaluator (Node child process with `--permission`, timeout, temp dir). Public checks vs hidden tests (evaluator separation). |
| `packages/runtime` | Executes an organization on a task: agent turn scheduler, prompt construction from *only the information the agent is allowed to see*, action validation against genome edges/permissions, tool execution (`run_checks` in sandbox), messages, artifacts (with lineage), decisions & votes, meetings, memory (private/team/org with provenance), budget enforcement, failure handling (`AGENT_FAILED`). Emits events only. |
| `packages/metrics` | Pure functions over events: CR, SR/phase, CPS, lifetime cost, communication overhead, AHL, SC, SI, topology metrics, forgetting, recall time, plasticity; stats (mean/SD/CI, paired bootstrap, effect size). |
| `packages/evoorg` | Organizational learning, provider-agnostic: Stage-1 policies (`random`, `heuristic`, `thompson-bandit`), Stage-2 state/action framework (heuristic only), Stage-3 `EvolutionController` (trigger → diagnosis → proposal → validation on replay buffer → accept/reject → rollback monitor), constitutional constraints. |
| `packages/experiment` | Conditions (B0–B3, B7, B8, oracle; ablations), repetitions × seeds, identical task sequences across conditions, matched budgets, experiment lock + contamination log, aggregate export (CSV/JSON). |
| `packages/server` | Local HTTP + WebSocket (`/api/v1`). Port: configured → probe → fallback to OS-assigned; writes `.orgworld/runtime.json`. Tails SQLite by sequence so runs executed by other processes (CLI, MCP) stream live. Serves the built web bundle. |
| `cli` | `orgworld` binary (bundled to a single `dist/orgworld.mjs`, no native deps). |
| `integrations/mcp` | stdio MCP server; read tools / write tools / execution tools separated; every call validated with Zod and logged as `TOOL_INVOKED`. |
| `apps/web` | Vite + React + Phaser. Phaser owns the world canvas (pathfinding, sprites); React owns research panels. State = shared `core` reducer over events received from WS. |

## 3. Domain model (summary — full schemas in `packages/protocol`)

- **Workspace** = a repository with `.orgworld/` (config, `orgworld.db`, artifacts, exports). Organizational state persists here across runs.
- **Organization genome** (versioned, append-only lineage): `agents[] {id, name, roleId}`, `roles[] {id, name, objective, inputTypes, outputTypes, capabilities}`, `edges[] {from, to, kind}`, `entryAgentId`, `policies {submit, decision, memory, verification, budget}`, `constraints` (Ω), `generation`, `parentId`.
- **Run** = one execution session of an organization over one or more tasks (an objective in product mode, a task stream in research mode). `RunConfig` freezes provider/model, genome, reward config, budget, seeds, feature flags, ablations, versions.
- **Task** (hierarchical), **Message**, **Artifact** (with `parents[]` lineage), **Decision** (+ votes, policy, evidence, opposition), **Meeting**, **MemoryItem** (scope, provenance), **Belief** (private, evidence ids), **Relationship** (trust etc., each update has a cause event).

## 4. Execution protocol (one task)

1. `TASK_CREATED` → task given to `entryAgentId` (`TASK_ASSIGNED`).
2. Scheduler activates agents with non-empty inboxes in FIFO order (deterministic given event history). Concurrency 1 in v0.1 (ordering = reproducibility); `maxConcurrentAgents` reserved.
3. Agent turn: `AGENT_STATUS_CHANGED(thinking)` → `MODEL_CALL_STARTED` → provider call with a JSON schema → `MODEL_CALL_COMPLETED{usage,cost,category}` → `BUDGET_UPDATED` → validated actions, each producing its own events:
   - `send_message{to,kind,content,artifactIds}` (must follow a genome edge) → `MESSAGE_SENT` (+ `TASK_ASSIGNED` for `kind=delegate`)
   - `write_code` / `write_tests` / `write_note` → `ARTIFACT_CREATED` (lineage to inputs)
   - `run_checks{artifactId}` → `EXPERIMENT_STARTED/COMPLETED` with real sandbox output (public tests only) → `ARTIFACT_CREATED(test_report)`
   - `propose_decision` / `vote` → `DECISION_CREATED` / `VOTE_CAST` / `DECISION_COMPLETED` (policy-resolved)
   - `call_meeting` → `MEETING_STARTED` … participant turns … `MEETING_ENDED`
   - `remember` / `recall` → `MEMORY_WRITTEN` / `MEMORY_RETRIEVED` (scope-checked)
   - `record_belief` → `BELIEF_UPDATED` (private)
   - `submit{artifactId}` (agents permitted by `policies.submit`)
   Invalid actions are not silently dropped: `ACTION_REJECTED{reason}`.
4. Termination: `submit`, or budget/turn exhaustion (`BUDGET_EXHAUSTED` → forced submission of latest code artifact, flagged).
5. Evaluator (separate from producing agents): hidden tests in sandbox → `EVALUATION_COMPLETED{score, passed, details}` → `REWARD_RECORDED{terms, total, rewardConfigHash}` → `TASK_COMPLETED` / `TASK_FAILED`.

## 5. Organizational learning (EvoOrg) timescales

| Timescale | Component | Changes | Label |
|---|---|---|---|
| per call | runtime | nothing persistent | — |
| per task | Stage-1 policy (`thompson-bandit` over genome variants by task features) | which configuration is used for this task | `bandit policy` / `heuristic policy` / `random baseline` |
| every K tasks | `EvolutionController` | the persistent genome (Paper-#1 mutation set) | `evolution` |

Mutation lifecycle events: `EVOLUTION_TRIGGERED → DIAGNOSIS_RECORDED → MUTATION_PROPOSED → MUTATION_VALIDATED{incumbentScore, candidateScore, delta, bufferTaskIds} → ORGANIZATION_MUTATED | MUTATION_REJECTED → (ORGANIZATION_ROLLED_BACK)`. Validation re-executes buffer tasks (category `validation`, counted in lifetime cost).

## 6. Visualization contract

`core/deriveAgentActivity(state, agentId) → {activity, room, targetAgentId?, sourceEventSeq}`. The web world places/moves a character **only** when this derived value changes as a result of a new event; every on-screen action carries `sourceEventSeq`, inspectable by clicking. Speech bubbles render a truncated message `content` from a real `MESSAGE_SENT`. No timers create activity; idle characters stay idle.

## 7. Persistence layout

```text
.orgworld/
├── orgworld.db          SQLite (WAL): events (source of truth) + projections
├── config/orgworld.json  workspace config (no secrets; env vars only for keys)
├── organization/current.json  pointer to current genome id (mirror of db for humans)
├── runtime.json         running server {port, pid}
├── artifacts/<runId>/   large artifact bodies (content-addressed, referenced by events)
└── exports/             .orgworld-run.zip
```

Source-of-truth hierarchy: `events` table ▸ projections (rebuildable) ▸ JSON mirrors (human convenience, never read back as truth).

## 8. Security

- Model calls send only task/agent context assembled by the runtime; repository contents are never uploaded unless the objective-mode config explicitly grants `repoRead` paths.
- Agent code runs in a child Node process with `--permission` (fs-read limited to the sandbox dir, no child processes, no worker threads), CPU timeout, memory cap, clean env.
- Replay never executes stored commands; it only reduces events.
- The web UI renders agent text as text (React escaping); no `dangerouslySetInnerHTML`.
- Export scrubs env-like secrets (`/(api[_-]?key|token|secret|password)/i` keys and `sk-…` patterns).
- MCP tools are split into `read` / `write` / `exec` groups; write/exec refuse when the active run is a locked experiment.
