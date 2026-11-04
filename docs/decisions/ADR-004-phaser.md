# ADR-004: Phaser world inside a Vite + React app

## Context
Build §21 recommends Next.js + React + Phaser; §54 requires separating simulation rendering from React state; §45 requires a local-first runtime.

## Decision
- Phaser 3 renders the world (tilemap rooms, characters, A* grid pathfinding, speech bubbles). React renders inspector/research panels.
- A single event bus feeds both: WS events → shared `core` reducer (outside React) → Phaser scene diff (imperative) and a throttled React snapshot (≤10 Hz).
- **Vite** instead of Next.js: the UI is a static client served by the local runtime server (no SSR, no API routes needed — the API is `packages/server`). Recorded as non-scientific deviation C-14.

## Alternatives
Next.js static export (heavier build, unused features); PixiJS (lower-level, would reimplement scenes/tweens); pure SVG world (poor at 100+ animated characters).

## Consequences
Reduced-motion mode replaces tweened movement with instant placement and a textual activity list (build §75). The same reducer drives backend and UI, so backend/UI state equivalence is testable.

## Evidence
Phase 5 verification: Playwright test asserts the agent positions/activities shown in the world equal `deriveAgentActivity` over the server's events.

## Amendment (2026-10-28): plain Canvas 2D + vanilla TypeScript instead of Phaser + React
**Decision change.** The v0.1 world is ten rooms and ≤100 sprites on fixed corridor waypoints; Phaser's scene graph, physics and asset loader would be unused weight, and React adds a second state system. The web app is vanilla TypeScript bundled by esbuild (same toolchain as the CLI): the shared `@orgworld/core` reducer owns state, a Canvas 2D renderer owns animation (requestAnimationFrame, independent of DOM updates, satisfying build §54), and DOM panels re-render at most ~10 Hz. Recorded as a non-scientific deviation in IMPLEMENTATION_CONFLICTS C-14. Revisit if isometric art or >250 animated sprites are required.

## Amendment 2 (2026-10-29): 3D village with Three.js (user direction)
The researcher asked for a 3D fantasy world (grass, cottages, trees, butterflies, morning light). This overrides build §21 "do not begin with full 3D" (the user's explicit direction wins on visual design; recorded as C-18). Implementation: `apps/web/src/world3d.ts` (Three.js 0.179.1, bundled). Rooms are cottages along a village path (the corridor); agents stand in the front yards and walk the paths. **Scenery vs. state:** grass, trees, flowers, butterflies and lighting are ambient decoration and never encode runtime state; agents still move only when reduced events change (positions computed in `main.ts`, unchanged). Reduced-motion disables ambient animation and walking. Evidence: `docs/verification/evidence/web-world-3d.png`, browser E2E `tests/e2e/web.e2e.test.ts` (backend/UI agent state equality, picking, view-as, replay, live stream).
