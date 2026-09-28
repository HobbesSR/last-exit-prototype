# Next tasks

## Current checkpoint

There are now two generators. `core.generateMap` is the legacy path and is
unchanged. `plan/compose.generatePlannedMap` is a second, coherent path in which
macro partitions the map into regions, states a passage floor and ceiling on
every region boundary, and proves reachability on the region graph; micro is
held to those floors by `micro/conform.ts`. It needs no reserved route network
and no repair pass, and `planStreets` is superseded by it -- kept only because
the legacy path still calls it, and marked do-not-extend. Read
[PLANNED_GENERATION.md](PLANNED_GENERATION.md) before touching either.

Measured over 20 seeds at default size, all valid: about thirty times the stated
geometry of the legacy path, a detour ratio of 1.75 against 1.05, and 79
contestant-only seams against 1. Nothing in it is tuned.

Editor cleanup: see [archive/editor-cleanup/EDITOR_CLEANUP.md](archive/editor-cleanup/EDITOR_CLEANUP.md) for the actual library
path and design/proposal separation. Uniform patches are ordinary content; the
`adapter` fallback flag was removed with the legacy generator (#38). The original prose now stands
alone in `design_notes.txt`. Historical milestones below describe implementation
progress, not additional requirements overriding that prose.

Independent seed-driven generation, circular-body collision, authoring workbench, escape/combat sandbox, JSON CLI and stdio MCP are implemented. Flat 2D is the only realized geometry. `astra_test` was inspected read-only. No engine integration is required to continue.

Since the last checkpoint: tile templates author per-cell region classes and
interior barriers; region search moved to the cell level and runs after tile
placement, with micro generation per region; navigation is a proven half-cell
lattice with per-tile anchors; ports accept sets of seam contracts; templates can
declare eligible tier/bonus zones; the sources are TypeScript with no build step.
Generic adapter coverage fell from 92% to 0% on the default library.

Loot then moved onto the zone axis, cell classes became a declared registry in
the library, `TileTemplate` became `TileDesign` (a member of the tile corpus,
not a pattern for making one), and `ports` became optional - a topology hint
layered over a design rather than part of it. The authoring tab names tiles,
picks a default class from the declared list, and adds or removes classes.

Tier zones then became objects. The zone grid is 5 x 5 masked to a diamond, each
zone `zoneWidth` x `zoneHeight` tiles (12 x 6 by default), and the map is exactly
the tiles its zones cover, so `columns`/`rows` are derived and the boundary
stair-steps. Occupancy moved onto the class axis: `solid` is a reserved cell
class rather than a parallel boolean grid, material aggregates into regions like
any other class, and the artifact dropped the solid, tier and bonus columns as
derivable. The authoring tab paints cells with a class brush.

Then the primitive model landed: every tile's 36 cells, 84 segments and 49
vertices are addressable, with only stated metadata stored; perimeter segments
and vertices are the adjacency contract, with `any` deferring to and adopting
neighbouring requirements; and the artifact drops everything derivable before coding what is left as
an interned palette plus run-length codes. The micro contract now admits
collidable, off-lattice geometry, validated for containment. Serialization then
moved to a wire form that interns every enumerated value into a shared string
table, packs bulk fields into narrow integer columns and drops everything
derivable, with a dependency-free BSON codec beside the JSON one: a default map
addressing 260,281 primitives is 280 KB as BSON against 1,050 KB for the
in-memory shape.

Micro generation then landed: a catalogue of six region builders, a builder
contract that can state geometry, the street network that keeps the map
connected while builders are free to obstruct it, and blocks as the unit a
builder is handed. Over 150 seeds, all valid before and after, the map went
from no collidable detail and no contestant-only squeeze at all to a median of
225 props and 1 squeeze. That is a working system at a low density: see the
measured table and the honest reading of it in
[MICRO_GENERATION.md](MICRO_GENERATION.md). Tuning it is item 7's job.

## Ready work, without design answers

The contract-first slice of item 1 is implemented in `src/macro-types.ts` and
`src/macro.ts`, with four representative geometry fixtures plus composition
rejection tests. See `MACRO_STRUCTURES.md`. The next ready slice is to connect a
bounded structure placement pass to generation and perform the versioned
library/artifact migration; the GUI/CLI/MCP still use the old generator.
Independent review is archived in `archive/2026-09-12-macro-review/` with a
disposition record. Decimal-span normalization, list diagnostics and containment
cost are fixed; seed, resolved spans and route definitions are retained. The
post-edit route/corridor revalidation is now implemented as `checkMacroRoutes`.
That completed task is archived in `archive/2026-09-12-macro-revalidation/`.
Next is structure placement and schema/interface migration. Prioritize structural
expressiveness and geometry correctness; defer timing gates, path-length targets
and difficulty/balance tuning per Corey's direction.

1. Give the map macro structure. The tile-edge-first maze is **gone**: nothing plans seams, an unstated tile boundary contributes no wall, and open field crosses seams with no special adapter. What remains is that nothing has replaced it, so a generated map is close to an open field — over 200 seeds the route to an exit is 1.05× the direct distance and the shipped library contributes no seam barrier but `market-arcade`. The macro-structure pass is now the only source of friction: structures need footprints spanning arbitrary tile sets and must be able to paint region intent and geometry across internal seams. Cul-de-sacs and buildings are properties of the composed result, not single-tile template classes. Until it lands, friction has to be authored into the library.
2. Derive movement connectivity after composing macro geometry, for each body clearance. Validation now floods the proven lattice per body rather than walking the tile graph, so reachability is a geometric fact; what is left is that route _metrics_ still come from the anchor-to-anchor tile graph, which is conservative and tile-grained. Tile traversability is no longer authored or serialized: `edges` is measured off the laid-out segments after placement and dropped from the wire form entirely, and the nav graph is a cached view of that. What is left is the tile-grain of it — an edge is still per tile pair rather than per corridor. Replace the `deadEnds` metric with geometry-level corridor/space analysis; until then it is explicitly a tile-graph leaf count.
3. Recast tile designs as local patches used by larger structures and filler. Preserve the valid case where all cells in a tile share one class and join a cross-tile region.
4. **Done, with one part left.** Micro generation has a clearance budget and
   places blockers by default. `planStreets` in `src/core.ts` decides a route
   network out of the composed geometry before any builder runs -- proven
   lattice paths, not straight lines -- reserves what it covers, and passes its
   legs to each builder as `RegionContext.corridors`; `guardRegionEdit` checks
   them after the fact and `clearStreets` drops props that reach into one.
   Every tile anchor is joined to that network by its own proven hunter route,
   which is what makes "both bodies reach every tile" true by construction
   rather than by luck. See MICRO_GENERATION.md for why the first two versions
   of it were wrong. What is left: the network is derived from tile adjacency
   and anchors, so it is still tile-grained in the same way item 2 describes,
   and `STREET_SPACING` is an untuned dial rather than a measured one.
5. **Done.** Added separate movement, sight and projectile channels to segments via `SegmentChannels` and `channelSpan`.
6. **Done.** Raised the tile interior budget by removing `INTERIOR_MARGIN`, allowing geometry to naturally continue through a seam.
7. **Done.** Added a Batch Sweep tool in the World recipe tab that runs 100 seeds and exposes tuning metric histograms (Squeezes, Dead Ends, Detour Ratio, Distance). Avoided implying that opening count or tile degree proves navigation diversity.
8. **Done.** Added a visual tile-set/layout editor above the existing JSON contract in the browser GUI. Preserved CLI parity and validate imported files before authoring operations.
9. **Cancelled:** Playtesting UI has been removed entirely from this repository, as the actual game logic lives in the game at the repository root and the mockup was taking on a life of its own.
10. **Done, except sub-regions:** Builders have the primitive vocabulary:
    `RegionEdit` in `src/micro/types.ts` supersedes `RegionOutput`, so a builder
    states cells, segments and vertices inside its own area as well as spawns
    and props, and six of them do. Which builder owns a region is library data
    (`cellClasses[x].generator`), resolved by the catalogue in
    `src/micro/catalogue.ts`. The shared local geometry utilities are
    `src/micro/mask.ts` (shape), `src/micro/edit.ts` (every declaration, and the
    containment contract), `src/micro/placement.ts` (where detail may sit),
    `src/micro/rng.ts` and `src/micro/scale.ts`. Manifests are recomputed from
    what actually landed, never from what a builder reported. What is left:
    hierarchical sub-regions.
11. Add the tile- and zone-aware builders that have no region to attach to: primitive-set resolution, hazard placement and map-boundary treatment. Loot already reaches micro generation from the zone and hazard has the same shape. `RegionInput.budget` is a plain cap rather than a zone allocation, which starts to matter once a hard per-match cap on high-tier spawns is wanted.
12. Give tiles a primitive set: the metadata naming what ground, walls, fences and doors are made of in that area, and the pass that resolves declarations into physical objects against it. Nothing the generator emits today is a physical object, and nothing yet says what any declaration should become.

Reachability is now enforced by selection and checked by validation: every tile
must be walkable by both bodies, the contestant must have a route from its spawn
to every exit, and the hunter from the hunter spawn to every exit. A library that
cannot satisfy that produces an explicitly invalid map rather than a repaired one.

## Await answers or playtest evidence

Exit location/capacity semantics, body-scale conversion, alternate diamond masks/staggering, topology overrides, required set-piece class selection, final transit rules, and target difficulty metrics are in QUESTIONS.md. The defaults allow current work to continue.

The generation chain (#65, DESIGN_DECISIONS "The generation chain") follows the map-layer stages (#52): pin that one seed decides the whole map (#66), make the region inputs their own stage (#67), refuse layouts whose perimeter runs prescribed passable are narrower than a hunter (#73), then make region builders independent, with boundary passability prescribed in tile designs, a prescription being a guarantee (#68, approved 2026-09-27; see QUESTIONS.md "Region boundary openings"). Stage objects become separately saveable, each with its provenance (#70).

The tile reachability contract that replaces anchors (#59, DESIGN_DECISIONS "Reachability") follows the map-layer stages (#52). Its first stage is confirming the working assumptions in QUESTIONS.md "Reachability contract".

## Explicitly later

2.5D, generic overlapping floors, one-way traversal, production combat/visibility, multiplayer, server import/export adapters, and game integration. These must not displace getting a useful flat 2D playtest first.

## Verification

`npm test`; `node tests/browser.mts`; `npm run typecheck`; `node tools/cli.mts batch --seed regression --count 200 --out test-results/batch.json`. Browser checks require local Chrome and Playwright, resolved from the repository root. See README for launch and MCP usage. Delegate bounded tests/authoring extensions to the implementation worker the root [docs/32-delegation.md](../../docs/32-delegation.md) names; retain socket contracts, topology negotiation and integration decisions with the lead.
