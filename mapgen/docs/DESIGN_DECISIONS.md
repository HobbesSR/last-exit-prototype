# Design decisions

This document records implemented behavior and reversible defaults for the standalone prototype. Original intent lives in ../design_notes.txt and takes precedence. This is not a replacement design specification. The retired assistant proposal is historical only, under archive/retired-design-proposal/.

Naming is fixed by [Vocabulary and layering](VOCABULARY.md).

## Scope

The prototype generates a flat 2D macro topology from a seed, validates it, shows it in a browser map lab, and exposes the same core through a CLI and MCP stdio server. Tiles are 6 × 6 cells with authored interiors: per-cell classes and segment-aligned barriers, stated per segment and per vertex. Four coarse side sockets (`N`, `E`, `S`, `W`) were a hint for the tile-edge topology solver and are currently unread, that solver having been removed. No door has runtime state.

The macro skeleton is a horizontal elongated diamond of tier zones, assembled
from a 6 × 6 tile vocabulary. Connectivity is not designed into it: seams carry
what the tiles beside them declare, and the edges, loops and contestant-only
squeezes in a generated map are measurements of that result rather than a plan
laid over it. Generation only chooses designs that keep the map walkable. It is
a scaffold for authoring and validation, not a finished game map generator.

**Key Macro and Micro Content Rules (as decided):**

- **Critical Set Pieces and Regions:** Macro generation is only responsible for placing at least one region/set-piece of the types required to spawn critical map pieces.
- **Physical Exits:** The placement of actual physical exits is a micro-generation detail. The macro layer simply allocates one or more regions that are responsible for the micro-generation of exits.
- **Parameterized Cell Classes:** Cell classes formally support parameters (`parameter: true`). This allows common configurations to be reused across region types without duplicating them for each tile set, and allows tiles to act as parameterized templates where region classes are bound during macro placement.
- **Any Class:** A first-class "any" cell region type exists and defaults to open space. During micro-generation, it takes tile meta parameters to decide its final form.
- **Selection weights:** Explicit tile selection weights have been removed from the data model. Frequency is treated uniformly until macro generation tuning is directly addressed.

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

The tile-edge maze solver has been removed. Generation currently fills slots outward from the western edge enforcing reachability through candidate selection, backed by whole-map geometry validation. Replacing that with composed macro structures is NEXT_TASKS.md item 1.

## Units and scale

The first macro redesign milestone now has an independent versioned composition
contract and executable acceptance fixtures. See [Macro structures](MACRO_STRUCTURES.md)
for ownership, rotation, clearance constraints, pass ordering and migration.
The active generator still uses the legacy tile-edge pipeline described below.

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
tiles - 12 x 6 by default, tunable. The map is exactly the tiles its zones
cover, so its extent follows from the zone dimensions and its boundary
stair-steps. Zones are derived from the params and are not stored in the
artifact.

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

Topology is still solved before tile selection (an implementation limitation,
not a brain-dump requirement), so a per-segment declaration can only select among the apertures
topology produced — it cannot propose one. Vertex requirements genuinely
propagate between neighbours, but greedily in placement order and without
backtracking: a tile that cannot satisfy what a neighbour already claimed falls
back to an adapter rather than causing the neighbour to be reconsidered. Real
negotiation is still the open question in QUESTIONS.md.

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
by validating the composed map as a whole. `generateMapLegacy` still refuses
authored interiors when either radius reaches 1; that guard, and its error
message, date from the margin.

## Anchors

Once a tile has an interior, its geometric centre may be inside a wall or cut
off from a seam. Each placement therefore carries an `anchor`: standing room
strictly inside the tile from which every seam that tile must serve is reachable
by a proven route. Anchors, not centres, are what macro paths connect and what
feature coordinates use. Anchors are serialized, so validation of an imported
map checks the anchor that was recorded rather than recomputing a convenient
one.

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
stops being flat, and a cell's occupancy follows from its class. Second, what
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

`decodeArtifact` reconstructs a map deep-equal to the generated one, which is
the property the tests assert, on several seeds, through both encodings.

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
