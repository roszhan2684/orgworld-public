# OrgWorld lab notebook

Automated nightly research sessions for [OrgWorld](https://github.com/roszhan2684/orgworld-public), written by [`lab/daily.sh`](https://github.com/roszhan2684/orgworld-public/blob/main/lab/README.md) on the researcher's machine with a free local model (no paid model calls). Every session is recorded, including skipped, blocked and cut-short ones. Runs that were cut short or hit model-service failures stay in the data but are excluded from aggregates (C-19).

## Experiments

_No experiment has started yet._

## Sessions

_No session yet._

## Reading the data

- `data/<experiment>/readings.json`: every condition × repetition slot, with its counted run, excluded attempts and metrics. Interim aggregates are not results.
- `data/<experiment>/results.csv`: one row per counted run (same columns as `orgworld experiment`).
- `data/<experiment>/runs/*.orgworld-run.zip`: the full event log of every run, including excluded ones and validation shadows. Replay one with `orgworld replay`, or read `events.jsonl`.
- `data/<experiment>/provenance.json`: the code bundle, model weights digest and runtime that the experiment is locked to, with every recorded change.
- `sessions.jsonl`: one line per session.


