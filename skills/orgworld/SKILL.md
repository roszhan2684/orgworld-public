---
name: orgworld
description: Start or inspect an OrgWorld run. With an objective, runs the 12-agent organization on it; without arguments, shows status (initialising .orgworld/ first if needed).
argument-hint: "[objective]"
disable-model-invocation: true
allowed-tools: Bash(orgworld:*)
---
If `.orgworld/` does not exist in the project, run `orgworld init` and show its output.
If $ARGUMENTS is empty, run `orgworld status` and stop.
Otherwise:
1. Run `orgworld doctor`. If free cognition is unavailable (Ollama not reachable or no model), stop and tell the user the exact fix it printed (e.g. `ollama serve`, `ollama pull qwen2.5-coder:7b`).
2. Start the web world in the background: `orgworld serve` (run_in_background). Tell the user the URL it prints.
3. Run `orgworld run "$ARGUMENTS" --no-serve` and summarise the final Status line.
Rules: never pass --allow-paid unless the user explicitly asks to spend money; OrgWorld defaults to free local cognition (Ollama). Report only what the commands print — never invent agent activity or results.
