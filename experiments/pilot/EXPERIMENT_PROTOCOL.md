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
