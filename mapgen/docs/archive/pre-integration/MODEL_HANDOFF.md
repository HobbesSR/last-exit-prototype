# Implementation checkpoint: a second generator that plans before it builds

Read AGENTS.md and design_notes.txt first, then
[PLANNED_GENERATION.md](PLANNED_GENERATION.md). The previous
checkpoint follows below and is still accurate about the legacy path.

## There are now two generators

`core.generateMap` is unchanged. `plan/compose.generatePlannedMap` is new:

```
plan:     partition into regions -> state a perimeter contract on every boundary
          -> prove reachability on the region graph, from the floors alone
compose:  lay the contract down -> one builder per region
          -> hold each builder to the contract it was given
```

A `PerimeterPort` carries a floor (`required`) and a ceiling (`allowed`). Macro
proves routes from the floors; `micro/conform.ts` holds builders to them. That
pairing is the whole design, and it is why the planned path needs **no reserved
route network and no repair pass** -- `planStreets` exists only to defend
connectivity after the fact, and is now marked superseded and do-not-extend.

New: `src/plan/{types,partition,ports,loot,compose}.ts`, `src/micro/conform.ts`,
`src/micro/loot.ts`, four test files, `cli plan` and `cli plan-only`.

## Measured, 20 seeds at default size, all valid

Against the legacy path's 150-seed sweep: ~30x the stated geometry (6,067 median
segments against 196), detour ratio 1.75 against 1.05, 79 contestant-only seams
against 1, and no ground held back from builders. The full table and its caveats
are in PLANNED_GENERATION.md. Nothing is tuned.

## Three mistakes worth not repeating

**A port is shared; each side's builder runs separately.** The later write wins,
so a port conformant at both checks can still finish below its floor. Fourteen of
166 did. `enforcePorts` gives the plan the last word, over out-of-band ports only.

**An anchor must be standing room a body can reach**, not merely standing room.
Builders legitimately seal pockets and anchors landed inside them. Anchors are
now drawn from the largest connected component, at hunter clearance.

**An empty path is not a distance of zero.** Zero is what an adjacent tile looks
like; the two are opposites. This is the "fixed count standing in for a
condition" shape that has bitten this project before.

## Still open

`detourRatio`/`contestantDistance`/`deadEnds` come from the anchor-to-anchor tile
graph and understate: on two of eight sampled seeds they report no contestant
route while `validateMap`'s lattice flood passes. That is NEXT_TASKS item 2.
The planned path is not the default and the GUI/MCP still use `generateMap`.
Region types, port chances, loot policy and `tilesPerRegion` are all untuned.

---

# Implementation checkpoint: micro generation

Read AGENTS.md and design_notes.txt first. Implementation documents describe
behavior and reversible defaults. The previous checkpoint follows below.

## What landed

A catalogue of region builders, the contract they build against, and the route
network that lets them obstruct the map without disconnecting it. This is
NEXT_TASKS items 4 and 10; both entries are updated. The design is written up in
[MICRO_GENERATION.md](MICRO_GENERATION.md) -- read that before touching
`src/micro/` or `planStreets`.

New: `src/micro/` -- `types.ts` (the contract), `scale.ts` (body scale, stated
once), `catalogue.ts` (the registry), `mask.ts` (region shape), `rng.ts`
(named independent streams), `edit.ts` (the canvas, and the containment
contract), `clearance.ts` (the guard), `placement.ts` (where detail may sit),
`builders/` (six), `index.ts` (registration). Changed: `src/core.ts`,
`src/regions.ts`, `src/types.ts`, `content/default-library.json`,
`tools/cli.mts`, `tests/core.test.ts`. New tests: `micro-mask`, `micro-edit`,
`micro-builders`, `micro-pipeline`.

## The three things that were not obvious

**A builder cannot be trusted with connectivity, and it is not its fault.** A
region may be most of the open field; its builder is then deciding whole-map
connectivity while looking at an area whose boundary tells it nothing. The
per-region clearance guard is correct and structurally insufficient. The route
network has to be decided before any builder runs and handed down.

**A street must be a proven route.** The first version reserved straight
anchor-to-seam lines. On a tile whose authored interior blocks the direct line
the real route detours, the detour stayed buildable, and seven tiles were
sealed. Legs are now paths on the same swept-disc lattice route validation uses.

**Streets join blocks, not tiles.** The second version routed to every tile,
which is a route through every tile, and a 6 x 6 tile has no room for both a
street and a building. Blocks averaged thirty cells -- below the minimum area of
every builder that makes buildings -- so `compound` and `pillar-hall` silently
produced nothing and the map was scatter and rubble again, with every test
passing. That was caught by counting per-generator output, not by the suite.
Count what each builder actually produced before believing a green run.

## Regions are discovered twice

Builders repaint cells and state walls, so the partition they were handed stops
describing the result. `generateMap` searches again afterwards; the artifact
carries the second partition, which agrees with its cells by construction, as
`validateMap` has always required. Manifests are recomputed from what landed.

## One test was changed, deliberately

`tiles carry interior geometry` asserted no solid cell sits on a tile's border
row or column. That margin is a property of authored tile interiors -- the
legacy solver needed the room, and NEXT_TASKS items 6 and 8 both say it should
leave with that solver. It was never a property of the map, and regions are not
tile shaped. The assertion is now scoped to material no builder produced; each
solid region records its builder, so the two cases are told apart from the
artifact.

## Measured, and the honest reading

150 seeds, all valid before and after. Median per map: 1,110 blocks built, 196
segments stated, 225 props, 1 contestant-only squeeze, 0 stranded anchors. The
full table is in MICRO_GENERATION.md.

The machinery works and the repair pass is nearly idle, which is what it should
look like. The density is low: ~200 segments and ~225 props over 33,696 cells is
sparse for a map whose point is obstruction, and `microCells` near zero means
`pillar-hall` rarely finds a legal block. That is tuning, not design -- streets
and anchor standing room take ground first, `keepClear` takes a ring more, and
the builders' gates are conservative on top. `STREET_SPACING`, the anchor berth
and the per-builder `generatorParams` are the dials and none has been tuned
against evidence; they were set to whatever first stopped the map breaking.
Item 7's histograms are the right next step, not another guess.

## Count what a builder produced, not what the suite says

Twice in this work a builder produced literally nothing while every test passed
and the aggregate wall count sat inside its own baseline noise. Both times the
builder reported **zero refusals**, because a site that is never proposed is
never refused. `microBlocks`, `microCells` and `microSegments` are in
`map.metrics` for exactly this reason. Check them before believing a green run.

## Not done

`courtyard` is exercised by tests but never by the shipped library: the only
`vault` areas in it are 2 x 2 blocks, far below its minimum area. Giving it
scope is a content task -- a tile design with a large walled area -- not a code
one. `apertureRun` still wants to be on the canvas; until it is,
`courtyard.ts` imports `runAperture` from `compound.ts`, the one
builder-to-builder dependency. `RegionContext.corridors` is populated but the
network behind it is still tile-grained, as item 2 describes.

---

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
