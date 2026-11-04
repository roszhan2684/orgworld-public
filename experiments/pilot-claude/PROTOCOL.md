# Pre-registration — pilot-abrupt-shift-haiku55 (replication on Claude)

Written 2026-11-04, before any data. **Status: draft for the researcher's review**; frozen when the experiment first locks (config hash stored).

This is the pre-registered pilot in `experiments/pilot/EXPERIMENT_PROTOCOL.md`, run on Claude Haiku 5.5 instead of the local `qwen2.5-coder:7b`. **Question, primary comparison, secondary measures, falsification criteria FC1/FC2/FC4/FC6 and known threats are adopted unchanged from that document.** `cli/test/pilot-config.test.ts` checks that `pilot-claude.yaml` equals `pilot/pilot.yaml` except for the experiment name, the model block and the $ ceiling.

## Differences from the local-model pilot

| | Local pilot | This replication |
|---|---|---|
| Model | `ollama/qwen2.5-coder:7b`, seed 7, temperature 0 | `anthropic-api/claude-haiku-5-5` |
| Sampling | controlled | **not controlled**: the model rejects non-default temperature (C-20); repetitions carry sampling variance |
| Cost | $0 (local) | priced per call from the published price list (2026-11-04); ceiling $100, worst case ≈ $60 |

## Additional threats

1. Without sampling control, run-to-run differences include sampling noise. With 3 repetitions this widens CIs. It does not bias paired comparisons, because each repetition gives every condition the same task sequence.
2. Comparing this replication with the local-model pilot is exploratory. Two models are not a test of generality (≥ 3 families are required, C-08).

## Run

```bash
export ANTHROPIC_API_KEY=...
node dist/orgworld.mjs experiment experiments/pilot-claude/pilot-claude.yaml --allow-paid
```

Infrastructure failures stop the experiment without scoring anything; re-running resumes (C-19).
