# OrgWorld lab notebook

Automated nightly research sessions for [OrgWorld](https://github.com/roszhan2684/orgworld-public), written by [`lab/daily.sh`](https://github.com/roszhan2684/orgworld-public/blob/main/lab/README.md) on the researcher's machine with a free local model (no paid model calls). Every session is recorded, including skipped, blocked and cut-short ones. Runs that were cut short or hit model-service failures stay in the data but are excluded from aggregates (C-19).

## Experiments

| Experiment | ID | Progress | Locked |
| --- | --- | --- | --- |
| feasibility-0 | `exp_a7788fdd09dd` | 0/3 runs | not yet |

## Sessions

| Date | Outcome | Experiment | New runs | Progress | Why it stopped |
| --- | --- | --- | --- | --- | --- |
| [2026-11-06](sessions/2026-11-06-2.md) | skipped | — | — | — | Started outside the window 01:00–06:30 (the Mac was probably asleep at 01:00). |
| [2026-11-06](sessions/2026-11-06.md) | blocked | feasibility-0 | — | 0/3 | Ollama runs the model on the CPU, not the GPU (the Intel build under Rosetta: about 8 minutes per agent turn), so no run can finish in one window. Install the Apple-silicon Ollama app (see lab/README.md). |

## Reading the data

- `data/<experiment>/readings.json`: every condition × repetition slot, with its counted run, excluded attempts and metrics. Interim aggregates are not results.
- `data/<experiment>/results.csv`: one row per counted run (same columns as `orgworld experiment`).
- `data/<experiment>/runs/*.orgworld-run.zip`: the full event log of every run, including excluded ones and validation shadows. Replay one with `orgworld replay`, or read `events.jsonl`.
- `data/<experiment>/provenance.json`: the code bundle, model weights digest and runtime that the experiment is locked to, with every recorded change.
- `sessions.jsonl`: one line per session.

Code for current sessions: [`9d990e7`](https://github.com/roszhan2684/orgworld-public/tree/9d990e7fde1b082cd5774a6e69fca65aeb687889).
