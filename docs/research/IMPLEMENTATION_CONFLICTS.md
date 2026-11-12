# Implementation Conflicts

Required by `ORGWORLD_BUILD.md` §0. Rule: where the research document and the build specification disagree on a **scientific** question, the research document wins. Nothing here silently changes the hypothesis; each item records the conflict, the constraint, the alternatives, the effect on validity, and the resolution adopted. Resolutions marked **OPEN** need a decision from the researcher.

---

### C-00 — Build specification was truncated
- **Conflict:** The pasted `ORGWORLD_BUILD.md` ends mid-§100 ("huge-scale RL traini"). Anything after that was never received.
- **Constraint:** Cannot implement unseen requirements.
- **Alternatives:** (a) guess the rest; (b) proceed with §0–§100 and flag.
- **Validity effect:** None on the research design (fully received as PDF).
- **Resolution:** (b). **OPEN:** researcher should paste the remainder if it contains requirements.

### C-01 — Default 12-role organization vs. Paper #1 experimental design
- **Conflict:** Build §7 mandates a 12-agent named-role default org. Research II-§15 says pre-assigning roles weakens the emergent-specialization claim; Experiment A must start from **generalists**, Experiment B from a human role pool. Research I-§75 / II-§36 scale is 3–8 agents.
- **Constraint:** Both are needed: 12 roles for the product/sandbox, generalists for science.
- **Alternatives:** (a) use 12 roles everywhere; (b) make the genome a parameter with presets.
- **Validity effect of (a):** confounds RQ4/H4 (specialization would be assigned, not emergent).
- **Resolution:** (b). Presets `software-org-12` (product default, sandbox), `generalists-4`, `specialist-pool` (research). Experiment configs must name their preset; the 12-role org is never the default for a research condition.

### C-02 — Mutation vocabulary breadth
- **Conflict:** Build §6 lists ~17 mutation operators (authority, veto, memory access, decision method …). Research II-§8–9 restricts Paper #1 to `ADD_AGENT, REMOVE_AGENT, CHANGE_ROLE, ADD_EDGE, REMOVE_EDGE` ("Do not add them initially").
- **Alternatives:** (a) all operators enabled; (b) all operators implemented, Paper #1 configs restricted.
- **Validity effect of (a):** larger action space, harder credit assignment, confounds comparison with prior work; prompt/policy changes could masquerade as structural learning.
- **Resolution:** (b). `mutationSet: "paper1"` is the default for research conditions; additional operators carry `exploratory: true` and are rejected by the validator unless the experiment opts in.

### C-03 — Reward function form
- **Conflict:** Build §36 proposes a weighted sum with transfer/memory-reuse/robustness terms. Research II-§7 / III objective is `R_t − λC_t − μ·s(O_t,O_{t+1})` with forgetting tracked separately.
- **Resolution:** Research objective is the **default** `RewardConfig` (`taskQuality: 1, lambdaCost, muStructural`). Build-style weights are supported but must be explicitly configured; the exact config is persisted with every run. Transfer is measured as a separate evaluation, not folded into training reward (folding it in would leak held-out information).

### C-04 — Definition of the per-task adaptive baseline
- **Conflict:** Build §3 Baseline C: "organization may adapt during a task, resets afterward." Research II-§23 B4 / III B3: "construct a fresh team/topology for every task" (and calls it the most important baseline).
- **Resolution:** Implement research B3 (`per-task-adaptive`): a designer step constructs an org per task from task features using the same role/edge vocabulary and the same budget; no cross-task state. Within-task re-design is a variant flag (`intraTaskRedesign: true`) so the build-doc reading is also available.

### C-05 — "Baselines from the literature" (AgentConductor/MetaGen/TacoMAS-style)
- **Conflict:** Research III requires TacoMAS/MetaGen/SERO/AgentConductor-style baselines. Build §64 lists only four. Official code for these systems is not available here.
- **Validity effect:** Without them, H1 can only be tested against B0–B3/B7 — Part III explicitly says that's insufficient for publication.
- **Resolution:** v0.1 implements B0, B1, B2, B3, B7, B8 (+ oracle). B4/B5/B6-style are registered condition IDs that throw `NotImplemented` and are listed as Research-v1 blockers in `STATUS.md`. No result may be described as "beating TacoMAS" until a faithful re-implementation exists.

### C-06 — Benchmark: product objectives vs. verifiable streams
- **Conflict:** Build §39/§68 centres on open-ended objectives ("Build authentication"). Research II-§18–19 requires hundreds of automatically verifiable tasks with deterministic scorers.
- **Resolution:** Two task sources. (1) **EvoOrgBench** (deterministic hidden tests) — the only source admissible for scientific claims. (2) **Objective mode** (`/orgworld <objective>`) — product mode; outcomes are recorded but flagged `evaluator: "none" | "agent-review"` and excluded from metrics aggregation by default (build §95 evaluator separation).

### C-07 — LLM sampling controls not exposed by the available provider
- **Conflict:** Research II-§42 requires fixing/logging temperature and seeds. The only cognition provider available in this environment is the Claude Code CLI (`claude -p`, subscription auth; no `ANTHROPIC_API_KEY`), which exposes neither temperature nor seed.
- **Alternatives:** (a) wait for API key; (b) use CLI and record `temperature: "provider-default (uncontrolled)"`; compensate with repetitions; (c) implement Anthropic API adapter (supports temperature) for when a key is present.
- **Resolution:** (b)+(c). Every model call records provider, model id, and `samplingControlled: false|true`. Repetition count must account for uncontrolled sampling.

### C-08 — Multiple model families (falsification condition 3)
- **Conflict:** Research II-§76 / FC3 require ≥3 model families incl. an open-weight one.
- **Constraint:** Only Claude models are reachable here.
- **Resolution:** Provider interface is model-agnostic (ADR-005). FC3 is **BLOCKED** until other providers are configured; any claim of generality is prohibited until then. A Claude-family-only result must be labelled "single model family".

### C-09 — Compute scale
- **Conflict:** Research II-§35/§71 main matrix ≈ 67,500 method-task executions × several calls each.
- **Constraint:** Subscription-backed CLI; minimal-context calls cost ≈ $0.0003 + output on Haiku (measured 2026-10-28: 913 input tokens, $0.000315 for a trivial reply), but multi-agent tasks need several calls.
- **Resolution:** Follow research II-§36 pilot protocol first (1 model, 3 methods, 100 tasks, 3 seeds) with cheap models; main matrix only after pilot. Budgets are enforced by the ledger and an experiment-level `$` cap.

### C-10 — "Replay never uses live LLM calls" vs. counterfactual validation
- **Conflict (terminology):** Build §20 forbids LLM calls in replay. Research II-§11/§39 mutation validation and III-H5 transfer require **re-executing** tasks with other organizations (live calls).
- **Resolution:** Two distinct operations. *Event replay* (`packages/core` reducer over stored events) — never calls models. *Counterfactual re-execution* (validation, probes, transfer) — a new execution, recorded as its own events with `category: validation|probe`, counted in lifetime cost (III Control 4).

### C-11 — Hard per-task token cap granularity
- **Conflict:** Research III Control 1 states `Tokens(M,t) ≤ B`. The CLI provider cannot cap output tokens per call.
- **Resolution:** Ledger refuses any call when `remaining < reserve` (reserve = configured max expected call size). Actual usage is recorded post-hoc, so a task can exceed B by at most one call's overrun; every overrun is recorded (`BUDGET_EXCEEDED`) and reported. With the Anthropic API adapter, `max_tokens` is set to `min(callCap, remaining)` making the cap exact.

### C-12 — Sequential RL (build Stage 2) vs. research scope
- **Conflict:** Build §5 Stage 2 lists ~16 within-task actions (meetings, teams, budget reallocation). Research Paper #1 does not require within-task RL; the learning target is cross-task structure.
- **Resolution:** Stage 0 (observation) and Stage 1 (contextual bandit over org configurations) are implemented as first-class; Stage 2 provides the state/action framework with a transparent heuristic policy only. Per build §82 it is labelled `heuristic policy`, never "RL".

### C-13 — Meetings, beliefs, relationships, trust in research conditions
- **Conflict:** Build §9–§13 add beliefs, trust, meetings. Research Paper #1 evolves membership/roles/edges only. Extra mechanisms that change behavior across tasks would be additional persistent state, confounding "organizational structure" with "agent memory".
- **Resolution:** These features exist and emit events, but trust/relationship state and cross-task memory are **ablatable and OFF by default in Paper #1 research presets** (`features.relationships=false`, `features.crossTaskMemory=false`), so that the persistent object being tested is the organization genome. Turning them on is a separate, labelled condition.

### C-14 — Next.js / React / Phaser recommendation vs. local-first serving
- **Not scientific.** Build §21/§50 recommend Next.js. The UI is a client-only app served by the local runtime (no SSR need). Resolution: vanilla TypeScript + Canvas 2D bundled with esbuild, served by the local runtime (ADR-004 amendment). Recorded here for transparency only.

### C-15 — Experiment mode lock vs. sandbox commands
- **Consistent**, recorded for clarity: locked experiments reject `tell/ask/create-agent/meeting` and genome edits; any override is written as `CONTAMINATION_RECORDED` and marks the run `contaminated: true` (excluded from aggregates).

### C-16 — Formulas lost in the PDF
- `[ _ E]`, `[ OE = {Quality Reliability} {Cost Coordination} ]`, `[ SI_i = 1- ]`, `[ SC = ]`, `[ SR = {} ]`, `[ CPS = {} ]`, `[ Plasticity = ]`.
- **Resolution:** Reconstructions used in code are listed in `RESEARCH_REQUIREMENTS_MAP.md §4` and labelled "reconstruction". Organizational Efficiency `OE = (Quality·Reliability)/(Cost·Coordination)` is the most plausible reading of I-§11 and is reported as a diagnostic only. **OPEN:** researcher to confirm reconstructions.

### C-17 — Bare `/orgworld` command vs. plugin namespacing (verified 2026-10-28, Claude Code 2.1.312)
- **Conflict:** Build §39/§40/§88 target a bare `/orgworld <objective>` and `/orgworld status`. Current plugin docs (code.claude.com/docs/en/plugins/components.md, skills.md) namespace every plugin skill/command as `/<plugin>:<name>`; a bare plugin-level command is not documented.
- **Alternatives:** (a) skills `orgworld:run`, `orgworld:status`, `orgworld:watch`, `orgworld:why` …; (b) one dispatcher skill `/orgworld:orgworld <subcommand|objective>`; (c) additionally ship an opt-in project skill (`.claude/skills/orgworld/SKILL.md`) installed by `orgworld init --claude-skill` which gives a bare `/orgworld` in that repo.
- **Validity effect:** none (UX only).
- **Resolution:** (a)+(b) in the plugin, plus (c) as an opt-in. Marketplace is named `orgworld` so the install line matches build §88: `/plugin install orgworld@orgworld`. Validated with `claude plugin validate .` (see `docs/verification/PHASE-6.md`).

### C-18 — 3D world vs. build §21/§74 ("do not begin with full 3D", "avoid meaningless animated particles")
- **Conflict:** the researcher explicitly requested a 3D fantasy village with butterflies and morning lighting (2026-10-29).
- **Validity effect:** none, provided decoration never encodes or implies agent activity.
- **Resolution:** implemented (ADR-004 amendment 2). Ambient elements are strictly scenery; agent motion remains event-driven and is tested for equality with backend state.

### C-19 — Model-service failures vs. "failed runs are kept" (2026-11-04)
- **Conflict:** build §59/§96 keep failed runs and count a failed agent turn as part of the task. Before this change a transient provider error (rate limit, overload, network) retried once without waiting and then counted as the agent's failure (`entry-failed` → failed task). Under a low-priority API tier that would score outages as organizational performance and bias conditions differently.
- **Resolution:** (1) The runner retries transient errors (408/409/429/5xx/529, network resets) with exponential backoff, 10 attempts ≈ 5 minutes, honouring `retry-after`. (2) Exhausted retries and fatal configuration errors (400/401/402/403/404/413, missing price) raise `InfrastructureError`, which is never scored as a task. The run stops with `RUN_FAILED{infrastructure: true}` and the experiment stops with status `infra-stopped`. (3) On resume, infrastructure-failed and interrupted runs are **kept** in the append-only store, **excluded** from aggregates with a note, and the slot is **re-attempted** as `<run>-a2`, `-a3`, …. (4) Money spent before a resume counts toward the experiment's $ ceiling (it used to restart at 0). Agent-level errors (e.g. an unparseable reply) still count as the agent's failure, as before. An Ollama request timeout (as opposed to a connection refusal) is raised as a fatal `CognitionError`, so a slow machine stops the run as infrastructure instead of scoring the turn.
- **Validity effect:** removes a provider-availability confound; exclusions are listed in every result.

### C-20 — Claude API request shape on current models; reserved LLM proposer (2026-11-04)
- **Conflict 1:** current Claude models reject non-default `temperature` (Haiku 5.5, Sonnet 5.5, Opus 5.5), and Sonnet 5.5 / Opus 5.5 also reject a forced `tool_choice`, which the `anthropic-api` provider uses to get JSON back.
- **Resolution 1:** temperature is sent only when configured, and results are labelled `samplingControlled` only then. Claude runs are therefore not sampling-controlled (cf. C-07). Pre-registered Claude experiments use Claude Haiku 5.5, which still accepts the forced tool call. **OPEN:** moving the provider to structured outputs (`output_config.format`) is required before Sonnet 5.5 / Opus 5.5 runs. That change needs one paid smoke test, so it waits for the researcher's approval.
- **Conflict 2:** `evolution.proposer` accepted `llm` and `both`, but no LLM proposer exists; the controller silently ran the heuristic.
- **Resolution 2:** `llm`/`both` are refused with an explicit error. No existing config used them.
- **Update (2026-11-06, see C-21):** an LLM proposer now exists (`proposer: llm | both`). It makes one controller call per trigger, its proposals are labelled `llm`, and each one goes through the same validity checks and paired re-execution as the heuristic's. Unusable replies are recorded as anomalies and nothing is applied. The pre-registered pilot and safety configs still use `heuristic`.

### C-21 — Organization-behaviour extensions beyond the research design (2026-11-06)
- **Conflict:** the researcher asked for a fuller organization. Its members should learn from mistakes and successes, argue for decisions and change each other's minds, question outcomes, predict before acting, and know who is good at what. The research design specifies persistent *structural* learning; these member-level behaviours are not part of it, and adding them changes what "EvoOrg" means.
- **Resolution:** implemented as separate, opt-in behaviours. Each is an optional flag that is off unless set, and absent flags keep every existing config's parsed form and hash unchanged.
  - **Learning:** `afterActionReview`, `playbook`, `lessonScoring`, `decisionJournal`.
  - **Deliberation:** `debate`, `evidenceRule`, `blindVote`, `tieBreak`, `preMortem`.
  - **Prediction:** `multiPath`, `trackRecord`, `expertiseDirectory`.
  - **Evolution:** `evolution.counterfactualReview`, `evolution.contributionCheck`, and the LLM proposer (C-20 update).
- **Rules every extension keeps:**
  - each model call is a real call by a named agent, charged to the task budget, and each result is an event;
  - hidden-test content never enters a prompt (reviews see only the score);
  - lessons stay inside a run, so repetitions remain independent;
  - shadow re-executions are charged to the parent run once.
- **Update (2026-11-06, researcher decision):** the pilot now runs with every behaviour on for every team (`feasibility-full.yaml`, `pilot-full.yaml`; pilot protocol addendum 3, recorded before any pilot data). The original configs stay unchanged and unrun. `features.planDecision` was added so that deliberation happens on every task (the team decides between the alternative plans), not only when an agent chooses to call a decision.
- **Validity effect:** the original pre-registered configs (pilot, feasibility, safety, Claude replication) run none of this. Its effect is to be tested by its own experiment, `experiments/organization/` (draft pre-registration, matched per-task budget, one condition per feature group). Until that runs, no claim is made that any extension helps.
