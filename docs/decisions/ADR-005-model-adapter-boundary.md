# ADR-005: Cognition provider boundary

## Context
Build §2/§0.13: providers replaceable; EvoOrg independent of Claude. Environment facts (2026-10-28): no `ANTHROPIC_API_KEY`; Claude Code 2.1.312 is installed and `claude -p` works with subscription auth.

## Decision
`interface CognitionProvider { id; complete(req: {system, prompt, jsonSchema?, model, maxOutputTokens?, category, purpose}): Promise<CognitionResult> }` where the result always carries `usage {input, output, cacheRead, cacheCreation}`, `costUsd`, `model`, `provider`, `samplingControlled`, `latencyMs`.

Providers:
1. `claude-cli` — spawns the Claude Code binary headless with a **stripped context**: `-p --output-format json --tools "" --strict-mcp-config --disable-slash-commands --setting-sources "" --no-session-persistence --system-prompt <role prompt> [--json-schema]`. Without these flags a call loaded ~168k cached tokens of the user's plugins/MCP tools ($0.17); with them a trivial call used 913 input tokens ($0.000315) — measured 2026-10-28. Binary resolved from `ORGWORLD_CLAUDE_BIN`, `CLAUDE_CODE_EXECPATH`, or `claude` on PATH.
2. `anthropic-api` — Messages API via `fetch`; honours `temperature` and `max_tokens` (exact budget caps).
3. `scripted` — deterministic responses for tests. Every call is stamped `provider: "scripted"`; the metrics layer and UI label such runs "SCRIPTED (not real cognition)" and experiments refuse to aggregate them.

## Alternatives
Claude Agent SDK in-process (heavier dependency, same auth question); one Claude session role-playing all agents (explicitly forbidden by build §0).

## Consequences
Each OrgWorld agent turn is an isolated model invocation with only that agent's context — a real separate reasoning actor, not one model pretending to be twelve. Sampling controls are unavailable for `claude-cli` (conflict C-07).

## Evidence
Measurements above; provider contract tests in `packages/cognition/test`.
