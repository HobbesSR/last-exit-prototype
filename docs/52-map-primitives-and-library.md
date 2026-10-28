# 52. Map primitives and the library

Status: accepted model, 2026-09-29. The new library schema and validator are
implemented in `map/macro/src/chain/library.ts` (#83), and the chain's
minimal library is authored (#97). The old library and its schema were
deleted with mapgen's old paths (#146).

This file defines what a map is made of and what the library an author writes
contains. The generation chain that consumes it is specified in [51](51-generation-chain.md)
and defined in [51.1](51.1-principles-and-names.md). Original intent is in
`map/macro/design_notes.txt`, the original statement of intent. Corey's later answers in 17 and the accepted model in 51 govern where they differ.

## The layering rule

Map generation emits **declarations over a lattice**, never physical game
objects:
- A cell classed `hut` declares that the `hut` region type owns that cell.
- A passability prescription states a crossing promise or optional architectural
  guidance on a segment.

Physical objects are made by region strategies (51 stage 6). Appearance will
be carried by a **primitive set**: tile metadata naming what ground, walls,
fences and doors are made of in that part of the map, so the same declaration
can become a chain-link fence in a yard and a stone wall in a plaza. It is
never carried by cell class. Primitive sets are deferred (16).

The art direction ([11.1](11.1-world-and-art-direction.md) §4) proposes that
appearance carry five independent dimensions rather than one generic damage
style (#584, not designed yet). They are what primitive sets would grow into:
- **District identity:** the neighborhood archetype and its palette.
- **Architectural identity:** a building's original function and era, which
  choose its components, materials, colors and signage ([56](56-buildings.md)).
- **Decay:** long-term neglect, which transforms original colors rather than
  erasing them.
- **Competition damage:** the type, amount and age of damage from earlier
  bouts, uneven across the map.
- **Lighting identity:** a region's or block's color treatment, chosen apart
  from its materials ([29.4](29.4-drawing.md)).

Like cell class, none of these may change passability. Decoration never alters
collision, sight or navigation ([56.2](56.2-ground-decals.md)). Destruction
that does is emitted as elements by the region strategy
([20.3.1](20.3.1-canvas-adoption.md), [29.3](29.3-shape-construction-and-assembly.md))
and keeps the region's portal promise ([51.7](51.7-briefs.md), [54](54-region-types.md)).

## Primitives

| Term | Extent | Carries |
| --- | --- | --- |
| **Cell** | 1 × 1 | a declared class, and later a height |
| **Segment** | one cell edge | a set of prescriptions (below) |
| **Vertex** | one lattice corner | class and height, by exception |

Only stated metadata is stored:
- **Cells** are dense, because each one genuinely differs.
- **Segments and vertices** are held by exception. A segment nobody mentioned is
  unstated, and a vertex nobody constrained defers.
- **Interior vertices** aren't stored at all. On a flat map they carry nothing
  cells and segments don't, so authoring one is reported as a mistake.
- **Heights** arrive later as stated exceptions on the same footing (2½D, 16).

Everything else is an aggregate built from these three.

## Segment prescriptions

A segment carries a set of prescriptions, each on its own dimension and each
with a don't-care value. This is Corey's model (verbatim in 17, 2026-09-27).

| Dimension | Says | Values in the chain |
| --- | --- | --- |
| **Adjacency**, one per side | which class the cell on that side must be | a class, or `any` |
| **Passability** | a crossing promise or architectural guidance | `passable`, `any`, `not-passable-hint`, or unstated (below) |
| **Geometry** | what stands on the segment, per channel (movement, sight, projectiles) | none: macro prescribes no geometry for now (16) |

- **Adjacency** is stated on a tile's perimeter segments. Inside a tile both
  cells are known, so it would say nothing new.
- **Passability** may be stated on any segment. Corey, 2026-09-27: "It's the
  tile designer's job to mark internal as passable". Read in context, that's
  about segments inside a tile that lie between two regions. A passable
  prescription with the same region on both sides forms no external portal,
  but retains its clear-margin obligation as an internal guaranteed run
  ([20.6](20.6-passable-margins.md), [51.7](51.7-briefs.md)).
  - A `passable` prescription becomes a **guarantee** once placement is solved
    (51 stage 2), except on a segment facing the map's outside. The
    guaranteed stretches of each boundary are **portals**. Portals are
    derived, not authored, but an author designs passable sections with the
    portals they will form in mind (51 stage 3).
  - Unstated is kept distinct from a written `any`, so later steps can tell
    them apart (17, "Map generation": segment prescriptions).
  - Unstated implies no guarantee: "just because something isn't marked passable
    doesn't mean it won't be passable. It just means we can prove its
    passable."
- **No impassable requirement.** Without macro geometry, nothing could
  honour one, and builders aren't asked to (17).
- **A not-passable hint (`not-passable-hint`, mechanism #286).** A
  perimeter segment may carry a hint that the designer wants that stretch
  occupied. It is guidance, not a requirement: builders keep the portal promise
  as their only obligation, and nothing refuses a builder that ignores it. As a
  rule of thumb most regions should take it, as art direction would ask. Its
  resolution:
  - `any` meeting `any` on a shared segment is passable (Corey, 2026-10-08).
  - `any` meeting a hint takes the hint. `passable` on either side is still a
    guarantee; a hint never guarantees anything.
  - Unstated stays distinct from `any`. Passability checks, including the
    open-face rule, run after segment properties are derived (51 stage 1).
  - The full symmetric table and version decisions are in [51.4](51.4-resolution.md).
    `passable` wins over hints; hint with unstated remains a hint without a
    guarantee. The Map Lab authors the value without requiring any geometry.
  - The brief carries the hinted runs and the SDK offers helpers for them (#287;
    20.1, 20.3, 51.7). Builders adopt them one at a time.
  - A hint both sides state counts for more than one facing `any` or unstated:
    the brief carries both stated values, and builders may prefer mutual hints
    (Corey, #406; 20.1). It is still not a requirement.
- **When geometry returns:** a label will imply values on several dimensions.
  - `wall` implies not passable.
  - A fence blocks movement but is passable, because hunters can break fences
    (17).

## Cell classes are region types

- **Declared once.** Every class is declared once in the library's
  `cellClasses`, and a design may only paint a declared name. The registry is
  the one place a class is introduced.
- **Names a region type.** A class names the strategy in `map/micro/`
  that fills a region of it, and passes that strategy its parameters (51).
  What is intrinsic to the class goes in its entry; what varies with position
  on the map belongs to the tier zone.
- **Core element classes.** A class whose rule lists core elements its strategy sites
  (`contestantCount` spawns, `exitCount` exits, a charger) is a **core element class**. It is
  painted only inside the set pieces of the set piece class that owns those
  core elements (51, "Core elements").
- **`cell → class` is total.** Two values are reserved:
  - `""`: outside the mask, where no tile covers the cell
  - `any`: the deferring class. It states nothing, takes the class a
    neighbouring tile's adjacency prescription requires, and settles as
    `open` otherwise (51 stage 2).

  mapgen's reserved `solid` class belonged to its micro layer and retires with
  it: material is geometry a strategy places.
- **`open` is a privileged region class** (Corey, 2026-09-27, verbatim in 17).
  Every cell of a region formed by `open` cells is passable, and so is every
  segment inside it. Its builder promises that (#61). Whether an open region
  needs a minimum width is 17 M9.

## Regions

A **layout region** is a maximal 4-connected set of cells sharing one resolved
class. Regions are found after placement, never authored, and they aren't tile
shaped. One tile contributes cells to as many regions as it has classes, and
one region may cover a hundred tiles at any offset. Tile boundaries aren't
region boundaries and imply no barrier.

The worked case the model serves:

> Four copies of a tile, each rotated, each painting a 3 × 3 corner block as
> `hut` and nothing else. Placed so the four blocks meet at a tile junction,
> they form one 6 × 6 `hut` region spanning four tiles. Hut generation runs once
> over that 36-cell area and may site a 4 × 4 hut anywhere inside it — walls on
> segments, a two-segment door south, a two-segment window north, a spawn cell
> inside. Its placement is constrained by the region's shape, not by the tile
> grid that produced it.

Under clear margins (20.6) the house stays off the margin cells. Some seeds
still fit 4 × 4; the rest use the compact 4 × 3, 3 × 4 or 3 × 3 design.

A region's boundary emits no geometry. Everything physical inside a region is
its strategy's, and a strategy may decompose its region hierarchically (19).

## Tiles and tile sets

- **Tile design:** a 6 × 6 patch of cells, one of the tiles the assembler may
  place. It is not a pattern for making tiles. In the new schema it holds:
  - a declared class for each cell (a default, a painted grid and a legend)
  - adjacency prescriptions on its perimeter segments
  - passability prescriptions on any segment
  - its allowed orientations, eligible tiers and bonus, and labels
- **Tile set:** a set of tile designs, sometimes just one.

Designs don't carry walls, spans, side sockets (`ports`) or anchors any more;
those belonged to the old schema (see "The old library").

## Set pieces and set piece classes

The hierarchy (Corey, 2026-09-28): "set piece classes are sets of set pieces,
which are layouts of tile sets, which are sets of tiles, sometimes with just
one."

- **Set piece:** a layout of tile sets, as slots at tile offsets, each naming
  a tile set and optionally an orientation. It may name a **primary region
  class**: "a suggested 'default' or primary region class/type" (Corey,
  2026-09-28). It is the class the set piece mainly forms, and generation
  doesn't read it; it's an editor default.
- **Set piece class:** a set of set pieces, with the engine placement rule it
  uses, its quota, and the core elements it owns, each with a count per instance
  (a positive whole number, or a count param: `exitCount`, `contestantCount`
  or `hunterCount`).
  It is the only macro structure the engine treats as first class; code calls
  it `ChainSetPieceClass`, listed in a library's `setPieceClasses`. Where each rule may anchor is the zone plan's (55).
  The shipped 12 × 6 library's classes:

| Set piece class | Rule | Quota | Owns |
| --- | --- | --- | --- |
| `start` | `start` | 1 | `contestantCount` spawns, one per contestant (17 M20) |
| `end` | `end` | 1 | `exitCount` exits and `hunterCount` hunter spawns, one per hunter |
| `enormous` | `enormous` | 3 distinct | nothing |
| `medium` | `medium` | 4 | nothing |
| `small` | `small` | 10 | nothing |
| `charger` | `charger` | 3 | one charger each (#230) |
| `transit` | `transit` | 6 | one warp |

  Set pieces also filter on eligible tiers. Quotas and membership are authored
  per plan and size (55). Playground mode may relax any of this (51).

## Tier zones and the mask

A tier zone is a macro area carrying the progression numbers for everything
inside it: loot tier, hazard, and the bonus or novelty axis. The zone grid, the
mask, each zone's tier and bonus, and zone sizes are the zone plan's (55).
Zones are derived from the params and are never stored.

- **Loot:** `lootChance` rises by tier, and a brief carries it per cell, so a
  region spanning two zones is richer at the end nearer the exit.
- **Bonus and hazard** aren't folded in yet, and how tier and bonus combine is
  17 M16.

## Units and scale

A cell is one abstract segment unit, not a metre. Corey's scale (17,
September 22): "roughly 2 cells is a doorway, a contestant is more than 1 cell
and less than 1.5. A hunter is more than 1.5 and less than 2." So a 1.5-cell gap
admits a contestant and not a hunter.

**This section is the one statement of body scale in the docs**, and other
files link here rather than restating numbers (Corey, 2026-09-29, M5). In
code, the one source is `CELL_SCALE` in `map/kernel/scale.ts`, in the
shared map space (51 C0):

| Quantity | Cells |
| --- | --- |
| contestant radius | 0.625 (diameter 1.25) |
| hunter radius | 0.875 (diameter 1.75) |
| doorway | 2 |
| squeeze | 1.5 |
| clearance margin beyond a body's radius | 0.05 |

The shortest portal, `ceil(2 × hunterRadius)`, is 2 (`MIN_PORTAL_LENGTH`).
The SDK's `cell` profile (`microMetrics`) and mapgen's chain stages read these
from `CELL_SCALE` and `MIN_PORTAL_LENGTH`. They were the SDK's values. mapgen's radii were
0.55 and 0.90 until C0, and Corey chose the SDK's values with a recaptured
sweep baseline (17 M5).

The game's `live` profile (12 and 23 world units, 40 world units per cell) is
the live match's, stays in `shared/map/navigation.ts`, and changes only with
the live game.

## Coordinates

| Quantity | Unit |
| --- | --- |
| `MapParams.zoneWidth`, `zoneHeight` | tiles per zone |
| `MapParams.columns`, `rows` | tiles |
| `MapParams.tileSize` | cells per tile edge (6) |
| map `width` and `height` | cells |
| mapgen grid indices | flat cell index, `y × width + x` |
| the contract's `Cell` | global integer cell coordinates `{x, y}`, plus a `cellSize` in world units |

The brief translation (51 stage 5) converts between the last two.

A cell is a whole number of world units: `cellSize` is a positive integer
(Corey, 2026-10-04). Builders measure in cells and multiply once, and with an
integer ratio that agrees exactly with measuring in world units, so no builder
needs a second arithmetic. `isCellSize` in `map/kernel/scale.ts` is the rule;
`generate`, macro's briefs stage (and so a loaded map) and the micro SDK's
region check refuse anything else.

## Library modules and authored sizes

Schema version 3 libraries declare `name`, `zonePlan`, `zoneWidth` and
`zoneHeight`. Game mode requires its zone dimensions to match that library;
playground dimensions remain free. Version 2 is refused by name.

A library may include named, versioned modules through
`includes: [{ name: "common-primitives", version: 1 }]`. Modules carry cell
classes, tiles, tile sets and set pieces, and may include other modules.
The top library owns set piece classes and quotas. Modules cannot supply them.
Module files carry `schema: 1` for the file format and a separate positive integer
`version` for authored content, starting at 1. Revise `version` when definitions
or include pins change; a format change bumps `schema`. Includes pin exact content
versions, with no fallback to a different revision. Top and resolved libraries
retain their existing `version: 3` schema field; their resolved content is
identified by the fingerprint.

`resolveLibrary` takes a registry keyed by `name@version`. It visits includes in
listed depth-first order and loads a repeated module identity once. Different revisions may coexist in the registry or include graph, but the same
id still cannot be defined twice. Missing
modules, include cycles and mismatched names or versions are errors. Redefining
an id in the same category is an error naming both sources, including when the
top library tries to override a module. Competing definitions belong in separate
modules, as requested in [17.2.7](17.2.7-zone-plans.md).

The bundled libraries are `CHAIN_LIBRARIES` in `map/chain.ts`, one per
authored size. Without a library of its own, a map takes the one authored for
its zone size (`bundledLibrary`). Game mode refuses a size none is authored
for, naming the authored sizes; playground mode takes the default library
there.

Resolution produces an independent flattened library with no includes. Its full
content, including authored metadata, determines the fingerprint. Saved maps
embed that resolved library ([53](53-map-artifacts-and-tools.md)). Node's CLI
loads named module JSON files beside the top library; browser bundles supply the
same registry through JSON imports. The Lab editor imports and exports resolved
libraries.

## The chain's library

`map/macro/content/diamond-12x6.json` is the library the chain is authored
with (B4, #97; modularized in #168; set pieces on the old footprints in S5,
#170). It includes `common-primitives@4.json` and `common-set-pieces@4.json`,
which also includes the primitives. The top library owns the classes and
quotas for the diamond at its declared size. It paints every type in 54's
catalogue, and it grows from here. The fixture libraries in
`map/macro/tests/fixtures/` stay with the stage tests.

- **Classes:** one per catalogue type, each bound to the region type of the
  same name. The registry can bind a drafted type to a stand-in under that
  name, but no current type needs one: `market` has its own builder (54.3).
- **Tiles:**
  - `field`: plain open ground, a light fallback in the fill (weight 2.5, down
    from 6 in #214). Its perimeter explicitly states `any`, allowing a neighboring tile's passable promise or hint to resolve it.
  - `cover-ground`: a whole tile of `cover`, with a three-segment passable
    stretch and a three-segment not-passable hint on each side.
  - `rubble-bank`: three rows of `rubble` beside three of `open`, with one
    three-cell passable stretch between them. Its perimeter explicitly states
    `any`; the interior promise is unchanged.
  - `hut-quarter`: a whole tile of `hut`. It asks for `hut` across two sides,
    and for `open` across a passable stretch on each of the other two. The
    joining sides state `any` for passability; the complementary segments on
    the open-facing sides carry a not-passable hint. Four
    make one 12 × 12 hut region, with room for a house and its yard (54
    `hut`). The `open` asks close the group, so it can't spread across the
    fill.
  - `ruins-ground`, `hall-ground`, `depot-ground`, `compound-ground`,
    `block-ground`, `market-ground`, `plant-ground`, and `checkpoint-ground`: a whole tile of their type, with the same aligned three-segment passable stretch and complementary hint as `cover-ground`. They are weighted 0, so only set pieces place
    them (below).
  - `park-ground`: a whole tile of `park`, with the same perimeter pattern, weighted
    0.6 since #214 (`cover-ground` is 0.4). The earlier weight and 224-map sample are in [42.3](42.3-generation-and-delegation-evidence.md#park-weight-221-sample). Park's own strategy places a tree at most in a lone tile, so the
    weight is Corey's to veto (17.2.8 M34).
  - `arrival-ground`, `departure-ground`, `charging-ground` and `transit-ground`: whole tiles of
    their core element class, retaining the three-segment passable stretch on
    each side and hinting the complementary three segments. Placement
    never puts them in the fill (51, "Core elements").
- **Set pieces:** each footprint is a rectangle of one type's ground, except
  `rubble-strip` and `rubble-court`. Sizes are in tiles; a tile is 6 cells.

| Set piece class | Set pieces |
| --- | --- |
| `start` | `landing`: 2 × 3 arrival tiles, 12 × 18 cells, with room for 24 spawns |
| `end` | `evac`: 2 × 3 departure tiles |
| `charger` | `charging-station`: 2 × 2 charging tiles, 12 × 12 cells |
| `transit` | `transit-station`: 2 by 2 transit tiles, 12 by 12 cells |
| `enormous` | `market-square` 10 × 5 and `covered-market` 7 × 7 (`market`), `plant-works` 8 × 6 (`plant`), `city-block` 12 × 4 (`block`), `depot-yard` 9 × 6 (`depot`) |
| `medium` | `market-row` 9 × 4 and `market-court` 7 × 5 (`market`), `walled-base` 6 × 6 and `barracks` 8 × 4 (`compound`), `checkpoint-lane` 12 × 3 (`checkpoint`), `pillar-hall` 6 × 5 (`hall`) |
| `small` | `plant-row` 6 × 3, `plant-tower` 3 × 6 and `plant-yard` 5 × 3 (`plant`), `depot-sheds` 9 × 2 and `depot-lot` 7 × 3 (`depot`), `park-square` 4 × 4 and `park-green` 6 × 4 (`park`), `ruins-lot` 5 × 4 (`ruins`), `cover-yard` 4 × 5 (`cover`), `rubble-strip` 8 × 2 (rubble banks back to back, a rubble strip six cells deep between open lanes), `rubble-court` 3 × 3 (eight cover tiles around the centered rubble island) |

  `common-set-pieces@4` still defines `hut-yard`, `hut-row`, `cover-patch`,
  `cover-field`, `rubble-lane` and `rubble-lanes`, the set pieces before S5,
  for libraries at other sizes. This library's classes no longer draw them,
  so huts come from the fill's hut quarters.
- **The three-cell grid.** Except for `clear-rubble-center`, declared class boundaries lie on a 3-cell
  grid, and every passable stretch is made of whole 3-cell blocks. Concrete
  authored passages are at least 3 cells wide, a doorway plus one (17 M9). The margin dates from a route check that couldn't see a bare doorway;
  the search now samples whole and half cells (#175), so it is a library
  choice, not a measurement need. Between concrete blocks, a passable stretch
  also splits into portals of at least 3 where the class across it changes.
  `map/macro/tests/chain-content.test.ts` checks this grid and the centered exception. Deferring
  cells can resolve individually under adjacency asks; this authored-grid check
  alone does not prove their resolved geometry. Placement checks conflicting asks
  and portal widths, and `tests/map-clear-tiles.test.js` exercises actual resolution
  and built access.
- **Fill weights:** each orientation is its own fill option, so a design
  with four orientations gets four times its weight. Hut quarters have weight
  0.3 since #214; their adjacency asks need compatible ground around the cluster,
  so their frequency also depends on the other weights. A
  design weighted 0 is no fill option: only a set piece places it. A lone
  6 × 6 tile of a structure type is too small for its builder, so those
  grounds are weighted 0, `park-ground` since #221 excepted.
- **Clear fill tiles (#214):** `clear-rubble-bank` paints a three-cell-wide rubble
  band; `clear-rubble-bend` paints three quarters of the tile as an L. Their remaining
  cells are `any`, including parts of the perimeter. Each has four rotations at
  weight 0.15 per rotation and explicitly defers perimeter passability. A three-cell
  internal opening connects the rubble to the deferred ground. Neighbor adjacency
  asks settle individual `any` cells; unasked cells become `open`. Neither an `any`
  cell nor a concrete painted cell manufactures an adjacency prescription: an
  author must state one. Rotations merge the painted bands into irregular regions.
  `clear-rubble-center` paints a centered 4 by 4 rubble island with a deferred
  one-cell border and four rotations. Its entire
  perimeter guarantees passage and a four-cell internal opening joins the island
  to the north border before rotation. It makes no adjacency asks. The perimeter
  guarantees secure the known clear context needed around the island; a deferred
  cell alone cannot secure that clearance. Under the implemented margin policy
  ([20.6](20.6-passable-margins.md)), all four rotations pass composed portal
  diagnosis and actual hunter movement in a surrounding-cover fixture.
  It has weight zero and is placed by `rubble-court`, a 3 by 3 small set piece
  with eight surrounding cover grounds, available at all three authored sizes.
  As an unconstrained fill option, the centered border can adopt class requests
  that create one-segment corner portals; the large playground's placement then
  backtracks excessively. The courtyard supplies the validated surroundings
  without weakening portal checks or changing the solver.
- **Structure joins (#214):** block, depot and compound slots in common and district
  set pieces use zero-weight ground variants. Sides joining the same ground class
  carry occupancy hints rather than repeating guaranteed openings every six cells.
  Exposed sides retain the original prescriptions exactly. This deliberately authors
  larger fill areas for buildings without removing any retained guarantee from the
  margin pipeline. Original grounds remain available unchanged. #530 extends this
  convention to market, plant, hall, park, ruins and checkpoint in common,
  district and local set pieces. Joins suppress guarantees only between
  adjacent slots of the same ground family; mixed-family and exposed sides
  retain their original prescriptions. All inward variants have zero fill
  weight, including park variants; the original park ground retains weight 0.6.
  **Local quarters (#340, #347):** the 36×18 top-level library defines three
  enormous set pieces locally, outside the included modules checked by the original
  tool. `military-quarter`'s 312 compound slots (#340), `city-centre`'s 240 block
  slots and `industrial-quarter`'s 180 depot slots (#347) now use the same inward
  variants. With their original seams, every sampled region from these quarters
  had at most a 4 × 4 fill square: depots and the block's depot and compound lots
  fell back empty. Exposed prescriptions, footprints and every other slot stay
  unchanged; this is an intentional content correction, not runtime removal of
  inherited guarantees. It is separate from #338's exterior-yard policy.
  Before/after evidence is recorded in [42](42-performance-history.md).
- **Cover:** a lone `cover-ground` in the fill forms a 6 × 6 region, too small
  for one cover piece, so it stays clear (54 `cover`). Cover comes mostly from
  the set pieces; its increased fill weight is intended to form larger joined
  cover regions.

`map/tools/author-inward-grounds.mts` checks or regenerates these explicit
structure variants and their blueprint references from the original grounds
and same-class slot adjacency. It is an offline authoring tool; library loading
does not rewrite prescriptions. For the current modules, run:

```sh
node map/tools/author-inward-grounds.mts --primitives map/macro/content/common-primitives@5.json --common map/macro/content/common-set-pieces@5.json --district map/macro/content/district-set-pieces@4.json --local-library map/macro/content/diamond-36x18.json --check
```

To regenerate, replace `--check` with `--out-dir <new-directory>`. Inputs and
existing outputs are never overwritten. The current inputs reconstruct 81
variants and 3,492 slot references, including 1,988 local slots. Omit the optional
`--local-library` to check only the included modules (1,504 references). The
library input authors all nine ground families in its local set pieces. Other
slot families stay as supplied. #530 adds immutable `common-primitives@5`,
`common-set-pieces@5` and `district-set-pieces@4`; all three authored-size
libraries pin these revisions. Earlier module files remain unchanged, and
saved maps retain their embedded library. This authored content change needs
no strategy, macro algorithm or wire version bump (53). Future content changes
still require reviewed module versions; the tool supports authored copies with
matching includes.

Larger fill areas do not ensure a warehouse in every depot. The #325
route-reservation diagnosis and bounded sample are in [42.3](42.3-generation-and-delegation-evidence.md#depot-route-reservation-sample).

31 describes the library's acceptance checks. The tools and live matches use
the same library through `map/chain.ts`; live conversion is separate (14, 22).

### The old footprints (S5)

The old library's set pieces ("The old library", below; recovered from
`141dece^:map/macro/content/default-library.json`) come back with their slot
arrangements and their placement rules and quotas unchanged (Corey,
2026-09-28: "the same distribution as before"). Each old area takes its
region type from 54's "Today's names":

- `market` pieces become `market`, except one medium piece, which became
  `hall` so the library paints it.
- `industrial` pieces become `plant` for the works and `depot` for the sheds
  and yards.
- `military` pieces become `compound` for the walled bases and `checkpoint` for
  the choke, a passage between two fence lines.
- `landing` pieces outside `start` can't be `arrival`, a core element class
  (51, "Core elements"). They were plain clearings, so they become `block`
  (the enormous one), `park`, `cover`, `ruins` and `rubble`.

The old designs were rings of fence and gate tiles around an unclaimed
middle. They are filled here: the builders now draw enclosures themselves
(`compound`'s ring, `depot`'s walls), and a ring one tile wide is below every
structure type's shape needs. So the footprints are larger than the old
ones. The S5 footprint coverage sample is in [42.3](42.3-generation-and-delegation-evidence.md#s5-footprint-coverage-sample).

Every non-`open` type rolls loot, so the default loot gradient was scaled to
keep loot per map level (14).

## The larger libraries (S6)

`diamond-24x12.json` and `diamond-36x18.json` (#171) include the same two
modules and `district-set-pieces@3.json`. A piece that is enormous at one size
is medium at the next (55):

| Set piece class | 24 × 12 | 36 × 18 |
| --- | --- | --- |
| `enormous`, 3 distinct | the districts | the quarters |
| `medium` | 12 of the 12 × 6 enormous pieces | 8 of the districts |
| `small` | 32 of the 12 × 6 medium and small pieces, including `rubble-court` | 44 drawn from the 12 × 6 enormous and medium pieces plus `rubble-court` |
| `start`, `end`, `charger`, `transit` | as at 12 × 6 | as at 12 × 6 |

The 3 × 3 courtyard is intentionally a local feature even at 36 × 18, where
the other `small` choices are much larger footprints. It joins the same
selection pool without adding to the 44-piece quota.

Core element pieces, their quotas and the six transit stations stay as at
12 × 6 (17.2.7). Each new footprint is a rectangle of whole grounds,
split between two or three types so one structure type doesn't fill it alone.
Sizes are in tiles.

- **Districts** (`district-set-pieces@3`, shared by both sizes):
  `market-district` 20 × 10 (market and park), `industrial-estate` 18 × 10
  (plant and depot), `downtown` 20 × 9 (block over a market row), `garrison`
  16 × 10 (compound over a checkpoint lane) and `old-town` 18 × 10 (ruins,
  hall and park).
- **Quarters** (defined in `diamond-36x18.json`, the only library using
  them): `market-quarter` 30 × 15 (market, park and hall),
  `industrial-quarter` 28 × 15 (plant and depot), `city-centre` 30 × 14
  (block over market and park), `military-quarter` 26 × 15 (compound over a
  checkpoint lane) and `ruined-quarter` 28 × 14 (ruins, cover and park).

The three-size S6 coverage and loot sample is in [42.3](42.3-generation-and-delegation-evidence.md#s6-authored-size-sample).

## The old library

`map/macro/content/default-library.json` and its schema served the old paths
(archived `DESIGN_DECISIONS.md`, `VOCABULARY.md`), and were deleted with them
(#146). The chain never read it; its library was authored fresh (51 track B).
What differed in it:
- `edges` strings that name a neighbour's class or a barrier word
- `walls` with gaps, and segment spans
- unread side `ports`
- a `category` field for the set piece class, and a `class` field for the
  primary region class
- every class bound to `open-field`, and no core element classes

Inspection for #241/#243/#298 also traced the former `last_exit_map` library
(at `141dece^`) for rotated partial regions and selected fence, corner and gate
tiles. Those shapes show a useful way to compose irregular regions without
forcing openings along every side. This pass adopts selective guaranteed
openings and deferred/hinted perimeter segments; it retains the current
three-cell tile grid, shapes and weights. The #214 follow-up adds rotated rubble
bands and bends, a centered courtyard feature, and deliberately larger building
fill areas within selected structure set pieces. The bounded #214 fill composition and portal diagnosis sample is in [42.3](42.3-generation-and-delegation-evidence.md#fill-composition-214-sample).
