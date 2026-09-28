# Design decisions

This document records implemented behavior and reversible defaults for the standalone prototype. Original intent lives in ../design_notes.txt and takes precedence. This is not a replacement design specification. The retired assistant proposal is historical only, under archive/retired-design-proposal/.

Naming is fixed by [Vocabulary and layering](VOCABULARY.md).

## Scope

The prototype generates a flat 2D macro topology from a seed, validates it, shows it in a browser map lab, and exposes the same core through a CLI and MCP stdio server. Tiles are 6 × 6 cells with authored interiors: per-cell classes and segment-aligned barriers, stated per segment and per vertex. Four coarse side sockets (`N`, `E`, `S`, `W`) were a hint for the tile-edge topology solver and are currently unread, that solver having been removed. No door has runtime state.

The macro skeleton is a horizontal elongated diamond of tier zones, assembled
from a 6 × 6 tile vocabulary. Connectivity is not designed into it: seams carry
what the tiles beside them declare, and the edges, loops and contestant-only
squeezes in a generated map are measurements of that result rather than a plan
laid over it. Generation does not choose designs for walkability: it places set
pieces, fills the remaining slots with WFC, reserves a street network through
the composed result, and validation reports a map that is not walkable. It is
a scaffold for authoring and validation, not a finished game map generator.

**Key Macro and Micro Content Rules (as decided):**

- **Critical Set Pieces and Regions:** Macro generation is only responsible for placing at least one region/set-piece of the types required to spawn critical map pieces.
- **Physical Exits:** The placement of actual physical exits is a micro-generation detail. The macro layer simply allocates one or more regions that are responsible for the micro-generation of exits.
- **Parameterized Cell Classes:** Cell classes formally support parameters (`parameter: true`). This allows common configurations to be reused across region types without duplicating them for each tile set, and allows tiles to act as parameterized templates where region classes are bound during macro placement.
- **Any Class:** A first-class "any" cell region type exists and defaults to open space. During micro-generation, it takes tile meta parameters to decide its final form.
- **Selection weights:** Explicit tile selection weights have been removed from the data model. Frequency is treated uniformly until macro generation tuning is directly addressed.

### Generation modes

`generateMap` accepts an optional `MapParams.mode`, either `game` or
`playground`, and defaults to `game`. The generated map records the resolved
mode in its params. Both modes use the same horizontal
five-by-five grid masked to the diamond, generic generation pipeline, and map
validation. Game mode requires exactly 12 x 6 tiles per zone. The library must
provide at least one `start`, one `end`, three `enormous`, one `medium`, and one
`small` definition. Each game map places one `start`, one `end`, three distinct
`enormous`, four `medium`, and ten `small` instances; medium and small definitions
may be reused. Playground mode bypasses those game quotas and
may use smaller zone dimensions for quick experiments, while still requiring a
generically valid generated map. The browser, CLI, and MCP interfaces expose
the same mode parameter and pass it through to the shared core.

## The macro model

Tiles are an authoring and assembly grid. Regions, buildings, dead ends and
traversability are all properties of the composed result: a structure may cover
an arbitrary set of tile slots, a building or cul-de-sac commonly crosses
several tiles, and a tile may be uniform open field belonging to one much larger
region.

Traversability is derived from the composed geometry and the querying agent's
clearance. Authored cells, segments, vertices, structure footprints and micro
output contribute geometry. Connectivity graphs and tile-graph degrees are
solver indexes and diagnostics.

The tile-edge maze solver has been removed. Generation currently places set pieces, fills the remaining slots with WFC, and plans streets through the composed result; nothing selects designs for reachability, and whole-map geometry validation reports whether the result is walkable. Replacing that with composed macro structures is NEXT_TASKS.md item 1.

## Map layers

Decided 2026-09-27. Being implemented through issue #52. Layout, structure
(#49) and interiors (#50) are separate; the report is not yet. See "Where the
code is now" below.

A map is a valid arrangement of macro primitives. Everything else about a
generated map is either derived from that arrangement or produced by micro
generation, and these are kept apart.

| Layer | What it holds | Stored |
| --- | --- | --- |
| **Layout** | Seed and params; each slot's design, orientation and set piece; the primitives those designs lay down (cell classes, with `any` left as `any`; segment spans; stated vertices); macro features (spawn, hunter spawn, exits) | Yes. This is the map. |
| **Structure** | Everything derived from the layout that informs micro generation: `any` cells filled in from their neighbours' edge constraints, the segment-indexed seam-constraint grid, seams, the lattice walls the layout's classes and segments imply, zones, anchors, reserved streets and corridors, the regions handed to micro | No. `deriveStructure(layout)` builds it, both when generating and when reading an artifact. |
| **Interiors** | What micro generation returns: material cells, props, spawns, micro features, cell levels, per-region manifests | Yes, as its own section. |
| **Report** | Metrics and validation | No. Computed from the other three. |

The rules that follow from it:

- **Structure is a pure function of the layout.** It uses no randomness shared
  with placement and reads nothing from micro. If two maps have the same layout,
  they have the same structure.
- **Micro never writes to the layout.** Material a builder lays is interiors.
  Two things are derived from layout plus interiors, not from layout alone, and
  aren't structure:
  - the final region partition, after material is laid;
  - the final navigation wall list: lattice walls over the layout and the
    material cells, plus micro props.
- **One writer per fact.** The Map Lab's debugging overlays, such as the
  stripes on filled-in cells and the seam-constraint lines, read structure.
  They are never fields added to the stored map.
- **A layout is valid on its own terms.** Checks such as whether a tile seals
  its interior or whether its anchor is free are about the layout and its
  structure, not about what micro did later.
- **The layout names no solver.** Fields that only steer a particular
  placement algorithm, such as the removed `adapter` flag, are not layout.

This is the same "don't store what can be derived" rule that "Encoding the
primitives" and "The wire form" apply. It adds a line between macro and micro,
so derived data can't be mistaken for stated data.

### Where the code is now

- The generators run in phases that match the layers (#48), and still
  assemble today's `GeneratedMap`. V2: `placeLayout` (the retry loop's
  sampling, and the only code that draws from its generator),
  `deriveStructure` (pure; null when no street network joins the blocks),
  `generateInteriors` (on copies of its inputs), `composeLayers` (the final
  grid, regions, features and walls, shared with reading an artifact), then
  `reportMap`. Planned: `layPlan` lays the plan down, `buildPlannedInteriors`
  runs the builders, then `composePlanned` (the final grid and regions, then
  tiles, anchors and features measured on them, shared with reading an
  artifact). The plan itself is that path's structure. Both paths share
  `statedInteriors`, `composeInteriors` and `reportMap`.
- The planned path measures anchors on the composed grid, after micro, so
  there an anchor is derived from layout plus interiors, like the final
  region partition, and isn't structure. Either way anchors are derived and
  not stored (see "Anchors"), and reachability is moving off them (see
  "Reachability").
- A builder's openings are read off the grid as it stands when that builder's
  turn comes, so on both paths they include earlier builders' edits to a
  shared boundary. That is why openings are computed in the interiors phase.
- A V2 map holds `layout` (`MapLayout`) and `structure` (`MapStructure`)
  (#49). The artifact stores the layout, and `deriveStructure(layout, library)`
  rebuilds the structure on read. The layout names designs by id, and
  structure reads those designs' edge contracts and anchors, so the layout
  records a fingerprint of its library and a map is only read back with that
  library (Corey, 2026-09-27). `tiles` and the spawn, hunter-spawn and exit
  features are views joined from the two layers, kept because everything
  downstream reads them.
- `MapStructure` keeps what the Map Lab overlays read: anchors, the filled-in
  classes and the segment-indexed seam constraints. The regions handed to
  micro and the reserved streets are structure too, but only generation uses
  them, so `deriveStructure` returns them without the map keeping them. It
  holds no seams or lattice walls: nothing reads layout-only ones, and the
  final ones are derived from layout plus interiors (below).
- A planned map holds `plannedLayout` (`PlannedLayout`) (#50): `layPlan`'s
  classes and segments, which planned region owns each cell, and which region
  each planned feature stands in. The rest of the plan (ports, loot) only
  steers generation, so it isn't kept. Tiles are named for the planned region
  at their corner, and plan region ids are a namespace of their own: plan
  region `r-3` needn't be final region `r-3`.
- Every generated map holds `interiors` (`MapInteriors`) (#50), stored as its own section
  of the artifact. It states only what micro did: the class it laid on each
  cell and the span it stated for each segment, `any` where it stated
  nothing, over the filled-in classes (the planned layout's classes on a
  planned map) and the layout's segments; cell levels;
  spawns; vertex metadata; micro's features; and one entry per final region
  naming it, with its manifest and props. Whatever produces interiors later,
  such as the game's micro SDK, fills the same type.
- The final grid (`grid`), region partition (`regions`), micro features and
  navigation walls are views `composeLayers` and `composePlanned` derive from
  layout plus interiors, both when generating and when reading an artifact. None is
  stored. `grid.cells.class` is where the filled-in classes and micro's
  `solid` material meet, and no layer holds that fusion. A region's
  `obstacles` and `manifest` are joined in from its interiors entry, and
  validation reads the entry, so a prop is checked against the region its
  manifest names.
- `deriveWalls` is the lattice over the final grid, then every interiors prop.
  Layout-only walls aren't derived, because nothing reads them yet.
- One `GeneratedMap` still holds the report beside the layers.
- `deriveEdges` measures seams on the final segment grid, and micro builders
  write segments into that grid. So today's seams depend on interiors: binding
  classes to builders changes them for the same layout. Seams in structure have
  to be measured on the layout's own segments. #47 found this.
- The artifact stores metrics and validation (#51).
- `LAYER_FIELDS` marks fields `unpinned` when they only repeat content pinned
  through a view (the layout's placements beside `tiles`, the interiors'
  spawns, props and manifests beside the final views) or are new content no
  earlier baseline holds (the layout's own segments, the filled-in classes,
  the interiors' class and segment deltas). Tests pin the new content until
  the baseline is next deliberately recaptured.

### Proving a stage

`node tools/cli.mts sweep --check tests/fixtures/layer-baseline.json` reruns
the pinned seeds and compares per-layer content hashes. Today's shape fuses
layers, so the hashes group content by what can be told apart now: layout,
structure, interiors, **composed** (the final primitives, seams, walls and
region partition, which every stage must still reproduce) and report.
`LAYER_FIELDS` in `tools/sweep.mts` is the only code that knows where each
field lives. Hashing refuses a map with a field no entry claims, or with a
required field missing, so a field moved without its entry fails loudly. A
stage that moves a field updates its entry's path in the same change, and the
hashes must not move. A moved hash is a stop-and-escalate. The baseline is only
recaptured for a deliberate, reviewed content change, and the PR says so. The
baseline records the last generator commit it measured.

The stages are #47 (a per-layer content baseline), #38 (remove the legacy
generator and `adapter`), #48 (split the generator into phases without changing
its output), then #49, #50 and #51 (layout, interiors and report, each
test-driven).

## Units and scale

The first macro redesign milestone now has an independent versioned composition
contract and executable acceptance fixtures. See [Macro structures](MACRO_STRUCTURES.md)
for ownership, rotation, clearance constraints, pass ordering and migration.
The active generator, `generateMap`, places set pieces and fills the rest with
WFC; the README section "Scale and the current generator" describes it.

The standalone prototype uses one cell as one abstract segment. A tile is 6 × 6 cells and generated map coordinates are in cells. These are design units, not meters. The game uses continuous world units and has a 24,000 × 12,000 world, 40-unit navigation samples, and actor radii 12 and 23; those values are evidence about the game but are not a conversion contract for this project.

The prototype defaults to contestant radius `0.55` and hunter radius `0.90` in cell units. This preserves the brain-dump scale idea, but the game's radius ratio is approximately `12/23`, not `0.55/0.90`; both are provisional tuning values. Clearance is always derived from the selected agent radius, so changing either value must update route validation and movement checks together.

## Topology and feature semantics

The generator must produce a connected artifact in which every tile is reachable for each required agent class and every exit has a valid contestant and hunter graph path. Graph paths represent physical walking only. Transit or warp actions are separate mechanics and must not silently make a walking graph appear connected.

Spawn, hunter-spawn, charger, warp, and exit are macro feature locations attached to tiles. A map may have multiple physical exit locations; extraction capacity is not yet simulated or serialized. The game currently has one `map.exit` coordinate with three capacity slots, while this prototype exposes multiple exit locations. Neither representation should be inferred as the final game rule.

Warp is currently a generic hunter-only feature in the standalone playtest. It is a convenience for testing placement and interaction, not a commitment to rails, vehicles, instant travel, cooldowns, or route selection. The game has interim transit stations and instant gladiator rail movement, but its design notes call rails/vehicles speculative.

Charging is likewise represented as a required macro feature and a playtest interaction. The standalone run models a five-second charge counter; the game implements five seconds as 100 ticks at 20 Hz. This prototype does not couple to that tick rate or to the game's inventory/cell schema.

## Tier and spatial progression

Horizontal progress has five tier levels; vertical novelty/bonus rises away
from the centre. The two axes are exposed independently; how the original
diagram combines them into its single number is still open in QUESTIONS.md.

A tier zone is an area with its own extent. The zone grid is 5 x 5, masked to a
diamond by Manhattan distance, and each zone is `zoneWidth` x `zoneHeight`
tiles. Game mode fixes those dimensions at 12 x 6; playground mode permits
smaller dimensions. The map is exactly the tiles its zones cover, so its extent
follows from the zone dimensions and its boundary stair-steps. Zones are
derived from the params and are not stored in the artifact.

A zone carries the progression numbers for the area it covers. `lootChance`
starts at `params.lootChance` in tier 1 and rises by `params.lootTierStep` per
tier; micro generation receives it per candidate slot, so a region spanning two
zones is richer at the end nearer the exit. Tier also gates tile and layout
eligibility. Hazard and novelty content are not generated yet.

## Primitives

Cells, segments and vertices are the organising primitives. Every tile's 36
cells, 84 segments (42 per axis) and 49 vertices are addressable and all have
metadata, but only what an author states is stored: cells are dense because each
one genuinely differs, while segments and vertices are held by exception. A
segment nobody mentioned defers; a vertex nobody constrained defers. The
ergonomic shorthands (`cells`, `walls`, `edges`, `corners`) compile into that
model; `primitives` addresses it directly.

Interior vertices are not stored at all. On a flat map they carry nothing that
cells and segments do not already say, and they take no part in an adjacency
contract, so authoring one is reported as a mistake rather than silently
ignored. Only perimeter vertices can carry metadata. When heights arrive, they
will arrive as stated exceptions on the same footing.

Tiles paint zones; they do not lay material. The reserved `solid` class is
laid only by micro builders (the pillar hall, for one), and tile validation
refuses it by every route a tile has: a `#` mark, a legend entry, a
`primitives.cells` override or a default class. Every cell a tile lays down
still belongs to exactly one region.

A segment can carry several pieces of data and can say things about the cells
on either side of it. For macro generation the perimeter segments are what
matter, and among their properties they may constrain the class of the cells
in the adjacent tile, suggest a type of wall, or require passability. Those may
be mutually exclusive in practice, but nothing enforces it. The implementation
does not yet hold them apart: `edges` is one string per segment, which tile
selection reads as the class the neighbouring cell must take, so a barrier word
there only fits against the map boundary. Separating the properties is
issue #33.

Perimeter primitives are the adjacency contract. Their deferring value, `any`,
is not a silent default: it states that the tile has no requirement there and
will adopt whatever the seam contract and the neighbouring tile require. A
concrete value is a requirement, and the tile is only placed where it is met.
This is the brain dump's "don't care, defaulting to empty, but adapting to
neighbouring requirements", with the explicit-empty case (`open`) kept distinct
so an author can guarantee a path rather than merely permit one.

Cell class has a deferring value too: a tile whose default class is `any`
paints nothing of its own there and takes whatever class a neighbouring
perimeter segment asks for, settling as open ground otherwise. `.` still means
"use this tile's default".

A segment's barrier metadata is the _open span_ within it, rather than a
boolean, because the aperture ladder includes a 1.5-unit squeeze that does not
land on cell boundaries. `null` is a full barrier, `[0, 1]` is clear, and a
partial span is an aperture. Authored wall endpoints must be whole cells and
only `gap` introduces fractions, which guarantees a segment is never open in two
disjoint places and keeps its metadata a single span.

### What the contract cannot do yet

`generateMap` fills slots with WFC over rotated edge compatibility, and does
not yet read the contract above as written: `any` does not defer to the
neighbour, a design walled on every side can still be used as fill (both wait on
perimeter segment records, #33), and a template that seals its own interior can
still be placed (#34). Each is a `todo` test in `core.test.ts`. Real
negotiation between neighbours is still the open question in QUESTIONS.md.

## Tile interiors

A template may paint its own cells and place interior barriers anywhere in its
6 × 6 area, up to and including its edge, so geometry can continue through a
seam into the neighbouring tile.

This used to be bounded by a one-cell margin. The margin made template
selection a local decision: with agent radii below 1, geometry inside one tile
could never come within a body radius of a lattice node inside its neighbour, so
a template could be accepted against a seam contract without consulting the
tile beside it. It was removed to raise the interior budget (NEXT_TASKS.md item
6). Selection is therefore no longer provably local, and walkability is settled
by validating the composed map as a whole.

## Anchors

Once a tile has an interior, its geometric centre may be inside a wall or cut
off from a seam. Each placement therefore carries an `anchor`: one point that
stands for the tile in the coarse tile graph. Anchors, not centres, are what
tile-graph routes (`findPath`, the route metrics) connect, what V2's streets
run between, and where spawn, hunter spawn and exits stand.

Where they come from today:

- **V2.** A WFC-filled slot takes its design's authored `anchor`, rotated with
  it, or the tile centre. A set-piece slot takes the tile centre. Nothing
  proves it is standing room when it is placed: validation rejects a map whose
  anchor is inside geometry or not reached by the lattice flood (#45 is the
  centre-wall case). `planStreets` then reserves standing room around every
  anchor so builders can't cover it.
- **Planned.** Measured after the builders run: the nearest lattice node to the
  tile centre that the hunter reaches in the map's main component. A tile with
  none is dropped.

**Anchors are derived, never stored** (Corey, 2026-09-27). A V2 artifact
doesn't store them: `deriveStructure` finds them again on read, and validation
of an imported map checks those. A planned artifact doesn't store them
either: `composePlanned` measures them again on layout plus interiors (#50).

A single anchor is also the wrong shape for a tile whose interior is split: it
speaks for one piece and the tile graph misses routes through the others.
Reachability is moving to the contract in "Reachability" below, which needs no
anchors. What remains is a spot for each feature to stand, derived when needed.

## Reachability

Direction agreed 2026-09-27, tracked in #59. Not implemented, and the open
parts are in QUESTIONS.md "Reachability contract". It replaces anchors as the basis for
"is everything reachable?", and applies to tile placement (V2) first.

**Decided:**

- **A hunter reaches everything.** Passability is judged at hunter size, so
  gaps only a contestant fits through don't count (QUESTIONS.md, "Should a
  hunter be able to reach every tile?"). A contestant is smaller, so hunter
  reachability implies contestant reachability, and the contract needs one
  body, not two.
- **Pessimistic about what is placed, optimistic only about what isn't.** A
  face toward an unplaced slot counts as open. Nothing already placed is ever
  given the benefit of the doubt.
- **Anchors are derived, never stored** (above).
- **`open` is a privileged region class** (Corey, 2026-09-27). Every cell of a
  region formed by `open` cells is passable, which means it holds no obstacles,
  and so is every segment inside that region. It may later get its own
  decomposer and micro generator that enforce this, but the privilege belongs
  to the class, not to whichever builder runs. Today's code breaks this rule
  (see the facts below, and #61).

**The mechanism proposed:**

1. **Perimeter contract.** Each tile states which runs of its boundary are
   hunter-passable (at least two adjacent segments, the door width), and which
   of those runs connect to each other through its interior: a partition of
   its passable runs into **groups**.
2. **Composition.** Whole-map reachability is a union-find over groups. Two
   neighbouring tiles join where their shared runs are both passable. Adding a
   tile only merges. This works at any grain, so the same reasoning holds for a
   sub-region of a tile and for regions as tiles aggregate.
3. **The open-face rule.** For each component, count its open faces: passable
   runs facing an unplaced slot (faces toward the map's outside don't count).
   Components only join through open faces, so a component with none can never
   be reached again. The rule has two parts:
   - **During placement:** a placement is illegal if, while slots remain, it
     leaves any component with no open faces. Two mirror tiles passable only on
     the edge they share are rejected the moment the second is placed.
   - **At the end:** the final placement is legal only if it leaves exactly
     one component, containing every group that must be reached. Sealed
     pockets holding nothing that must be reached (point 6) are the only
     groups allowed outside it.

   The first part alone doesn't prove reachability. Once no slots remain it
   says nothing, and the last tile could close off two components at once.
   The terminal condition is what makes the pair a proof. Both are exact, not
   heuristics, and cheap: a placement only touches the components next to the
   new tile, and at the end the union-find already knows how many components
   there are.
4. **Rewinding already exists.** `solveWfc` is a depth-first backtracking
   search, capped at 10,000 steps, and `generateMap` retries 50 samples. The
   open-face rule prunes options inside that search. A forward check helps
   further: when a component is down to its last open faces into one slot,
   prune that slot to options that keep a passable run on that side, so
   contradictions surface at propagation time. WFC collapses in entropy order,
   not placement order, so "unplaced" means not yet collapsed.
5. **Interiors.** An `open` region is the cheap case. Every cell and internal
   segment is passable, so all of its passable perimeter runs are one group
   and nothing needs searching, subject to the width question in QUESTIONS.md
   "Reachability contract" 6. A tile whose interior micro fills later
   needs either a check after placement or a builder held to the tile's stated
   groups, the way `micro/conform.ts` holds planned-path builders to port
   floors. With the second, the proof survives micro unchanged.
6. **Interior content.** Every standing-room piece inside a tile belongs to
   some group, or is a deliberately sealed pocket that holds nothing that must
   be reached (builders do legitimately seal courtyards). #34 is the case this
   catches at placement.
7. **Verification stays.** Lattice validation of the finished map still runs,
   as a check on the proof, the way `enforcePorts` still runs on the planned
   path.

The planned path already reasons this way at region grain: `proveReachability`
works on port floors before any geometry exists, and conform holds builders to
them. This moves the same idea down to tiles, and makes the tile the unit that
states the contract.

**Facts this rests on (checked 2026-09-27):**

- `searchRegions` joins cells of one class across *fully clear* segments only,
  so a wall or a door span splits a region. It ignores props and clearance, so
  a region is connected on the cell grid, not necessarily for a hunter.
- Every class in the default library, `open` included, is bound to
  `open-field`. That builder places props and short wall stubs so a field
  isn't "a clear shot": it is cover against long sight lines. It never closes
  an enclosure and keeps `PASSAGE.wide` aisles. An `open` region too small for
  `open-field` falls back to `loot-scatter`, which places clutter props. Either
  way `open` cells get obstacles, which breaks the privileged-class rule (#61).
- Macro structures can already declare point-to-point connectivity
  (`MacroRouteConstraint`, `connected: true/false` at a radius), and
  `composeMacro` checks it. The default library doesn't use it. It is close to
  the "groups" half of the contract.

## Region search and micro generation

Regions are properties of cells. A design's `defaultCellClass` is the paint for
cells it does not mark otherwise, and every class a design paints is declared in
the library's `cellClasses`, so a class is introduced in exactly one place. Region search is the last macro pass:
after every tile is laid, it walks the cell grid and joins 4-adjacent cells that
share a class across a clear segment. Regions are therefore nonrectangular, may
cross tile seams, and a single tile may contribute cells to several regions.

A region is an area, not an enclosure. Its boundary emits no geometry: walls
come from seam contracts, from what a tile states, and from micro generation —
never from two regions being different. Material a micro builder lays forms
regions of its own class, and nothing stands in it.

Micro generation then runs once per discovered region, never per tile. It
receives spaced candidate slots, each carrying the loot density of the tier zone
covering it, the region's whole open area, a seed derived from the map seed and
the region's first cell, and the class rule. It may return
spawn slots and collidable geometry, and that geometry is explicitly not grid
aligned — micro detail is free of the cell lattice. Validation walks each piece
through the cells it crosses and rejects anything that leaves its own region.

### The builder output contract

A region builder returns `{spawns, obstacles, manifest}`, where `obstacles` are
free-floating walls under one cell in length. Extending it so a builder can
state cells, segments and vertices inside its own area — enough to raise a wall,
cut a door or window, declare an interior — is NEXT_TASKS.md item 10, together
with the route contract that keeps such a builder from severing a corridor.

Region builders are one kind. Tile- and zone-aware work that is not
region-shaped — resolving the primitive set, hazard placement, map-boundary
treatment — is NEXT_TASKS.md item 11.

### Micro geometry has no clearance budget yet

The contract admits props, and the shipped rules place none. Enabling them on
the `vault` class produced maps that failed validation, and the reason is worth
recording: a prop sitting well inside a vault came within a hunter radius of a
body standing outside it, because the vault's own 1.5-unit squeeze means there
is no wall between the two. Containment in a region is therefore not sufficient
for safety — a region with an open boundary reaches through it. Micro generation
needs reserved corridors or a clearance envelope before it can place blockers by
default. Until then, validation is the backstop rather than the guarantee: it
rejects the artifact, it does not repair it.

### Region interiors

The shipped library binds every class to `open-field`, and `open-field`'s wall
stubs are switched off. Both are deliberate. On 2026-09-21 the user found walls
inside regions that no tile design stated, and asked that walls come from the
tiles and nothing else: region interiors are a black box, with an interface
carrying parameters in from macro and results back out, and the builders here
were a mock that confused the macro work. The game's own micro SDK
(`shared/map/micro/`, root doc 20) is where interiors are generated for real;
this generator's adapter to it is still to be built.

So the catalogue stays, as the far side of that interface. `generateMap` still
runs a builder over every block and carries back what it returns: the builder a
region names, its props, features, vertices and levels, and the counts in
`microBlocks`, `microCells` and `microSegments`. A library that binds a class to
`compound`, `pillar-hall`, `rubble` or `courtyard` gets that geometry, and
`tests/micro-pipeline.test.ts` exercises the join that way. Rebinding the
shipped classes to them is a product decision, not a fix.

## Navigation

Clearance and connectivity run on a half-cell lattice whose every edge is an
analytically checked swept-disc move, over a bucketed wall index. A lattice
route is a real centered route for that body radius. The converse does not hold:
the lattice samples at half-cell steps and can miss a gap a body would physically
fit through. The check fails closed, which can reject a usable template but never
accepts an impassable one. Seam traversability is the composition of two
tile-local routes — anchor to seam midpoint on each side — so a declared
connection is only believed when both interiors actually serve it.

## Geometry and future layers

The current map is flat 2D. Cells, edge segments, and perimeter vertices are
addressable authoring primitives, including per-segment seam declarations. A
future 2½D extension may use discrete heights and ramps, but layer-aware
addressing, overlapping floors, visibility, projectiles, and navigation rules
are unresolved. Any such extension must preserve a clear flat-map export and
must not be smuggled into the current macro contract.

## Encoding the primitives

A map holds tens of thousands of each primitive, and their metadata is almost
entirely enumerated values drawn from a small set: a cell class name, an open
span, a height. Stored as arrays of objects, the artifact spends most of its
bytes re-spelling key names and enum members.

Two rules apply, in order. First, do not store what can be derived: vertices are
written only where something was stated about them, cell heights only once a map
stops being flat, and a cell's occupancy follows from its class. The same rule
holds between layers: a V2 map stores the primitives its layout states, `any`
included, and not the filled-in classes or seam constraints derived from them
(#49). Second, what
remains is stored as an interned palette plus run-length codes, in one shared
mechanism rather than several ad-hoc ones. The values are strongly coherent in
space, so the runs are long: a default map's 130,140 segments draw on a palette
of eight spans, and its 65,341 vertices produce no entries at all. It is still
plain, readable JSON, and `gridViews` and friends keep callers from decoding it
by hand.

Spawns stay a sparse list because they genuinely are sparse, and `walls` stays a
plain merged list because it is derived geometry that navigation reads on every
query.

## The wire form

The shape that is convenient in memory is the wrong shape to store. In memory a
map is records with names: `cellClass: "vault"`, `kind: "door"`, a wall as
`{x1, y1, x2, y2}`. Written out, that is mostly repeated key names and repeated
enum members.

Serialization therefore goes through a distinct wire form, and it applies the
same two rules the primitive model already follows. Nothing derivable is stored:
a tile's id and position follow from its grid coordinates, its zone from its
position and the zone dimensions, a region's id and area from its index and cell
list, a seam's width from its kind, and the whole wall list from the primitives —
`deriveWalls` is the one implementation, used both when generating and when
reading an artifact back, so geometry cannot drift from the primitives that
imply it. What remains is interned and packed: every
enumerated value goes once into a shared `strings` table and travels as an
integer, and every bulk field becomes a column in the narrowest integer lane
that holds it.

A V2 map's wire form stores its layout rather than its tiles: each slot's
design, orientation and set piece in slot order, the layout's class grid with
`any` kept, its own segment grid, the feature slots, and the library
fingerprint. Slot positions follow from the params. Seam constraints, filled-in
classes and anchors are structure, rebuilt on read by the same `deriveStructure`
that generation runs, and the spawn, hunter spawn and exits stand at the
anchors of their slots. Beside the layout it stores the interiors: the class
and segment grids micro stated, with `any` kept and travelling as the pair
-2, -2 in a span palette; levels, spawns, vertices and micro's features; and
each final region's manifest and props, the region named by its index in the
partition. The final grid and regions are rebuilt from the two by the same
`composeLayers` generation runs, so no region cell list or area is stored. A
planned map stores its planned layout in place of the V2 one: `layPlan`'s
class and segment grids, the planned-region grid, and each planned feature's
kind and region. `composePlanned` measures its tiles, anchors and features
again on read.

`decodeArtifact` reconstructs a map deep-equal to the generated one, which is
the property the tests assert, on several seeds, through both encodings. This is
wire version 2. Version 1 stored anchors and no layout, and is refused by
version: there is no migration and no legacy reader.

The form still stores metrics and validation, which under "Map layers" are the
report. #51 separates them.

## BSON

BSON was chosen because it can carry raw binary, so the packed columns travel as
bytes rather than as text. One property of the format shaped the design: BSON
encodes an _array_ as a document whose keys are "0", "1", "2", …, so a
47,000-entry array would spend most of its bytes on key names. Every bulk field
is therefore a typed array, which the writer stores as a binary element; only
small, genuinely heterogeneous things stay as documents.

The codec in `src/bson.ts` is written here rather than taken from a package,
because the runtime otherwise has no dependencies and the subset needed is
small. Interop is the whole point of choosing a standard format, so it is
checked against the published example documents byte for byte rather than only
against itself.

Two details are worth knowing. JSON cannot carry `NaN`, so a fully closed
segment is the out-of-range sentinel `-1` rather than a NaN pair — chosen so
both encodings agree. And a non-finite metric survives BSON but not JSON; valid
maps have none.

Sizes for a default map of 936 tiles and 260,281 addressed primitives: about
1,050 KB as the in-memory shape, 397 KB as wire JSON, 280 KB as BSON, of which
most is binary payload.

## Language and build

Sources are TypeScript. Node 24 runs them directly by erasing types, and the dev
server erases types when serving modules to the browser. There is deliberately no
build step and no compiled output tree: a `dist/` copy is exactly the kind of
artifact that drifts from the source the CLI and MCP server actually execute,
and the shared-core rule is the point of this repository. `tsc` is used only as a
checker (`npm run typecheck`), with `erasableSyntaxOnly` set so the sources stay
runnable without a compiler. Shipping to a non-Node host later is a packaging
decision, not a reason to introduce a build now.

## Authoring surfaces

The browser GUI is the primary review surface: seed/parameter controls, map overlays (tier, bonus, discovered region, cell class, template), route comparison, tile inspection, and local tile-library editing/export including a per-cell class painting grid. The CLI provides deterministic generation, validation, and batch generation. The MCP server exposes bounded generation/validation operations over stdio. All three surfaces call the shared core and should agree on seed, parameters, library, validation, and serialized map output.

## Provenance rule

User-authored design notes are authoritative for intent. Sibling-game facts are integration evidence only. Numbers or proposals appearing only as assistant/Claude recommendations—such as NFT budgets, 750 m, 12 × 12 tiles, or a trapezoid boundary—are not requirements and must stay out of defaults and acceptance criteria until the user adopts them.
