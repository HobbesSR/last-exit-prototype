# Vocabulary and layering

Implementation vocabulary and intended layering. Original user intent in ../design_notes.txt takes precedence; future capabilities below are not claims about the live generator.

## The layering rule

The system emits **declarations over a lattice**, never physical game objects. A
barrier on a segment states that something impassable occupies that edge. A cell
classed `hut` states that hut generation owns that cell.

Physical primitives are resolved from those declarations in a later pass, from
tile metadata naming the primitive set in force — what ground, walls, fences and
doors are made of in that part of the map. The same barrier declaration becomes
a chain-link fence in a service yard and a stone wall in a plaza. That
resolution pass is not built and is not part of the artifact contract.

So passes _declare_, _paint_, _state_ and _reserve_. Appearance is carried by
the primitive set, never by cell class.

A generated map has four layers:
- the **layout**, the arrangement of macro primitives, which is the map itself
- its derived **structure**
- micro's **interiors**
- the **report**

DESIGN_DECISIONS "Map layers" defines them and says which layers are stored.

## Primitives

| Term        | Extent             | Carries                                                                                                                                                                              |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cell**    | 1 × 1              | class, and later height                                                                                                                                                              |
| **Segment** | one cell edge      | a barrier as an open span, or separate movement / sight / projectile channels; on a tile's perimeter, also a constraint on the neighbouring cell's class (issue #33 separates these) |
| **Vertex**  | one lattice corner | class and height, by exception                                                                                                                                                       |

These are the only addressing primitives. Everything below is an aggregate or a
container built from them.

## Cell class

What kind of generation owns a cell. Authored per cell; a tile supplies the
default for cells it does not paint.

Classes are declared once, in the library's `cellClasses`, and a tile may only
paint a declared name. A class entry carries what is intrinsic to the class
wherever it appears — clutter density, later its material channels. Anything
that varies with position on the map belongs to the tier zone instead.

`cell → class` is total. Two class names are reserved:

| Class   | Meaning                                                                                      |
| ------- | -------------------------------------------------------------------------------------------- |
| `solid` | filled material — nothing stands there; laid only by micro builders, never painted by a tile |
| `""`    | outside the mask — no tile covers this cell                                                  |

A third, `any`, is the deferring class: it states nothing and takes whatever a
neighbouring perimeter segment requires, settling as open ground.

Tiles paint zones. Material is a micro detail: a builder lays it inside its own
region, and it aggregates into regions like any other class, so the partition
has no holes. Authoring further material classes is a later generalisation.

## Region

A maximal set of contiguous cells sharing a class, joined across clear segments.
Discovered after placement by walking the cell grid; never authored.

Regions are not tile-shaped. A single tile contributes cells to as many regions
as it has classes, and a single region may cover a hundred tiles at any offset.
Tile boundaries are not region boundaries and imply no barrier.

The worked case the contract serves:

> Four copies of a tile, each rotated, each painting a 3 × 3 corner block as
> `hut` and nothing else. Placed so the four blocks meet at a tile junction,
> they form one 6 × 6 `hut` region spanning four tiles. Hut generation runs once
> over that 36-cell area and may site a 4 × 4 hut anywhere inside it — walls on
> segments, a two-segment door south, a two-segment window north, a spawn cell
> inside. Its placement is constrained by the region's shape, not by the tile
> grid that produced it.

A region's boundary emits no geometry. Walls come from what a tile or structure
states, from seam contracts, and from what a builder declares.

## Tier zone

A macro area carrying the progression parameters for everything inside it: loot
tier, hazard, and the bonus/novelty axis.

The zone grid is 5 × 5. Columns give the five horizontal tiers; rows give bonus,
rising away from the middle. A zone is occupied when it lies within two steps of
the centre by Manhattan distance, which is the diamond the design notes draw:

```
X X 5 X X
X 3 4 3 X
1 2 3 4 5
X 3 4 3 X
X X 5 X X
```

Thirteen zones are occupied. Each is `zoneWidth × zoneHeight` tiles — 12 × 6 by
default, a 2:1 ratio, tunable. The map is exactly the tiles its zones cover, so
`columns` and `rows` follow from the zone dimensions, and the map boundary
stair-steps. This is a reversible default. The original notes leave boundary
smoothing and staggered columns open.

A zone carries the progression numbers for everything inside it. `lootChance`
is the one implemented: it starts at `params.lootChance` in tier 1 and rises by
`params.lootTierStep` per tier, which is how "loot tiers increase from left to
right in five levels" is expressed. Hazard and the bonus axis are not folded in
yet; how the original diagram combines tier and bonus into one number is open in
QUESTIONS.md.

Zones are derived from the params, so the artifact stores none of them.

## Builders

A process that turns declarations into content.

**Region builders** take a region — its class, its cell shape, a seed, and the
macro parameters passed in from above — and populate it. This is the design
notes' "selects and parameterizes a micro procedural generation process that is
free to populate the region as it sees fit, using the explicit and macro
parameters passed on to it".

**Tile and zone builders** take a tile and its zone context and populate with no
region involved: resolving the primitive set, zone-driven hazard placement,
map-boundary treatment. Not built.

Macro parameters reach a builder by being passed in, not looked up. Loot is the
worked case: each candidate slot carries the `lootChance` of the zone covering
its cell, so a region spanning two zones is richer at the end nearer the exit
without anyone having to decide which zone the region "belongs" to.

## Tile

A 6 × 6 patch of cells: an authoring and assembly unit, and a carrier of
metadata about its area. A tile owns a default cell class, its painted cells,
its stated segments and vertices, and the primitive set governing how
declarations in its area become physical objects.

The corpus entry is a `TileDesign` — one of the tiles the assembler may place,
not a pattern for producing tiles. A `PlacedTile` is one of them sited at a slot.

In the intended composition model, tile boundaries imply no barrier. Fully open seams, and open meetings of four
tiles, are ordinary. `generateMap` inserts no seams of its own: a seam carries what the designs beside it state.

`ports` are the exception to "a tile owns its area": four coarse seam classes
read by the tile-edge topology solver. They are a hint layered over a design
rather than part of it — what a side actually carries is stated per segment by
`edges` and per vertex by `corners` — so a design may omit them entirely, and an
omitted side defers.

The original notes define tiles as predefined 6 × 6 patches, tile sets as
choices of those tiles, and layouts as arrangements of tile sets. The
module-versus-tile distinction came from the retired assistant proposal and
is not adopted.

## Coordinates

Two granularities, which never share a field name.

| Quantity                                                          | Unit                                |
| ----------------------------------------------------------------- | ----------------------------------- |
| `MapParams.zoneWidth`, `zoneHeight`                               | tiles per zone                      |
| `MapParams.columns`, `rows`                                       | tiles                               |
| `MapParams.tileSize`                                              | cells per tile edge                 |
| `GeneratedMap.width` / `height`, `PrimitiveGrid.width` / `height` | cells                               |
| `MapZone.tiles`                                                   | tiles, inclusive `[x0, y0, x1, y1]` |
| `MapZone.cells`                                                   | cells, inclusive                    |
| `PlacedTile.col`, `row`                                           | tiles                               |
| `PlacedTile.x`, `y`, `anchor`                                     | cells                               |

`MaskCell` sets `x`/`y` in tiles and the placement pass overwrites them in cells
on the same objects. Until that is collapsed to one authoritative pair, `x`/`y`
are cells on any value that has left `makeMask`; use `col`/`row` for tiles.
