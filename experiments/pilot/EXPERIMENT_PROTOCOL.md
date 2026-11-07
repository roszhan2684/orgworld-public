# Pre-registration — pilot-abrupt-shift (frozen before any run)

Written 2026-10-29, before data collection (research II-§67). The YAML in this folder is the exact configuration; its hash is stored when the experiment locks and any change afterwards is refused.

**Question.** Under an abrupt shift (phase A: implementation/debugging → phase B: security-heavy), does EvoOrg (persistent, evidence-gated structural evolution from 4 generalists) achieve higher cumulative reward than a fixed specialist team and a per-task adaptive designer, at the same per-task budget?

**Primary comparison (III-H1):** paired bootstrap of per-repetition cumulative reward, EvoOrg − per-task adaptive. Supported only if the 95% CI excludes 0 in EvoOrg's favour.

**Secondary:** AHL after task 50 (III-H2); lifetime tokens incl. validation (FC2: EvoOrg must not exceed per-task adaptive); EvoOrg vs random evolution (FC6).

**Falsification.** FC1 if EvoOrg ≤ per-task adaptive; FC2 if EvoOrg's advantage needs more lifetime tokens; FC4 if EvoOrg's AHL > per-task; FC6 if EvoOrg ≈ random evolution. Each is reported whatever the outcome.

**Controls.** Same model (qwen2.5-coder:7b, seed 7, temperature 0 — sampling controlled via Ollama), identical task sequence per repetition across conditions, per-task cap 60k tokens / 20 calls, evaluator = hidden tests in a permission sandbox.

**Known threats (stated in advance).** (1) Pilot scale: 3 repetitions cannot support strong claims; this pilot decides whether the full study is worth running. (2) Thin family pool for security/refactoring/testing (1 family each, 3 variants) — repeated variants make memorization-like effects possible. (3) Single model family (C-08). (4) The heuristic proposer encodes a human prior (category → specialist role); report it as such. (5) EvoOrg starts from generalists while B2 starts from human specialists — the comparison mixes "starting structure" with "learning"; the random-evolution arm and gen-by-gen analysis are the guard.

**Run.** `node dist/orgworld.mjs experiment experiments/pilot/pilot.yaml` (free; refuses paid providers). Results: `.orgworld/experiments/<id>.csv`. All runs, including failed ones, are kept.

## Addendum (2026-10-29, before any pilot data): feasibility run first
A first real free run (single agent, impl-rle#0) took 134 s for 7 model calls on the local model, implying ≈30+ h for pilot.yaml. Per research II-§36 ("investigate before spending"), `feasibility.yaml` (20 tasks, 3 conditions, 1 repetition) runs first. It measures runtime, format compliance and failure modes only; its numbers are never used as evidence for or against any hypothesis. pilot.yaml is unchanged.

## Addendum (2026-11-06, before any pilot data): execution in nightly sessions
The feasibility run and the pilot are executed by `lab/daily.sh` in nightly time windows on the same machine, spread over as many nights as needed. This changes how the runs are scheduled, not what is run: configuration, task streams, seeds, budgets and analysis are unchanged.
- **Runs are atomic.** No run starts unless the longest completed run of the experiment says it will finish inside the window. A run cut off by the window's hard stop is kept, excluded from aggregates and re-run from its start under a new attempt id, exactly like a model-service failure (C-19). Every session's notebook page reports these exclusions.
- **Fixed environment.** One frozen code bundle (sha256 recorded) and one set of model weights (Ollama digest recorded) for the whole experiment; a change to either blocks the experiment. A change in Ollama, Node or macOS version is recorded as a deviation in the notebook.
- **Runtime.** The 2026-10-29 timings came from an Intel Ollama build running on the CPU under Rosetta. The lab requires Ollama on the GPU (Apple silicon build). The model weights are the same; generation speed is not, so the feasibility run measures runtime again.
- **Interim readings.** Each session publishes progress and interim aggregates on the `lab-notebook` branch. They are labelled interim, they do not change the stopping rule (all planned runs), and the pre-registered analysis is run once, on the complete set.
- **Order.** `pilot.yaml` joins the queue only after the researcher has reviewed the feasibility results (runtime per task, format compliance, failure modes).

## Addendum 3 (2026-11-06, before any pilot data): every organization behaviour on
The researcher decided that the pilot runs with every organization behaviour on for every team: the learning loop, deliberation, prediction and organization checks (conflict C-21; `docs/verification/PHASE-16.md`). `feasibility-full.yaml` and `pilot-full.yaml` are the configurations. They replace `feasibility.yaml` and `pilot.yaml`, which were never run and are kept unchanged as the original registration.
- **What is identical:** the question, hypotheses, falsification criteria, task stream, seeds, conditions, repetitions and analysis.
- **What differs, and why:**
  - every C-21 behaviour is on for every team, so all teams have the same member capabilities;
  - EvoOrg's evolution also uses the counterfactual screen, the contribution check, and self-proposed changes (`proposer: both`);
  - the per-task budget is 120k tokens / 40 calls, the same for every condition, because the behaviours pay for their calls out of it;
  - the context is pinned to 16,384 tokens so prompts are not cut.
- **What this changes in the interpretation:**
  - every team now carries lessons, its playbook and its decision journal from task to task within a run. The fixed and per-task teams keep their structures but are no longer memoryless, so the comparison tests structural evolution on top of shared member learning, not structure versus no learning at all;
  - FC2 (lifetime tokens) now includes every review, debate, plan and replay;
  - the random-evolution arm keeps its random proposer.
- **Order:** `feasibility-full.yaml` first. It reports runtime per task, format compliance, prompt truncation and how often each behaviour fires. `pilot-full.yaml` joins the queue after the researcher has reviewed those results.
