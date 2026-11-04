---
name: status
description: Show the latest OrgWorld run status, agents and costs.
disable-model-invocation: true
allowed-tools: Bash(orgworld:*)
---
Run `orgworld status` then `orgworld agents` and show the output concisely.
Rules: never pass --allow-paid unless the user explicitly asks to spend money; OrgWorld defaults to free local cognition (Ollama). Report only what the commands print — never invent agent activity or results.
