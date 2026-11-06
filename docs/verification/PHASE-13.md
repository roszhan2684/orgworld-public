# Phase 13 — Experiment runner: B0–B3, B7, B8, ablations, locking, CSV

**Status:** VERIFIED (scripted)

**Evidence / tests:** identical streams across conditions; scripted results flagged "not research results". Pilot pre-registered (experiments/pilot/); Claude Haiku 5.5 replication and safety pilot pre-registered as drafts (experiments/pilot-claude/, experiments/safety/). Model-service failures are retried with backoff, never scored as tasks, excluded and re-attempted on resume; the $ ceiling survives a resume (C-19). **No real experiment run yet**

**2026-11-04 run (real output):** `pnpm typecheck` → 0 errors. `pnpm vitest run --project unit` → `Test Files 13 passed (13) · Tests 130 passed (130)`, including:
- `safety.test.ts › without Ω evolution prunes the idle reviewer; with Ω the same proposals are rejected and coverage stays 1`
- `safety.test.ts › an outage stops the experiment; the failed run is kept, excluded, and re-attempted on resume`
- `safety.test.ts › the $ ceiling counts money spent before a resume`
- `runtime.test.ts › exhausted retries stop the run instead of scoring a failed task` (+ backoff, retry-after, fatal-error tests)
- `pilot-config.test.ts › the Claude replication differs from the frozen pilot only in the model block and name`

Spend guard: `node dist/orgworld.mjs experiment experiments/safety/verification-erosion.yaml` (and `pilot-claude.yaml`) without `--allow-paid` → `"anthropic-api" costs money. … Pass --allow-paid to opt in explicitly.`, exit 1, nothing locked.

**2026-11-06 run (real output):** `pnpm typecheck` → 0 errors. `pnpm vitest run --project unit` → `Test Files 14 passed (14) · Tests 136 passed (136)`, adding:
- `safety.test.ts › a closed window starts no run; the next window resumes and finishes`
- `safety.test.ts › stops between runs when the longest completed run would not fit, and readings report it`
- `safety.test.ts › a run cut off mid-way is kept, excluded, and re-run from the start next time`
- `lab.test.ts › window / provenance / render` (lab/lab.mjs, the nightly-session helper)

Lab pipeline (scratch lab, test-only fake Ollama, local git remote; no research data): feasibility 3/3 runs completed and published; pilot run cut by the hard stop → `exp_…-single-r1: interrupted (status running); 16 task(s)` and the slot re-run as `-a2`; `time window: exp_…-pertask-r1 not started (the longest completed run took 2 min and would not finish in time)`. Real Ollama on this Mac (Intel build 0.20.6): `outcome: blocked … GPU offload 0%`.

**How to re-verify:** `pnpm typecheck && pnpm vitest run --project unit && pnpm test:e2e` (live phases only with explicit permission to spend).

**Known limitations:** see the status text above and docs/research/IMPLEMENTATION_CONFLICTS.md. Generated from STATUS.md so the two cannot disagree.
