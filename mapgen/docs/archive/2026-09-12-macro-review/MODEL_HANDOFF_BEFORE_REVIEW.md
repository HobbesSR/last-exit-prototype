# Macro model redesign handoff

Archived checkpoint before review ingestion. See workspace-root MODEL_HANDOFF.md
for current work; historical pending tasks below are not the active queue.

## Updated checkpoint: contract milestone complete, 2026-09-12

The previous next action (versioned interfaces plus four acceptance fixtures
before replacing generation) is implemented and verified. New files are
`src/macro-types.ts`, `src/macro.ts`, `tests/macro.test.ts`, and
`docs/MACRO_STRUCTURES.md`. `src/core.ts` now exports the existing region search
with a minimal input type so composition reuses it. DESIGN_DECISIONS, NEXT_TASKS
and QUESTIONS record the new checkpoint and reversible ownership defaults.

`composeMacro` handles cell ownership, filler paint, rotated segment apertures,
matching shared boundaries, mask/material barriers, entrances, reserved
polylines and per-radius sampled route constraints. Its 11 focused tests include
all four requested geometry cases. Lead review corrected cell-square rotation,
exact shared-span agreement and phantom outside-mask wall emission.

Actual verification: `npm test` passed all 65 tests including typecheck;
`node tests/browser.mts` passed; the 200-seed `macro-redesign` batch passed
200/200 (`test-results/batch.json`). This batch exercises the legacy generator,
not randomized macro placement, which remains pending.

The GUI/CLI/MCP still use the legacy generator. A composition is a NavTarget,
not a GeneratedMap; do not send it to the legacy artifact codec or validateMap.
Library field and metric renames remain part of the pending version migration.
No general geometric dead-end detector was added. The old checkpoint and
diagnosis below remain useful context, but its pending design work is now
specified in `docs/MACRO_STRUCTURES.md`.

Claude tasks are manually launched by Corey and coordinated through files.
`docs/CLAUDE_MACRO_REVIEW.md` is the next bounded task: independent read-only
correctness review, with findings written to `docs/CLAUDE_MACRO_REVIEW_RESULTS.md`.
No Claude run has been started by Codex. The next implementation phase is still
owned by the lead; incorporate review findings before generator integration.

## Recommended model

GPT-6 Astra. This is an architecture task involving generator ordering,
authoring contracts, derived navigation, artifact compatibility, and migration
of several coupled assumptions. Use Terra only for bounded implementation slices
after the new contracts are written.

## Objective

Replace the current tile-edge-first maze model with one where tiles are merely
an authoring/assembly grid, macro structures can span arbitrary collections of
tiles, region membership is cell-derived across tile seams, and traversability
is derived from composed geometry for each agent clearance.

Representative required cases:

- an open field spans many tiles with no walls along tile edges or at four-tile
  meetings;
- one tile is entirely one region class and joins a larger cross-tile region;
- a building footprint, courtyard, street, or cul-de-sac crosses multiple
  tiles;
- the same geometry yields different connectivity for contestant and hunter
  radii;
- a dead end is diagnosed from navigable space/corridors, not degree one in a
  graph whose nodes happen to be tiles.

## Current checkpoint

The repository is TypeScript (`.ts`/`.mts`) and Node executes it without a build
copy. `npm test` passes 53 tests as of 2026-09-12. Cell-level flood fill already
aggregates cross-tile regions after placement, and navigation already checks
swept-disc clearance against composed walls. These are useful foundations.

The central mismatch remains in `src/core.ts`: it creates a spanning tree plus
loop/squeeze tile edges, converts every adjacency to a coarse required seam
kind, and then selects templates that fit those preselected seams. Closed seams
therefore arise from topology rather than authored physical structure. Metrics
then call degree-one tile nodes `deadEnds`. `public/app.ts` now labels that value
`Tile-graph leaves` to avoid claiming more than it measures.

`TileTemplate.regionClass` in `src/types.ts` is a default cell paint, despite its
name suggesting a property of the whole tile. `INTERIOR_MARGIN` in
`src/primitives.ts`/`src/tiles.ts` also prevents ordinary authored geometry from
continuing to a seam. Do not patch these independently until the structure
contract decides how footprints own and compose boundary primitives.

## Decisions established for the redesign

- Tile boundaries are geometrically inert unless authored content states
  something there.
- Regions belong to cells and are aggregated after composition. Tiles do not
  own regions.
- Traversability is derived from final geometry plus agent properties. It is
  not an authored tile flag or authoritative tile-edge state.
- Macro structures may cover one tile, many tiles, or portions of tiles.
- Fully open seams/corners are first-class ordinary content.
- Graphs remain useful as solver products, navigation indexes, and metrics, but
  they must be derived from or verified against physical geometry.
- Flat 2D remains the implementation target. Preserve later height/layer
  extensibility without implementing 2.5D now.

## Pending design work

Define a versioned `MacroStructure`/footprint contract before changing the
generator. It should say how a structure selects slots/cells, paints region
intent, contributes segments/geometry, exposes optional entrances, reserves
corridors, composes with filler, rotates, and reports constraints/manifests.
Decide pass ordering between structure placement and route shaping. A promising
direction is: mask/tier field → required structures/features → compose structure
and filler geometry → derive per-agent navigation → validate/tune/reroll. Do not
assume this sequence without testing how obstruction set pieces request desired
cuts or cul-de-sacs.

Plan artifact/schema migration explicitly. Prefer `defaultCellClass` over
`TileTemplate.regionClass`; reserve `regionClass` for actual aggregated regions.
Rename `metrics.deadEnds` to `tileGraphLeaves` immediately in a version bump or
remove it when geometric analysis replaces it. Keep old artifact decoding only
if its cost is small for this standalone prototype.

## Owned paths and dirty state

There is no Git repository at this workspace root, so use file inspection rather
than relying on Git diffs. The latest cleanup intentionally edits:

- `public/app.ts`
- `docs/DESIGN_DECISIONS.md`
- `docs/NEXT_TASKS.md`
- `MODEL_HANDOFF.md`

Claude's earlier substantive TypeScript and primitive/artifact work spans
`src/`, `tools/`, `tests/`, `public/`, `content/`, `README.md`, and package files.
Preserve it unless the new contract deliberately supersedes it.

## Acceptance checks

Run:

```powershell
npm test
node tests/browser.mts
node tools/cli.mts batch --seed macro-redesign --count 200 --out test-results/batch.json
```

Add focused acceptance fixtures for a wall-free multi-tile field, a multi-tile
building with openings unrelated to tile centers, a cross-tile cul-de-sac, and
different contestant/hunter connectivity derived from the same geometry.
Geometry checks must back all connectivity claims.

## Stop and escalation criteria

Escalate before encoding a permanent structure schema if overlapping structure
ownership cannot be resolved cleanly, or if the topology pass would again have
to declare closed tile seams as physical truth. Keep open design questions in
`docs/QUESTIONS.md`; do not block on tuning values.

## Next action

Complete the independent review described in `docs/CLAUDE_MACRO_REVIEW.md`, then
connect bounded structure placement to generation and perform the versioned
library/artifact migration outlined in `docs/MACRO_STRUCTURES.md`. Keep schema
and consequential integration decisions with the lead. Do not replace defaults
until GUI/CLI/MCP parity and JSON/BSON round-trip checks pass.

Prompt: **Read AGENTS.md and MODEL_HANDOFF.md, then implement the next ready task and verify it.**
