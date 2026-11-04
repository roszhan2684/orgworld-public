---
name: run
description: Run the OrgWorld organization on an objective or a benchmark task (--task family#variant).
argument-hint: "<objective> | --task <family#variant>"
disable-model-invocation: true
allowed-tools: Bash(orgworld:*)
---
Run `orgworld doctor` first; if free cognition is unavailable, stop and relay the fix. Then run `orgworld run $ARGUMENTS --no-serve` and summarise the Run, Org, Cognition and Status lines. Suggest `/orgworld:watch` to see it live.
Rules: never pass --allow-paid unless the user explicitly asks to spend money; OrgWorld defaults to free local cognition (Ollama). Report only what the commands print — never invent agent activity or results.
