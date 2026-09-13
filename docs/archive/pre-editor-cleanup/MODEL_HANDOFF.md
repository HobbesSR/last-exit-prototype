# Macro redesign handoff, 2026-09-12

## Current checkpoint

Contract/composition milestone complete; independent Claude review ingested and
archived at docs/archive/2026-09-12-macro-review/. See DISPOSITION.md there for
each finding. Historical task/results and old handoff are preserved.

The experimental composer lives in src/macro.ts and src/macro-types.ts. It
supports arbitrary owned-cell footprints, filler paint, rotated unit segments,
mask/material boundaries, entrances, protected corridors and per-radius route
constraints. Existing core region flood fill and swept-disc navigation are
shared. The GUI/CLI/MCP still use the legacy tile-edge-first generator.

Review follow-up implemented: normalized aperture ticks (1e-9 cell precision),
explicit falsy-list rejection, constant-work incident-cell containment and
removal of redundant containment passes. Output additionally retains seed,
resolved segmentOpen and copied world-space constraint definitions for later
revalidation. Full details are in docs/MACRO_STRUCTURES.md.

Shared revalidation has now landed and been reviewed: checkMacroRoutes clears
navigation caches and rechecks all retained corridors/constraints against current
walls. composeMacro uses the same helper. Completed Claude task/results are in
docs/archive/2026-09-12-macro-revalidation/ with a disposition record.

Corey's current priority is structural expressiveness and geometry/traversal
correctness. Do not spend work on runtime thresholds, path-length targets or
difficulty/balance tuning yet. The previous 2-second test gate has been removed;
the large-field test now asserts composition correctness only.

## Verification

Codex independently ran npm test after removing the timing assertion: typecheck
and all 76 unit/tooling tests passed.

Historical prior checkpoint: browser checks passed and a 200-seed legacy
macro-redesign batch passed. Neither was repeated for this experimental API-only
change. They do not measure randomized macro placement, which is not built yet.

## Active delegation

None currently running or ready. Claude's completed revalidation work has been
ingested and its file ownership released. Corey manually launches Claude tasks;
Codex communicates through briefs/results rather than starting Claude processes.

## Zones, cell classes and vocabulary, 2026-09-12

docs/VOCABULARY.md is new and is authoritative for naming: the layering rule
(the system declares over a lattice and resolves physical primitives later from
a tile's primitive set), cell class, region, tier zone, builder, tile, and the
coordinate units.

Two schema changes landed together. Tier zones are objects: a 5 x 5 grid masked
to a diamond by Manhattan distance, each zone `zoneWidth` x `zoneHeight` tiles
(12 x 6 by default, tunable), with the map being exactly the tiles its zones
cover, so `columns`/`rows` are derived and the boundary stair-steps. And
occupancy moved onto the class axis: `solid` is a reserved cell class, material
aggregates into regions like any other class so the partition covers every
laid-out cell, no builder is registered for material, and the artifact dropped
its solid, tier and bonus columns as derivable. The default map is now 936 tiles
across 13 zones.

The GUI paints cells with a class brush, takes zone dimensions instead of
columns/rows, and draws zone boundaries under the tier and bonus overlays.

Still open and unchanged: loot density is keyed by cell class in `regionRules`
rather than allocated from a zone (NEXT_TASKS 13), cell class has no deferring
value or seam term (11), `PlacedTile` carries both tile and cell coordinates
(12), builders cannot state primitives (10), and tiles have no primitive set
(14).

## Next lead work

Revalidation is complete. Next, plan structure placement and the versioned
library/artifact migration across GUI/CLI/MCP. Recommended lead: GPT-6 Astra;
use Terra for bounded implementation slices after contracts are specified.
Rename template regionClass to defaultCellClass and remove/rename deadEnds in
that version migration. Do not let authoritative tile edges reappear, turn a
sampled disconnection into continuous proof, or use manifests as evidence of
unperformed checks. Keep cache invalidation and actual micro-manifest validation.
Do not switch the active generator before artifact round trips and interface
parity are verified.

## Workspace and boundaries

No Git repository at workspace root. Current edited/new implementation paths:
src/macro.ts, src/macro-types.ts, tests/macro.test.ts; docs/MACRO_STRUCTURES.md,
docs/NEXT_TASKS.md, this handoff, the new Claude brief and archive records.
Earlier work across src/tools/tests/public/content remains user-owned. Inspect
current files; do not assume a clean worktree. ../astra_test is read-only context.
Flat 2D only. Pending defaults/questions live in docs/QUESTIONS.md.
