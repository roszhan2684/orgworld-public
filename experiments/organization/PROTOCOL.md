# Pre-registration (DRAFT, for the researcher's review) — org-behaviour-pilot

Written 2026-11-06, before any data. `org-behaviour-pilot.yaml` is the exact configuration; its hash is stored when the experiment locks. **Status: draft.** It is not in the lab queue, and it runs only after the researcher approves this text and the pilot (`experiments/pilot/`) has finished.

**Question.** EvoOrg learns by changing its structure. Does it get better at the same per-task budget when its members also learn from outcomes (review, playbook, scored lessons, decision journal), deliberate (debate, evidence, blind first vote, tie-break, pre-mortem), and predict (alternative plans, track records, who-knows-what)? These extensions are listed in conflict C-21. They are not part of the original research design; this experiment is how they earn a place.

**Conditions.** All are EvoOrg starting from the 12-agent software organization, on the same task stream, model and per-task budget:
- `evo-base`: no extensions.
- `evo-learn`: learning loop (ideas 12–15).
- `evo-debate`: deliberation (16–20).
- `evo-predict`: prediction (21–23).
- `evo-all`: all of 12–23, plus the counterfactual screen and contribution check in evolution (24–25).
- `evo-all-self`: `evo-all`, plus the organization proposing its own structural changes (26) alongside the rule-based proposer.

**Primary comparison (OB-H1).** Paired bootstrap of cumulative reward, `evo-all − evo-base`. Supported only if the 95% CI excludes 0 in `evo-all`'s favour.

**Secondary.**
- **OB-H2–H4:** each group against `evo-base`.
- **OB-H5:** `evo-all-self − evo-all`, which tests whether self-proposed changes add anything over the rules.
- **Cost:** lifetime tokens, including every validation and counterfactual re-run. An extension that wins only by spending more of the same budget is reported as such.
- **Mechanism readings (descriptive, not hypothesis tests):** lessons kept and retired, mean lesson utility, debated decisions, changed minds, prediction Brier score, contribution checks.

**Falsification.** OB-H1 fails if `evo-all ≤ evo-base`. Any group whose CI includes 0 is reported as no evidence of benefit, and every result is reported whatever it shows.

**Controls.**
- **Model:** qwen2.5-coder:7b, seed 7, temperature 0, context pinned to 16,384 tokens.
- **Budget:** 120k tokens and 40 calls per task, identical for every condition. The extensions pay for their calls out of this budget.
- **Evaluation:** hidden tests in a permission sandbox. Hidden-test content never enters any prompt, including reviews.
- **Learning stays inside a run:** every repetition starts with no lessons.

**Known threats (stated in advance).**
1. **Scale:** 2 repetitions and 60 tasks are a pilot.
2. **Agreeable models:** a 7B model may agree too easily, making debates noise. Changed minds and argument evidence are recorded to check this.
3. **Repeated variants:** the task pool repeats variants, so the playbook stores approaches, not code, to limit copying.
4. **Long prompts:** the 12-agent organization makes prompts long, so truncation is counted every session.
5. **Bundled extensions:** `evo-all` bundles many of them, so the group conditions are needed to say which one matters.

**Run.** Through the lab queue (`lab/README.md`), after the researcher's approval: add `experiments/organization/org-behaviour-pilot.yaml` to `QUEUE` and refreeze the code (`lab/setup.sh --refreeze`) between experiments.
