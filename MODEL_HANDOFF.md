# Implementation checkpoint after editor cleanup

Read AGENTS.md and design_notes.txt first. Implementation documents describe
behavior and reversible defaults; the retired assistant proposal is historical.
See docs/archive/editor-cleanup/EDITOR_CLEANUP.md for the design audit and library-to-generator trace.

## Completed

- Original user prose preserved in design_notes.txt; appended assistant proposal
  archived under docs/archive/retired-design-proposal/.
- Fallback selection now requires explicit adapter: true. Uniform tiles and
  equivalent omitted/all-any ports no longer change selection priority.
- Browser authoring uses the active shared library, exposes fallback status and
  usage, supports perimeter edge contracts, and fixes hidden cell overrides and
  draft resets. See README for current controls.
- Stale vocabulary, material-region claims and old validation figures corrected
  or archived. Old handoff and validation: docs/archive/pre-editor-cleanup/.
- Loot already comes from tier zones per candidate; defaultCellClass and
  TileDesign renames are already implemented. Do not repeat those migrations.
- Tile editing is now one drawing surface. The pointer is resolved geometrically
  against the grid, not by DOM hit area, with a half-cell catch radius when only
  segments are live; segments take a brush on contact; a gallery of previews
  selects the tile; rectangle drags, row/column/line strips, whole-tile patterns
  and a right-click palette at the cursor are in. See README for the controls.
- The tile-edge maze is removed. No spanning tree, no loop or squeeze budget,
  no forced `closed` seam: a seam carries what the two designs beside it declare,
  and `loopChance`/`squeezeChance` are gone from MapParams, the GUI and the CLI.
  `edges` is measured off the laid-out segments (widest continuous opening) and
  dropped from the wire form, like walls. Reachability is enforced by selection
  in a west-to-east growth order and checked by validation. With the shipped
  library the result is close to an open field: route/direct 1.05 over 200 seeds.
  Friction must now come from the macro-structure pass or from authored tiles.
  Do not reintroduce a generator-side maze to compensate.
- `any` claims nothing. A deferring perimeter segment is the absence of a
  declaration, so the design beside it may state a wall and the seam carries it.
  Do not restore claiming a deferred seam's settled span: it makes silence a
  demand and no wall can ever meet a deferring neighbour.
- Reachability is validated by flooding the proven lattice per body over the
  whole map, not by walking the tile graph. The graph is anchor-to-anchor across
  one seam and cannot see a body walking around through a third tile; it stays
  as a conservative cached view behind `findPath` for route metrics only.
- `TileDesign.weight` is optional (omission means 1) and gone from the editor:
  selection frequency belongs to Tile Sets and Set Pieces per Corey. The shipped
  library keeps its tuned values, so legacy filler behavior is unchanged.
  Tile selection frequency is treated uniformly pending future schema tuning.

## Pending: generation from composed tile/layout declarations

Recommended lead: GPT-6 Astra for the library/artifact and geometry contract.
Delegate bounded implementation and tests to GPT-5.6 Terra once specified.

The GUI/CLI/MCP all call the legacy generateMap in src/core.ts. It chooses
coarse maze seams before tile selection; authored per-segment requirements only
filter those seams. The newer composeMacro API in src/macro.ts and
src/macro-types.ts is experimental and has no randomized placement or library
compiler. Do not describe it as live generation.

Next action: specify how existing 6x6 TileDesign entries, tile sets and layouts
compile into composed declarations, including deference and shared edges. The
experimental structure format must not replace the original tile vocabulary by
accident. Then implement bounded placement, derive traversal from actual composed
geometry, and migrate artifacts and all three interfaces together. Broad open
fields and cross-tile architecture must not acquire maze walls at tile borders.

Keep flat 2D, navigation cache invalidation, actual region-manifest validation,
per-radius swept-disc checks and artifact round trips. A sampled disconnection
is not proof of continuous disconnection. The legacy one-cell interior margin is
an algorithm limitation; remove it with composition, not by disabling checks.
Questions/defaults live in docs/QUESTIONS.md. Do not invent balance gates or use
unadopted proposal details as requirements. Escalate ambiguous schema semantics;
fail explicitly when bounded placement cannot satisfy required content.

## Workspace and acceptance

A Git repository is present. Inspect current files and preserve user changes.
This cleanup touched public/{app.ts,index.html,style.css}, src/{core.ts,types.ts},
tests/{core.test.ts,browser.mts}, content/default-library.json, README.md,
AGENTS.md, design_notes.txt and docs.
No worker owns files after this checkpoint. ../astra_test remains read-only.

Run npm test, node tests/browser.mts for meaningful UI changes, and a bounded
CLI seed batch for generator changes. Report sample size and actual results;
current evidence is in docs/VALIDATION.md. Do not switch the active generator
until artifact round trips and GUI/CLI/MCP parity are verified.
