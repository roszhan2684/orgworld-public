# ADR-006: Separate policy learning (fast) from structural evolution (slow)

## Context
Build §5 defines Stages 0–3; research I-§24 multi-timescale learning and II-§13–14 periodic, evidence-gated evolution. Build §82 forbids calling heuristics "RL".

## Decision
- **Stage 0 (observation):** always on; `RL_STATE_OBSERVED` / outcome events form the dataset.
- **Stage 1 (per task):** `OrgPolicy.select(taskFeatures, candidates) → {choice, scores, kind}` with kinds `random` (random baseline), `heuristic` (heuristic policy), `thompson` (bandit policy: Beta posterior per (feature-bucket, genome-variant)). Emits `RL_ACTION_SELECTED{kind, scores}` — scores are the policy's actual sampled values, never decorative.
- **Stage 2 (within task):** state/action types + a transparent heuristic policy only; not called RL.
- **Stage 3 (every K tasks):** `EvolutionController` mutates the persistent genome via validated proposals (Paper-#1 mutation set by default).
- Policies never edit the genome; only the controller does. Each has its own ablation flag.

## Alternatives
Single RL agent over all decisions (huge action space, no credit assignment — research II-§59 warns against this for now).

## Consequences
Clear attribution in analysis: a gain can be credited to Stage 1 or Stage 3 by ablation.

## Evidence
Policy evaluation suite on synthetic reward environments: `packages/evoorg/test/policy.test.ts` (bandit regret < random regret over seeds).
