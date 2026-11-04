# OrgWorld

**Developer story:** turn your repository into a living AI engineering organization you can watch.
**Research story:** a laboratory for studying persistent, self-evolving multi-agent organizations (EvoOrg: *continual organizational learning*).

> **About this public copy.** This is a snapshot of the working repository without the private research dossier (`EVOORG_RESEARCH.md` and its source PDF). Section references such as "II-§63" in code and docs point to that dossier; how each requirement is implemented is in `docs/research/RESEARCH_REQUIREMENTS_MAP.md`, and every deviation is in `docs/research/IMPLEMENTATION_CONFLICTS.md`. Pre-registered experiments (written before any data) are in `experiments/`; current verified status is in `docs/verification/STATUS.md`.

Every character move, message and number in OrgWorld comes from a recorded runtime event:
`real agent action → state change → recorded event → SQLite (append-only) → world, inspector, metrics`.

## Install as a Claude Code plugin

```text
/plugin marketplace add <owner>/orgworld
/plugin install orgworld@orgworld
/orgworld:orgworld Build authentication for the sample app
```

Skills: `/orgworld:orgworld`, `/orgworld:run`, `/orgworld:status`, `/orgworld:watch`, `/orgworld:why`. MCP tools: `orgworld_*` (read / write / exec groups). Plugin commands are namespaced (`/orgworld:…`); see conflict C-17.

## Use the CLI directly

```bash
pnpm install && pnpm build
node dist/orgworld.mjs init                 # .orgworld/ with the 12-agent org, sandbox mode
ollama serve & ollama pull qwen2.5-coder:7b  # free local cognition (default)
node dist/orgworld.mjs run --task sec-safe-join#0
node dist/orgworld.mjs serve                # web world at http://127.0.0.1:4317
node dist/orgworld.mjs why | replay | export | experiment experiments/pilot.yaml
```

**No money by default.** The default cognition provider is Ollama (local, $0). Paid providers (`claude-cli`, `anthropic-api`) are refused unless you pass `--allow-paid`.

## Architecture

```text
bench (EvoOrgBench tasks + permission-sandboxed evaluator)
  └─▶ runtime (agents = separate model calls, each seeing only what it knows)
        └─▶ store (SQLite event log, append-only triggers) ─▶ server (HTTP + WS) ─▶ web world
evoorg (bandit policy · evolution controller · per-task designer) ─▶ experiment runner ─▶ metrics (pure functions over events)
```

Docs: `docs/architecture/ARCHITECTURE.md`, ADRs in `docs/decisions/`, research mapping and conflicts in `docs/research/`, status in `docs/verification/STATUS.md`.

## Research methodology

Conditions (same task stream, model and per-task budget): single agent (B0), fixed generalists (B1), fixed specialists (B2), per-task adaptive (B3), random persistent evolution (B7), EvoOrg (B8), plus ablations A1–A7. Metrics: cumulative reward, success per phase, adaptation half-life, lifetime cost including validation re-runs, structural churn, specialization index, topology. Statistics: 95% CI and paired bootstrap. Falsification criteria are listed in `docs/research/RESEARCH_REQUIREMENTS_MAP.md`.

## Limitations

See `docs/verification/STATUS.md`. Notably: no real experiment has been run yet; literature baselines (TacoMAS/MetaGen/AgentConductor-style) are not implemented; only one model family is available; browser rendering of the web world has not been verified by automation.
