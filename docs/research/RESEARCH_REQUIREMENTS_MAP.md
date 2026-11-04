# Research Requirements → Measurable System Capabilities

**Source of truth:** `EVOORG_RESEARCH.md` (verbatim dossier). Section refs: `I-§n` = Part I section n, `II-§n` = Part II section n, `III-<heading>` = Part III.
**Purpose:** Phase 0 acceptance — "Research questions from `EVOORG_RESEARCH.md` can be mapped to actual measurable system variables."

Every row names (a) the scientific requirement, (b) the system capability that serves it, (c) the measurable variable(s), (d) where the data comes from (event types / tables), and (e) status. Status is only advanced with executable evidence; see `docs/verification/`.

Status legend: `PLANNED` · `IMPLEMENTED` (code exists + unit tests) · `VERIFIED` (exercised end-to-end with recorded evidence) · `BLOCKED` (cannot be done in this environment — see conflicts doc).

> Current statuses are tracked in `docs/verification/STATUS.md`, not here, so this map stays a stable specification.

---

## 1. Problem formulation (Part III is the current framing)

| ID | Requirement | Capability | Measurable variable(s) | Data source |
|---|---|---|---|---|
| F1 | Organization `O_t = (A_t, R_t, G_t)` for Paper #1 (II-§7) | `OrganizationGenome` (agents, roles, edges) — versioned, serializable | genome hash, `|A|`, roles, `|E|` | `organizations`, `ORGANIZATION_MUTATED` |
| F2 | Full organizational genome `O_t=(A,R,G,P,M,S,V)` (I-§9) as later-paper extension | Genome has optional `permissions`, `memoryPolicy`, `skills`, `verification` blocks; **excluded from Paper #1 mutation set by default** | presence/absence flags | genome JSON |
| F3 | History `H_t = {(x_i,O_i,y_i,r_i,c_i)}` (II-§7) | Experience buffer = projection over event store, keyed by task index | per-task tuple: task id, genome version, output artifact, reward, cost | `TASK_*`, `REWARD_RECORDED`, `BUDGET_UPDATED` |
| F4 | `O_{t+1} = π(O_t, H_t, x_{t+1})` (III-formalization) | `EvolutionController.step(org, history)` — the only component allowed to change the genome across tasks | controller decisions per trigger | `EVOLUTION_TRIGGERED`, `MUTATION_PROPOSED/VALIDATED/ACCEPTED/REJECTED` |
| F5 | Objective `Σ_t [R_t − λC_t − μ·s(O_t,O_{t+1})]` (II-§7, III) — formula partially lost in PDF; reconstructed from the prose "r_t task reward, c_t cost, s_t structural-change cost, λ,μ control efficiency/stability" | `RewardConfig` with `lambdaCost`, `muStructural`; persisted per run | per-task `R_t`, `C_t`, `s_t`; lifetime objective | `REWARD_RECORDED` payload carries all terms |
| F6 | Organizational forgetting `F_t = Perf_old(O_before) − Perf_old(O_after)` (III) | Probe evaluation of old task families with pre/post genomes (counterfactual re-execution) | `forgetting[family][shift]` | `PROBE_EVALUATED` events, metrics table |
| F7 | Non-stationary task distribution `D_t` (II-§17) | EvoOrgBench stream generator with explicit phase schedule and seed | phase id per task, category mix | stream manifest persisted in run config |

## 2. Research questions (Part II-§5)

| RQ | Question | Variables | Comparison |
|---|---|---|---|
| RQ1 | Persistent adaptation improves cumulative performance vs fixed orgs | `CR(T)`, per-phase `SR` | EvoOrg vs B1/B2 |
| RQ2 | Faster adaptation under distribution shift | `AHL` per shift, post-shift drop | EvoOrg vs B1/B2/B3 |
| RQ3 | Improvement not from more tokens/agents | lifetime tokens, calls, $; CPS; Pareto frontier; agent-count-matched runs | all conditions under matched budget |
| RQ4 | Stable role specialization emerges | `SI_i`, role-label vs behavior, interventional Δ_a | EvoOrg-from-generalists (Exp A) |
| RQ5 | Retained history beats per-task rebuild | `CR`, `AHL` | EvoOrg vs A1 (no persistence) and B3 (per-task adaptive) |

## 3. Hypotheses

Part II-§6 (H1–H5) and Part III (H1 primary + H2–H5 supporting) are both kept; Part III supersedes on wording.

| Hyp | Statement (abridged) | Test statistic | Falsified when (Part III §5) |
|---|---|---|---|
| III-H1 (primary) | Under non-stationary streams **and matched budgets**, persistent organizational learning yields higher lifetime CR than fixed AND per-task-adaptive orgs | paired bootstrap CI on `CR(EvoOrg) − CR(B)` over seeds × identical task sequences | FC1: `CR(EvoOrg) ≤ CR(PerTaskAdaptive)` on most streams; FC2: wins only with significantly more tokens/calls/$ |
| III-H2 | Faster recovery after shift | `AHL(EvoOrg) < AHL(Fixed)` (and `< AHL(PerTask)`) | FC4: `AHL(EvoOrg) > AHL(PerTask)` → organizational inertia |
| III-H3 | Intermediate plasticity is optimal | `CR` as function of plasticity (accepted mutations / task) swept via trigger period K and threshold δ | flat or monotone curve |
| III-H4 | Functional specialization | interventional `Δ_a = R(O) − R(O∖a)` per category; `SI_i` | FC7: removing "specialist" doesn't disproportionately hurt its category |
| III-H5 | Structure is transferable memory | `R(fresh agents + evolved genome) − R(fresh agents + random genome of equal size)` | FC8: no difference |
| II-H5 | Removing history hurts post-shift | `CR`/`AHL` of A5 (no history) vs EvoOrg | FC5: `Perf(EvoOrg) ≈ Perf(EvoOrg_NoHistory)` |
| — | Structure is learned, not stochastic exploration | EvoOrg vs B7 random persistent evolution (same mutation budget) | FC6: `EvoOrg ≈ RandomEvolution` |
| — | Generality across model families | repeat with ≥3 model families | FC3: wins on one family only → **BLOCKED** (only one provider family available; see conflicts C-08) |

## 4. Metrics (II-§25–§34, I-§33–§36, III)

All metrics are **pure functions of the event log** (`packages/metrics`) so they are recomputable from any exported run.

| Metric | Definition used in code | Notes |
|---|---|---|
| Cumulative reward `CR(T)` | `Σ_t r_t` over the stream | primary (II-§25) |
| Success rate `SR` | `#success / #tasks`, reported **per phase** (II-§26) | success := evaluator verdict `pass` |
| Cost per success `CPS` | `Σ cost / #success` (II-§27) | cost in tokens and USD reported separately |
| Lifetime cost | `Σ_t (task inference + controller + validation)` (III Control 4) | every model call carries `category ∈ {task, controller, validation, probe}` |
| Communication overhead | messages/task; inter-agent tokens/task; inter-agent share of tokens (II-§28) | from `MESSAGE_SENT` token cost and `MODEL_CALL_COMPLETED` |
| Adaptation Half-Life `AHL` | tasks after shift until rolling SR (window w) recovers ≥ `P_post + 0.5(P_pre − P_post)` (II-§29) | `P_pre` = rolling SR over last w tasks before shift; `P_post` = min rolling SR in first w tasks after; window w configurable (default 10); reports `censored` if never recovered |
| Structural churn `SC` | (agents added + removed + role changes + edge changes) per 100 tasks (I-§35, II-§30) | formula lost in PDF; reconstructed from I-§35 prose |
| Specialization Index `SI_i` | `1 − H_i / log K`, `H_i = −Σ_j p_ij log p_ij`, `p_ij` = share of agent i's work events on task family j (II-§31) | normalizer lost in PDF; `log K` is the standard max-entropy normalizer — flagged as reconstruction |
| Functional specialization | `Δ_a,c = R_c(O) − R_c(O∖a)` per category c (II-§39–40, III-H4) | requires counterfactual re-execution (probe calls, counted) |
| Topology | density, avg degree, Freeman degree centralization, mean shortest-path length, modularity (II-§32) | modularity: greedy on undirected projection |
| Organizational regret | `Σ_t [R(O*_t,x_t) − R(O_t,x_t)]` (I-§36, II-§33) | only where an oracle exists (synthetic oracle condition B6) |
| Forgetting `F` | see F6 | |
| Organizational recall time | tasks after a recurring phase returns until SR ≥ the SR achieved at end of the phase's first occurrence (III "Stream 4") | |
| Plasticity | accepted mutations per task (III-H3) | |
| Mutation stats | proposed/accepted/rejected/rolled back, generation (I-§33 evolution metrics) | |

## 5. Baselines (II-§23, III "Experimental baseline stack")

| ID | Condition | Implementation | Notes |
|---|---|---|---|
| B0 | Single strong agent | `single-agent` condition: genome with one agent, all capabilities, full budget | not handicapped (build §64) |
| B1 | Fixed generalist MAS | `fixed-generalist`: N generalists, static graph, controller disabled | |
| B2 | Fixed human-designed specialists | `fixed-specialist`: Planner/Implementer/Reviewer/Tester static | |
| B3 | Per-task LLM-generated org | `per-task-adaptive`: a designer call builds an org (from same role/mutation vocabulary) for each task from task features; discarded after task | designer calls counted as `controller` cost |
| B4 | AgentConductor-style | **PLANNED for Research v1** — re-implementation of the *principle* only (difficulty-conditioned density-aware DAG) | cannot claim to reproduce the paper |
| B5 | MetaGen-style role+topology inference-time adaptation | **PLANNED for Research v1** | ditto |
| B6 | TacoMAS-style test-time co-evolution / Oracle org (II-§23 B6) | Oracle for synthetic streams: per-family hand-specified org; TacoMAS-style **PLANNED** | numbering collision between Part II (B6=Oracle) and Part III (B6=TacoMAS) — both kept, IDs disambiguated in code as `oracle` and `tacomas-style` |
| B7 | Persistent random evolution | `random-evolution`: same trigger schedule & mutation count as EvoOrg, mutations sampled uniformly, no validation | |
| B8 | EvoOrg | `evoorg` | |

## 6. Ablations (II-§37–38, build §67)

`A1 no-persistence` (genome reset each task) · `A2 no-role-evolution` · `A3 no-membership-evolution` · `A4 no-topology-evolution` · `A5 no-history` (diagnosis window = 1 task) · `A6 no-validation` (accept all proposals) · `A7 no-rollback` · `frozen-after-phase-1`. Implemented as flags on the EvoOrg condition (`ablations: [...]`), persisted in run config.

## 7. Compute controls (II-§24, III §4)

| Control | Mechanism | Variable |
|---|---|---|
| C1 fixed token budget per task | `BudgetLedger` pre-call check: call refused if `remaining < minReserve`; post-call actual usage recorded | `tokens.task[t]` ≤ B (overrun bounded by one call; see conflicts C-11) |
| C2 fixed $ budget per task | same ledger, USD | `usd.task[t]` |
| C3 fixed model-call budget | ledger counts calls | `calls.task[t]` |
| C4 amortized org-learning cost | all controller/validation/probe calls are attributed and included in lifetime cost | `lifetimeCost` |
| Agent-count-matched condition | experiment config `matchAgentCount: N` restricts genome size | |
| Topology-only / role-only | ablation flags A2/A3 combined | |
| Low/Med/High budget sweep + Pareto plot | experiment config `budgets: [...]` | |

## 8. Benchmark (EvoOrgBench, II-§17–22, III "New headline experiment")

| Requirement | Capability |
|---|---|
| Auto-verifiable coding categories: implementation, debugging, testing, security, refactoring (II-§18–19) | `packages/bench` task families with deterministic hidden tests run in a permission-restricted Node child process |
| Categories require different behaviors (II-§19) | each category has a different deliverable & scorer (tests pass / mutants killed / vuln-specific exploit tests / behavior-preserving + structural check) |
| Stream types: stationary, abrupt, gradual, recurring (III) | stream generator `kind ∈ {stationary, abrupt, gradual, recurring}` with seed |
| Sizes S/M/L (II-§22) | `size` param: 100–200 / 300–600 / 1000+ |
| Reasoning stream (II-§20), tool-use stream (II-§21) | PLANNED |
| Train/validation/test + held-out families (build §65, I-§45) | stream generator partitions family pool by split; held-out families never appear in training streams |

## 9. Evolution mechanism (II-§9–14, I-§41–47)

| Requirement | Capability | Event |
|---|---|---|
| Mutations ADD_AGENT, REMOVE_AGENT, CHANGE_ROLE, ADD_EDGE, REMOVE_EDGE (II-§9) | `applyMutation(genome, m)` pure function with invariants | `ORGANIZATION_MUTATED` |
| Every mutation carries evidence + hypothesis + expected effect (II-§10) | `MutationProposal` schema requires `evidence`, `hypothesis`, `expectedCostDelta` | `MUTATION_PROPOSED` |
| Periodic trigger every K tasks (II-§14) | `trigger.kind = periodic`, `K` default 20; adaptive triggers PLANNED | `EVOLUTION_TRIGGERED` |
| Validation `F(O′,B) > F(O,B) + δ` on replay buffer (II-§11) | paired re-execution of candidate and incumbent on buffer B (recent + historical validation tasks, I-§45) | `MUTATION_VALIDATED` with both scores |
| Rollback (II-§12) | post-deployment monitor; on drop > threshold revert to parent (new generation, lineage kept) | `ORGANIZATION_ROLLED_BACK` |
| Role descriptors are structured & short (II-§16, "no 5,000-word prompts") | `RoleDescriptor {name, objective ≤ 240 chars, inputTypes, outputTypes}` validated | |
| Generalist start (Exp A) vs role pool (Exp B) (II-§15) | genome presets `generalists-4`, `specialist-pool` | |
| Genealogy / never delete (I-§48, build §93) | `organizations` table append-only, `parentId` | |

## 10. Safety (I-§61–62, II-§63)

| Requirement | Capability |
|---|---|
| Organizational specification gaming (removing verifiers to cut cost) | constitutional constraint set `Ω`: e.g. `verifierRequiredFor: [security]` — mutations violating Ω are rejected with `MUTATION_REJECTED{reason: "invalid: Ω: …"}`. Ω is off in every preset and switched on per experiment condition (`conditions[].constraints`) |
| II-§63 "study at least one simple constraint" | pre-registered safety pilot `experiments/safety/` (Ω off/on × cost pressure); measures: reviewer coverage per task/phase (`verificationCoverage`), security success (`successByCategory`), audit completeness (`mutationAudit`); not yet run |
| Reward-hacking signals (build §94) | detectors: early termination rate, avoided categories, comm collapse — emitted as `ANOMALY_DETECTED` |

## 11. Reproducibility & logging (II-§41–45, I-§77)

| Requirement | Capability |
|---|---|
| Per-task log schema (II-§44) | `TASK_COMPLETED` payload + `RUN_CREATED` config contain all listed fields |
| Mutation log (II-§45) | `MUTATION_*` events |
| Seeds: benchmark, task order, temperature, organization, mutation (II-§42) | `RunConfig.seeds` persisted; temperature recorded per provider (not controllable for the Claude CLI provider — conflicts C-07) |
| Mean, SD, 95% CI, paired bootstrap, effect size (II-§41) | `packages/metrics/stats.ts` |
| Every figure produced by code (II-§43) | `analysis/` scripts read exported CSV |
| Pre-registration (II-§67) | `experiments/<id>/EXPERIMENT_PROTOCOL.md` + config hash frozen when experiment locks |
| Negative results kept (II-§70) | runs/experiments never deleted; failed runs retained with status |

## 12. Research items explicitly out of scope for v0.1 (tracked, not dropped)

Constitution learning, skill evolution, causal institutional memory (Papers 2–4), heterogeneous model assignment (I-§67), human-agent orgs (I-§69), adversarial environments (I-§63), cost-shock & model-upgrade experiments (I-§65–66), organizational ecology (I-§50). These remain on the roadmap in `docs/architecture/BUILD_PLAN.md`.
