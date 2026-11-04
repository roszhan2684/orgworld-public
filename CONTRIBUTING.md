# Contributing to OrgWorld

Thanks for helping. OrgWorld is a research instrument for persistent, self-evolving LLM multi-agent organizations, so the bar is that every number it shows can be traced to something that actually happened:

> real agent action → real state change → recorded event → persisted data → visualization

No scripted demos, no decorative animation that implies agent activity, no "RL" label on heuristics.

## Set up

You need Node ≥ 22.13 (for `node:sqlite`) and pnpm 11.

```bash
pnpm install
pnpm typecheck
pnpm vitest run --project unit   # ~6 s, free: uses the deterministic scripted provider
pnpm build                       # bundles dist/; commit the result (CI fails if dist/ is stale)
pnpm test:e2e                    # optional: browser tests (Playwright/Chromium)
```

**No test may cost money.** Tests use the scripted provider. For real model behaviour locally, use the free Ollama provider. Paid providers are refused unless someone passes `--allow-paid`, and they never run in CI.

## Finding something to work on

- Issues labelled [`good first issue`](../../labels/good%20first%20issue) are small and self-contained. [`help wanted`](../../labels/help%20wanted) are bigger.
- Comment on the issue before you start, so two people don't do the same work.
- Not sure where something lives? `docs/architecture/ARCHITECTURE.md` maps the packages, and `docs/verification/STATUS.md` lists what is done, partial or missing.

## Rules the codebase relies on

- **State changes only through validated events** appended to the store; the UI derives everything from events.
- **Package boundaries:** `apps/web` depends only on `protocol` and `core`; `packages/evoorg` must not import the Claude CLI provider.
- **TypeScript strict, ESM, Zod at every boundary,** pure functions in `core` and `metrics`.
- **Every change ships with tests.**
- **Don't change the scientific design silently.** If a change alters what an experiment measures or how, add an entry to `docs/research/IMPLEMENTATION_CONFLICTS.md` explaining the conflict and the resolution.
- **`docs/verification/STATUS.md` records real command output only.**

Section references such as "II-§63" point to the project's research dossier, which is not public. `docs/research/RESEARCH_REQUIREMENTS_MAP.md` says what each one requires and how it is implemented. If you need more context, ask in the issue.

## Pull requests

- One topic per PR, with a description of what changed and why.
- `pnpm typecheck`, `pnpm vitest run --project unit` and `pnpm build` pass, and `dist/` is committed.
- **AI-assisted contributions are welcome**, but you are responsible for every line: understand it, test it, and say in the PR description that you used AI assistance.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Conduct

Be kind and assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
