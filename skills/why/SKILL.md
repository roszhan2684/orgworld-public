---
name: why
description: Explain the latest organizational decision or organization change using only persisted provenance.
disable-model-invocation: true
allowed-tools: Bash(orgworld:*)
---
Run `orgworld why` and present its output verbatim-faithfully. If it says nothing was recorded, say so — do not speculate about reasons.
Rules: never pass --allow-paid unless the user explicitly asks to spend money; OrgWorld defaults to free local cognition (Ollama). Report only what the commands print — never invent agent activity or results.
