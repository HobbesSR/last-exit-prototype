# Micro generation

How a region becomes content. Naming is fixed by [Vocabulary and layering](VOCABULARY.md); this document describes the builder contract, the catalogue, and the helpers a builder is expected to use rather than rewrite.

This is the implementation of NEXT_TASKS items 4 and 10. It is not integrated with the sibling game and is not meant to be yet.

## What a builder is

A **region builder** takes one discovered region -- its class, its cell shape, a seed and the macro parameters passed down from above -- and populates it. It returns **declarations over the lattice**, never physical objects. A barrier on a segment states that something impassable occupies that edge; what that thing is made of is resolved later, from the tile's primitive set, in a pass that does not exist yet.

```ts
interface RegionBuilder {
  id: string;
  description: string;
  /** Smallest area, in cells, this builder can do anything with. */
  minArea: number;
  build(context: RegionContext): RegionEdit;
}
```

A builder is pure and deterministic in `context.seed`. It draws randomness only from `context.rng`, never from `Math.random`, and it never reads global state. Two runs of the same seed produce byte-identical output; `tests/micro-builders.test.ts` asserts this for every registered builder.

## What a builder may state

`RegionEdit` supersedes the old `RegionOutput`, which could express only spawns and props -- so it could not express a wall, a door, a window or a pillar, which was the whole of item 10.

| Field       | What it declares                                                                 |
| ----------- | -------------------------------------------------------------------------------- |
| `cells`     | a class or height for a cell inside the region                                   |
| `segments`  | the open span of a segment: `null` a barrier, `[0,1]` clear, `[a,b]` an aperture |
| `vertices`  | class or height on a lattice corner                                              |
| `obstacles` | off-lattice collidable props, each inside a single cell                          |
| `spawns`    | loot and content slots, capped by `context.budget`                               |
| `features`  | a macro feature the builder sited itself, such as where an exit stands           |

## The catalogue

Which builder runs over a region is **library data, not code**. A class rule names one:

```json
"cellClasses": {
  "yard":    { "generator": "compound", "clutterChance": 0.08 },
  "hall":    { "generator": "pillar-hall" },
  "service": { "generator": "rubble" }
}
```

`builderFor(rule, area)` resolves that name against the registry in `src/micro/catalogue.ts`. A class that names nothing, names something unregistered, or covers an area below the named builder's `minArea` falls back to `loot-scatter`, which every area can take. A builder never fails because a region was an awkward size; it is replaced.

`generatorParams` on the class rule is passed through untouched. Each builder documents its own keys and defaults as module constants.

### Shipped builders

| id             | minArea | What it makes                                                                                         |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `loot-scatter` | 1       | The fallback. Spaced loot slots and small props; the existing behavior, unchanged.                    |
| `open-field`   | 24      | Loose clusters of cover on open ground, with aisles left wide. The default treatment for large areas. |
| `compound`     | 36      | Grid-aligned buildings with doors, occasional through-routes and squeeze entrances.                   |
| `pillar-hall`  | 36      | A regular lattice of blocks with offset rows: breaks a sightline without blocking a walk.             |
| `rubble`       | 12      | Dense off-lattice debris whose surviving gaps sit in the contestant-only band.                        |
| `courtyard`    | 25      | A walled pocket with two or three gates, and a set-piece slot in the middle.                          |

## Scale

`src/micro/scale.ts` is the single statement of body scale, in segments. One segment is one cell edge and one unit of map cell space, so every quantity there is directly comparable with a span width, a wall `gap` and a body radius.

| Body               | Diameter, in segments |
| ------------------ | --------------------- |
| contestant         | above 1, below 1.5    |
| gladiator / hunter | above 1.5, below 2    |

The two bands share the 1.5 boundary, and that is what makes a contestant-only squeeze expressible: an opening of exactly 1.5 admits every contestant and no hunter. `PASSAGE.squeeze`, `PASSAGE.door` and `PASSAGE.wide` are derived from those four numbers rather than restated, so changing the brief changes one table.

## The region is not tile shaped

A region may span any number of tiles at any offset, and a builder is written against `context.mask`, not against tiles. It may consult `context.grid` -- the 6 x 6 tile axis -- to align what it builds, and mostly should: aligned structures read as built rather than scattered, and border geometry landing on a tile seam composes with the region next door. Nothing requires it. Off-lattice detail is expressly welcome, and `rubble` is entirely off-lattice on purpose.

## What stops a builder breaking the map

Two contracts, enforced by the harness rather than trusted to the builder.

**Containment**, in `src/micro/edit.ts`. Every declaration goes through `RegionCanvas`, which refuses -- and counts -- anything that reaches outside the area the builder owns: a cell edit outside the mask or on a reserved cell, a segment with neither side in the region, a prop straddling two cells, a spawn over budget. A refusal returns `false` and is normal; a builder that asks for something it cannot have is told no, not crashed.

**Clearance**, in `src/micro/clearance.ts`. Containment is not sufficient, because a region with an open boundary reaches through it: a builder can wall its area into disconnected halves, or seal it off entirely, without ever touching a cell it does not own. `guardRegionEdit` rebuilds the region's local geometry as a `NavTarget` and uses the proven swept-disc lattice in `src/nav.ts` -- the same one route validation uses, not a second copy -- to check that every boundary opening is still mutually reachable at the hunter radius. Segment declarations are dropped until it passes. The lattice is a sufficient test and not a necessary one: it fails closed, which is the direction to fail in.

`context.openings` marks the widest opening onto each neighbouring region as `required`, and the canvas refuses to wall those outright. That is a cheap stand-in for a real route envelope. The proper fix is `context.corridors`, which is the reserved-route list a builder may build up to but not across; it is empty today because no proven route reaches micro generation yet. Until it does, the clearance guard sees only the region's own area, and that limitation should be stated rather than papered over.

## Streets, and why a builder is handed a block

A builder sees one region and nothing else. That is enough to keep its own area
coherent and nowhere near enough to keep the map connected: a region may be most
of the open field, and its builder is then deciding whole-map connectivity while
looking at an area whose boundary tells it nothing. The information is simply not
there to be careful with.

So the route network is decided **before any builder runs**, out of the composed
geometry, and handed down. `planStreets` in `src/core.ts` builds it and it has
three properties worth stating, because the first two versions of it were wrong
in instructive ways.

**A leg is a proven route, not a straight line.** Each is a path on the same
swept-disc lattice route validation uses, confined to the ground it joins, so it
bends around whatever the tile designs already put in the way. A straight
anchor-to-seam line looks right and is wrong exactly where the map is most
interesting: on a tile whose authored interior makes the direct line impossible,
the real route detours, and reserving the line leaves the detour buildable. That
is what sealed seven tiles on the first attempt.

**Streets join blocks, not tiles.** A route to every one of 936 tiles is a route
through every tile, and a 6 x 6 tile has no room for both a street and a
building. The second attempt did that and produced gravel: blocks averaged thirty
cells, below the minimum area of every builder that makes buildings, so
`compound` and `pillar-hall` silently made nothing and the map was scatter and
rubble again. It can be coarse instead, because the per-block guard already keeps
a block internally connected and keeps its openings, so a tile in the middle of a
block is reached across the block's own ground. `STREET_SPACING` -- tiles between
one street and the next -- is the single dial between open ground and buildable
ground.

**Reservation is thin, and clearance is kept by other means.** A cell is reserved
when a route passes through it, not when it lies within a body's clearance of
one. The clearance beside a street is kept instead by the per-block guard, which
will not let a builder sever a corridor with a wall, and by `clearStreets`, which
drops any prop that reaches into one -- a whole-map fact no single block can see.

Tile anchors are reserved the same way and for the same reason: an anchor is
where the nav graph says a body may stand to serve a tile's seams, and validation
checks that it really is standing room. It is macro skeleton exactly as a street
is.

What falls out of the streets is a **block**: the connected run of a region's
cells that no street passes through. A builder is handed a block, not a region.
Splitting there rather than inside each builder keeps `mask.rects`,
`mask.interior` and the clearance flood all describing the same buildable area --
without it a builder sites a building across a street, every cell of it is
refused, and the builder silently produces nothing.

## Regions are discovered twice

A builder that states a wall genuinely splits its own area, and a builder that repaints a cell changes what class that cell is. Either makes the partition the builder was handed a wrong description of the result.

So generation searches for regions twice. The first search finds the **build regions**: the areas handed to builders. Micro generation then runs and mutates the grid. The second search produces the **artifact regions**, which describe the composed result and agree with the cells by construction -- which is what `validateMap` has always required. A compound's rooms are separate regions in the artifact because the walls the builder stated really do separate them.

Obstacles are re-attached by the cell they sit in, and each artifact region's manifest names the builder that owned its cells. Manifest counts are recomputed from what actually landed, never from what a builder reported placing; validation compares them against the geometry, per AGENTS.md.

## Adding a builder

1. Write it in `src/micro/builders/`, exporting a `RegionBuilder`.
2. Register it in `src/micro/index.ts`.
3. Name it from a class rule in the library.
4. Add it to the table in `tests/micro-builders.test.ts`, which asserts determinism, containment and manifest agreement for every registered builder without further per-builder work.

Reach for the helpers before writing geometry by hand. `src/micro/mask.ts` answers the shape questions -- interior, border, depth, maximal rectangles, lattices -- and `src/micro/edit.ts` owns every declaration. A builder that computes its own clearance, its own flood fill or its own random stream is duplicating something that already has one owner.

## Measured

150 seeds, default params, the same sweep before and after
(`node tools/cli.mts batch --seed baseline --count 150`). All 150 valid in both.
min / median / max:

| metric            | before             | after              |
| ----------------- | ------------------ | ------------------ |
| `microBlocks`     | --                 | 1043 / 1110 / 1173 |
| `microSegments`   | --                 | 79 / 196 / 313     |
| `microCells`      | --                 | 0 / 12 / 40        |
| `obstacleCount`   | 0 / 0 / 0          | 144 / 225 / 303    |
| `squeezes`        | 0 / 0 / 0          | 0 / 1 / 3          |
| `interiorWalls`   | 5055 / 5407 / 5908 | 5138 / 5469 / 5955 |
| `lootCount`       | 1554 / 1731 / 1887 | 1044 / 1151 / 1263 |
| `strandedAnchors` | --                 | 0 / 0 / 1          |
| `propsReclaimed`  | --                 | 0 / 0 / 4          |

Read this honestly. The machinery works, is deterministic and never produces an
invalid map, and the repair pass is nearly idle -- at most one stranded anchor
and four props given back on the worst of 150 seeds, which is what it should
look like. But the _density_ is low: about 200 stated segments and 225 props
over 33,696 cells is sparse for a map whose point is obstruction, and a median
of one contestant-only squeeze is barely an asymmetry at all. `microCells` in
particular is near zero, which means `pillar-hall` almost never finds a legal
block.

The causes are known and are tuning rather than design. Streets and the standing
room around every tile anchor take ground before a builder sees any; `keepClear`
then takes a further ring around standing room for props; and the builders' own
gates are conservative on top of that. `STREET_SPACING`, the anchor berth, and
each builder's `generatorParams` are the dials, and none of them has been tuned
against anything -- they were set to whatever first stopped the map breaking.
Tuning them wants a batch sweep with the histograms NEXT_TASKS item 7 asks for,
not another guess.

The `lootCount` fall is the same cause and is not a regression in itself: a slot
on reserved ground is not offered, and reserved ground is now a third of the map.
Whether ~1,150 slots a map is the right number is a content question nobody has
answered yet.
