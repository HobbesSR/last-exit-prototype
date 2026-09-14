# Next tasks

## Current checkpoint

Editor cleanup: see [archive/editor-cleanup/EDITOR_CLEANUP.md](archive/editor-cleanup/EDITOR_CLEANUP.md) for the actual library
path and design/proposal separation. Only explicit `adapter: true` designs are
fallbacks; uniform patches are ordinary content. The original prose now stands
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
4. Give micro generation a clearance budget so it can place blockers by default. Containment in a region is not sufficient: a region with an open boundary reaches through it, as the vault experiment in DESIGN_DECISIONS shows. Reserved corridors, or an envelope around proven routes, has to reach the region input before `clutterChance` is anything but a test fixture.
5. Give segments separate movement, sight and projectile channels. The six segment sockets, seven vertices, explicit-empty versus wildcard semantics and flat-height metadata are in; a segment's barrier is still one span shared by every channel, so a fence you can see over cannot yet be expressed.
6. Raise the tile interior budget as part of the structure work. The current one-cell margin prevents geometry from naturally continuing through a seam and should not become a permanent invariant.
7. Measure squeeze value, per-exit routes, bottlenecks and rewarded geometric dead ends. Expose histograms in the GUI and sweep seeds in batches before enforcing tuning thresholds. Avoid implying that opening count or tile degree proves navigation diversity.
8. Add a visual tile-set/layout editor above the existing JSON contract. Tile sets and multi-tile layouts are still JSON-only. Preserve CLI parity and validate imported files before authoring operations. The one-cell interior restriction belongs to the legacy solver and should leave with it; perimeter segment editing does not require that migration. (Note: tile weight has been removed; selection frequency will be treated uniformly until macro tuning is addressed).
9. Separate playtest tuning from map parameters; record time, chosen route, tags, deaths, charge duration and player body for repeatable comparisons. The browser simulation is intentionally separate from the production match rules.
10. Give builders the primitive vocabulary, then extend the region contract: hierarchical sub-regions and shared local geometry utilities. A region builder returns spawns and sub-cell off-lattice props, so it cannot state a segment — no wall along one, no door or window, no interior. Let a builder state cells, segments and vertices inside its own area, under a contract that protects routes it must not sever; `MacroCorridor` and `checkMacroRoutes` already provide that machinery on the macro branch. This is what makes item 4's clearance budget load-bearing. Keep validating actual output rather than generator self-reports.
11. Add the tile- and zone-aware builders that have no region to attach to: primitive-set resolution, hazard placement and map-boundary treatment. Loot already reaches micro generation from the zone and hazard has the same shape. `RegionInput.budget` is a plain cap rather than a zone allocation, which starts to matter once a hard per-match cap on high-tier spawns is wanted.
12. Give tiles a primitive set: the metadata naming what ground, walls, fences and doors are made of in that area, and the pass that resolves declarations into physical objects against it. Nothing the generator emits today is a physical object, and nothing yet says what any declaration should become.

Reachability is now enforced by selection and checked by validation: every tile
must be walkable by both bodies, the contestant must have a route from its spawn
to every exit, and the hunter from the hunter spawn to every exit. A library that
cannot satisfy that produces an explicitly invalid map rather than a repaired one.

## Await answers or playtest evidence

Exit location/capacity semantics, body-scale conversion, alternate diamond masks/staggering, topology overrides, required set-piece class selection, final transit rules, and target difficulty metrics are in QUESTIONS.md. The defaults allow current work to continue.

## Explicitly later

2.5D, generic overlapping floors, one-way traversal, production combat/visibility, multiplayer, server import/export adapters, and game integration. These must not displace getting a useful flat 2D playtest first.

## Verification

`npm test`; `node tests/browser.mts`; `npm run typecheck`; `node tools/cli.mts batch --seed regression --count 200 --out test-results/batch.json`. Browser checks require local Chrome and Playwright (can reuse sibling test dependency). See README for launch and MCP usage. Delegate bounded tests/authoring extensions to GPT-5.6 Terra; retain socket contracts, topology negotiation and integration decisions with the lead.
