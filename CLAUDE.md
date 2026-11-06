# OrgWorld — guide for Claude

OrgWorld is a local-first runtime + visual world for **persistent, self-evolving LLM multi-agent organizations**; EvoOrg is its research engine. It is a research instrument first.

## Sources of truth
- Science: `EVOORG_RESEARCH.md` (verbatim from `docs/research/source/*.pdf`). It wins on any scientific question. **Both files are private and local-only** (gitignored, blocked by a pre-commit hook and a CI check): never commit, quote at length, or publish them; this repo is public.
- Implementation: `ORGWORLD_BUILD.md` (truncated at §100 — see conflict C-00).
- Mapping & deviations: `docs/research/RESEARCH_REQUIREMENTS_MAP.md`, `docs/research/IMPLEMENTATION_CONFLICTS.md`. Never change the scientific design silently — add a conflict entry.
- Architecture: `docs/architecture/ARCHITECTURE.md`, ADRs in `docs/decisions/`, plan in `docs/architecture/BUILD_PLAN.md`, status in `docs/verification/STATUS.md`.

## Invariant
REAL AGENT ACTION → REAL STATE CHANGE → RECORDED EVENT → PERSISTED DATA → VISUALIZATION. State changes only through validated events appended to the store. No fake conversations, no scripted demos, no decorative animation, no "RL" label on heuristics.

## Boundaries
- `packages/evoorg` must not import `packages/cognition/src/providers/claude-cli*` (interface only).
- `apps/web` depends only on `protocol` + `core`; it derives everything from events.
- The `scripted` provider is test-only; runs using it are labelled and excluded from experiment aggregates.

## Commands
- `pnpm install` · `pnpm typecheck` · `pnpm test` · `pnpm build` (bundles `dist/`)
- `node dist/orgworld.mjs doctor|init|run|status|watch|replay|export|why|experiment|readings`
- Nightly lab: `lab/setup.sh` (freeze code, notebook clone, launchd file) · `~/orgworld-lab/bin/daily.sh` (one session) · settings `~/orgworld-lab/lab.env`; readings go to the `lab-notebook` branch
- `claude plugin validate .`

## Standards
TypeScript strict, ESM, Zod at every boundary, pure functions in `core`/`metrics`. Every new capability ships with tests; update `STATUS.md` and the relevant `docs/verification/PHASE-X.md` only with real command output. Keep failed runs and negative results.
