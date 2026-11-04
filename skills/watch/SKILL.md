---
name: watch
description: Open the OrgWorld web world (live view, replay, network, evolution, metrics).
disable-model-invocation: true
allowed-tools: Bash(orgworld:*)
---
Run `orgworld serve` with run_in_background and give the user the URL it prints. The page shows only recorded events.
Rules: never pass --allow-paid unless the user explicitly asks to spend money; OrgWorld defaults to free local cognition (Ollama). Report only what the commands print — never invent agent activity or results.
