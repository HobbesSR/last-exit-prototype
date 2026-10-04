# 52. Map primitives and the library

Status: accepted model, 2026-09-29. The new library schema and validator are
implemented in `map/macro/src/chain/library.ts` (#83), and the chain's
minimal library is authored (#97). The old library and its schema were
deleted with mapgen's old paths (#146).

This file defines what a map is made of and what the library an author writes
contains. The chain that consumes it is 51. Original intent is in
`map/macro/design_notes.txt`, the original statement of intent. Corey's later answers in 17 and the accepted model in 51 govern where they differ.

## The layering rule

Map generation emits **declarations over a lattice**, never physical game
objects:
- A cell classed `hut` declares that the `hut` region type owns that cell.
- A passability prescription declares that a body must be able to cross a
  segment.

Physical objects are made by region strategies (51 stage 6). Appearance will
be carried by a **primitive set**: tile metadata naming what ground, walls,
fences and doors are made of in that part of the map, so the same declaration
can become a chain-link fence in a yard and a stone wall in a plaza. It is
never carried by cell class. Primitive sets are deferred (16).

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
| **Passability** | whether a body must be able to cross | `passable`, `any`, or unstated |
| **Geometry** | what stands on the segment, per channel (movement, sight, projectiles) | none: macro prescribes no geometry for now (16) |

- **Adjacency** is stated on a tile's perimeter segments. Inside a tile both
  cells are known, so it would say nothing new.
- **Passability** may be stated on any segment. Corey, 2026-09-27: "It's the
  tile designer's job to mark internal as passable". Read in context, that's
  about segments inside a tile that lie between two regions. A passable
  prescription with the same region on both sides forms no portal and obliges
  nothing (51 stage 3, 17 M8).
  - A `passable` prescription becomes a **guarantee** once placement is solved
    (51 stage 2), except on a segment facing the map's outside. The
    guaranteed stretches of each boundary are **portals**. Portals are
    derived, not authored, but an author designs passable sections with the
    portals they will form in mind (51 stage 3).
  - Unstated is kept distinct from a written `any`, so later steps can tell
    them apart (17, "Map generation": segment prescriptions).
  - Neither implies anything: "just because something isn't marked passable
    doesn't mean it won't be passable. It just means we can prove its
    passable."
- **No impassable prescription.** Without macro geometry, nothing could
  honour one, and builders aren't asked to (17).
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
  (`contestantCount` spawns, `exitCount` exits, one charger) is a **core element class**. It is
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
  It is the only macro structure the engine treats as first class, and today's
  code calls it `category`. Where each rule may anchor is the zone plan's (55).
  The shipped 12 × 6 library's classes:

| Set piece class | Rule | Quota | Owns |
| --- | --- | --- | --- |
| `start` | `start` | 1 | `contestantCount` spawns, one per contestant (17 M20) |
| `end` | `end` | 1 | `exitCount` exits and `hunterCount` hunter spawns, one per hunter |
| `enormous` | `enormous` | 3 distinct | nothing |
| `medium` | `medium` | 4 | nothing |
| `small` | `small` | 10 | nothing |
| `charger` | `charger` | 1 | one charger |
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
The SDK's `cell` profile (`microMetrics`) and mapgen's `DEFAULT_PARAMS` radii
and `APERTURES` read these. They were the SDK's values. mapgen's radii were
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

Resolution produces an independent flattened library with no includes. Its full
content, including authored metadata, determines the fingerprint. Saved maps
embed that resolved library ([53](53-map-artifacts-and-tools.md)). Node's CLI
loads named module JSON files beside the top library; browser bundles supply the
same registry through JSON imports. The Lab editor imports and exports resolved
libraries.

## The chain's library

`map/macro/content/diamond-12x6.json` is the library the chain is authored
with (B4, #97; modularized in #168). It includes `common-primitives@1.json`
and `common-set-pieces@1.json`, which also includes the primitives. Definitions
keep their original order and content. The top library owns the classes and
quotas for the diamond at its declared size. It holds 54's minimal set. That is enough to exercise every
stage and to play, and it grows from here. The fixture libraries in
`map/macro/tests/fixtures/` stay with the stage tests.

- **Classes:** one per minimal type, each bound to the region type of the
  same name.
- **Tiles:**
  - `field`: open ground, most of the fill.
  - `cover-ground`: a whole tile of `cover`, passable along every side.
  - `rubble-bank`: three rows of `rubble` beside three of `open`, with one
    three-cell passable stretch between them.
  - `hut-quarter`: a whole tile of `hut`. It asks for `hut` across two sides,
    and for `open` across a passable stretch on each of the other two. Four
    make one 12 × 12 hut region, with room for a house and its yard (54
    `hut`). The `open` asks close the group, so it can't spread across the
    fill.
  - `arrival-ground`, `departure-ground`, `charging-ground` and `transit-ground`: whole tiles of
    their core element class, passable along half of each side. Placement
    never puts them in the fill (51, "Core elements").
- **Set pieces:**

| Set piece class | Set pieces |
| --- | --- |
| `start` | `landing`: 2 × 3 arrival tiles, 12 × 18 cells, with room for 24 spawns |
| `end` | `evac`: 2 × 3 departure tiles |
| `charger` | `charging-station`: 2 × 2 charging tiles, 12 × 12 cells |
| `transit` | `transit-station`: 2 by 2 transit tiles, 12 by 12 cells |
| `enormous` | `hut-row` (two hut groups with a column of field between them), `cover-field` (3 × 3 cover tiles), `rubble-lanes` |
| `medium`, `small` | `hut-yard` (one hut group), `cover-patch` (2 × 2 cover tiles), `rubble-lane` (two banks back to back, six cells deep) |

- **The three-cell grid.** Every class boundary in a design lies on a 3-cell
  grid, and every passable stretch is made of whole 3-cell blocks. So no
  passage between classes is narrower than 3 cells, a doorway plus one (17
  M9). The margin dates from a route check that couldn't see a bare doorway;
  the search now samples whole and half cells (#175), so it is a library
  choice, not a measurement need. A passable stretch also still
  splits into portals of at least 3 where the class across it changes.
  `tests/chain-content.test.ts` holds every design to this.
- **Fill weights:** each orientation is its own fill option, so a design
  with four orientations gets four times its weight. Designs that state
  adjacency are placed early, so hut quarters need a light weight (0.1).
- **Cover:** a lone `cover-ground` in the fill forms a 6 × 6 region, too small
  for one cover piece, so it stays clear (54 `cover`). Cover comes mostly from
  the set pieces' 12 × 12 and 18 × 18 regions, so its fill weight is light.

31 describes the library's acceptance checks. The tools and live matches use
the same library through `map/chain.ts`; live conversion is separate (14, 22).

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
