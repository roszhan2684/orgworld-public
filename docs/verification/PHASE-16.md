# Phase 16 — Organization-behaviour extensions (conflict C-21)

**Status:** IMPLEMENTED (scripted). No real-model evidence yet.

**What exists.** Each item is an opt-in flag, off by default.

| # | Flag | What it does | Extra model calls |
|---|---|---|---|
| 12 | `features.afterActionReview` | After a failure, or a category's first success, the submitter asks "why?" up to three times and writes one lesson for that category. A repeated lesson reinforces the existing one. | 1, only after a failure or a category's first success |
| 13 | `features.playbook` | The approach behind a category's first success is kept and offered at the start of later tasks in that category. | 0 (or comes with the review) |
| 14 | `features.lessonScoring` | Each lesson offered to a task is scored by that task's outcome. A lesson used 3+ times whose utility falls more than 0.1 below the run's success rate is retired. | 0 |
| 15 | `features.decisionJournal` | Every decision keeps its prediction and its task's outcome, and voters see similar past decisions. | 0 |
| 16 | `features.debate` | Only on disagreement: a critic argues against the leading option, a supporter rebuts, and everyone votes again. Changed minds are recorded. | 2 + one re-vote per voter |
| 17 | `features.evidenceRule` | Votes and arguments citing no evidence the agent can see count half. | 0 |
| 18 | `features.blindVote` | The first round is cast without the proposer's recommendation, and dissent is kept as a minority report. | 0 |
| 19 | `features.tieBreak` | Without a majority, the agent with decision authority (else the entry agent) settles it with its own vote. | 0 |
| 20 | `features.preMortem` | After a decision, a critic imagines it failed and names the risks and one mitigation. | 1 |
| 21 | `features.multiPath` | Before the first turn, the entry agent sketches 2–3 plans with predicted success. The best guides the team, and its prediction is scored. | 1 per task |
| 22 | `features.trackRecord` | Predictions are scored (Brier), and 0.5 + (1 − mean Brier) sets each agent's vote weight. | 0 |
| 23 | `features.expertiseDirectory` | Each agent sees who among it and its contacts has passed which categories. | 0 |
| 24 | `evolution.counterfactualReview` | A proposal is first replayed on the recently failed tasks and compared with what actually happened. If it isn't better, it's rejected before full validation. | shadow replays (validation cost) |
| 25 | `evolution.contributionCheck` | At each trigger, one agent in rotation is removed in a replay to measure what it adds. A non-contributor becomes a removal proposal. | shadow replays (validation cost) |
| 26 | `evolution.proposer: llm \| both` | The organization proposes its own structural change from the evidence (labelled `llm`), validated like any other. | 1 controller call per trigger |
| 27 | `experiments/organization/` | Draft pre-registration on the 12-agent organization, one condition per feature group, with matched per-task budget and a pinned context window. | — |
| 28–29 | `apps/web/src/research/views.ts` | Deliberation view (rounds, arguments, changed minds, prediction vs outcome, track records) and knowledge view (lessons and playbook with performance, reviews, who-knows-what, growth). Not yet placed in the app layout. | — |

**Rules kept.**
- Every call is a real call by a named agent, charged to the task budget, and every result is an event: `REFLECTION_RECORDED`, `LESSON_EVALUATED`, `DECISION_REVIEWED`, `ARGUMENT_MADE`, `PLANS_PROPOSED`, `PREDICTION_SCORED`, `COUNTERFACTUAL_EVALUATED`, `CONTRIBUTION_MEASURED`, plus optional fields on `VOTE_CAST`, `DECISION_COMPLETED` and `MEMORY_WRITTEN`.
- Memories cite their source event.
- Hidden-test content never enters a prompt.
- Lessons stay inside a run.
- Shadow replays are charged to the parent run once, even when one replay serves several checks.
- A run with no extensions reduces to exactly the state it did before: the pinned golden replay is unchanged.
- `model.contextTokens` pins Ollama's `num_ctx`.

**2026-11-06 run (real output):** `pnpm typecheck` → 0 errors. `pnpm vitest run --project unit` → `Test Files 16 passed (16) · Tests 148 passed (148)`, three consecutive runs. The new tests include:
- `organization.test.ts › a decision with default features emits none of the new records and keeps the old vote prompt`
- `organization.test.ts › blind first vote, evidence rule, debate with changed minds, tie-break, pre-mortem, scored predictions`
- `organization.test.ts › the next decision sees similar past decisions`
- `organization.test.ts › a failure is reviewed into a lesson, the lesson is offered and scored on the next task, the first win becomes a playbook entry`
- `organization.test.ts › a lesson whose tasks keep failing while others pass is retired and no longer offered; repeats reinforce it`
- `organization.test.ts › multi-path planning picks the best predicted plan, guides the entry agent, and is scored`
- `experiment.test.ts › counterfactual screen on failed tasks, contribution check, shared re-runs, every shadow call charged once`
- `experiment.test.ts › the organization proposes its own change (labelled "llm"); it is validated like any other; unusable proposals are recorded`
- `pilot-config.test.ts › adding the optional feature flags did not change the pre-registered configs (same parsed form, same hash)`
- `research-views.test.ts › render decisions, debate, lessons and expertise from recorded events, escaping agent text`
- `cognition.test.ts › … num_ctx sent only when configured`

**Not done.**
- No real-model run of any extension. Whether the 7B model debates usefully, writes useful lessons or predicts well is unknown.
- The views are not yet placed in the app's layout.

**How to re-verify:** `pnpm typecheck && pnpm vitest run --project unit`.
