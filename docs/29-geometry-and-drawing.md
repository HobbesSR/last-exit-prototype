# 29. Geometry, collision and drawing

How a thing in the arena is described, what the simulation does with that description, and how the
same description reaches the screen. Read with [22](22-ownership.md) for module ownership and
[25](25-pacing-and-rendering.md) for frame pacing and camera behaviour.

## One description, three consumers

`shared/shape.ts` owns what a shape *is*. Everything else asks it. A shape is one of three forms:

| Form | Anchor | Stored as |
| --- | --- | --- |
| `rect` | top-left corner | `x`, `y`, `w`, `h` |
| `circle` | centre | `x`, `y`, `r` |
| `polygon` | anchor, with points local to it | `x`, `y`, `points` |

`shapeOf(record)` resolves a stored map record into whichever form it describes: `points` wins, then
`r`, then the box. That ordering is what the collision code always assumed, so nothing about existing
maps or recordings changes. The three consumers are collision (`shared/movement.ts`), sight (also
`movement.ts`, via `edgesOf`) and drawing (`public/arena-scene.js`, via `outline`). None of them
re-derives geometry from raw fields any more, which is what previously allowed the renderer and the
physics to disagree about what an obstacle looked like.

P3 shape visibility follows the same boundary: the physics display adapter
converts body records with `circle`, `polygon` and `transform`; rendering reads
their `outline`. `view.ts` owns whether a shape is visible, just as it owns
point/actor visibility. Its per-frame query clips sight-fan triangles to the
camera with `clipPolygonToRect`, then asks shared `bounds`, `contains` and
`overlaps`. Clipping is a geometry primitive in `shape.ts`: it preserves convex
winding/world coordinates and input arrays, and returns no polygon when the
intersection has zero area. No second point-in-polygon or segment-intersection
implementation lives in the physics presentation adapter.

Polygons must be **convex** and consistently wound: SAT separation is only defined for convex bodies,
and a concave one separates in the wrong direction rather than failing loudly. `convex(points)`
checks this; generated content should be validated once at build time rather than trusted. Concave
shapes must be decomposed into convex pieces before they become geometry, with shape construction
below.

## Shape construction

`shared/shape-construction.ts` builds shapes from shapes (#488). `construct(shapes)` starts from their
union; `union`, `subtract` and `intersect` each return a new construction; `pieces()` breaks the
result into disjoint convex pieces. `convexPieces(rings)` breaks a concave or holed outline the same
way, filled even-odd. `disjoint(shapes)` gives each shape less the ones before it, returning a shape
that overlaps none of them as it is, so overlapping parts of one assembly can be its addressed areas
([20.2](20.2-geometry-access.md#addressed-area)). Builders use it for intent; it lives in `shared/`
beside `shape.ts` rather than in `map/kernel/`, which imports nothing outside itself, so macro and
micro can both reach it.

- **Grid.** Operations run on Clipper's integer grid, 256 steps per world unit, so coincidence and
  collinearity are exact and nothing depends on trig (#170). The result's corners are then put back:
  an input corner exactly as given, and a corner the construction made at the exact crossing of the
  input edges it lies on, so a piece ends on a cut's surface rather than up to half a step inside it.
  Edges are found by their grid versions, since a shallow crossing's rounding moves it further
  along them. A sliver thinner than a grid step may be lost.
- **Circles** become polygons circumscribed one grid step wide of the circle, taken from the grid,
  so a cut by a circle never leaves a piece inside it. The free-space index keeps its own exact
  circumscription.
- **Breakdown.** A part (an outer ring with its holes) whose edges are all axis-aligned breaks into
  rectangles: bands at every corner, spans carried on while they match, in rows or columns,
  whichever gives fewer. Any other part is triangulated and its diagonals removed where the two
  sides make a convex piece (Hertel–Mehlhorn, at most four times the fewest). A four-sided
  axis-aligned piece comes back as a rect; other pieces are polygons anchored at the origin, so
  their points are their world outline exactly. Order depends only on the area.

## One assembly, stamped anywhere

`shape.ts` describes a single body. `shared/map/element.ts` describes a *group* of them: a placeable
element is a footprint plus parts — obstacles of any shape, gates, loot spots and reservations — all
positioned in coordinates local to the element's anchor. `placeElement` stamps one at a world point.
`shared/map/templates.ts` is the catalogue.

Before it there was no such level. The arena's only building existed as eight literal `rect` calls in
`buildStructures`, so a second building meant a second copy of those literals, and the door, windows
and interior loot spot were positions in that copy rather than properties of a structure. The
template carries them; the *instance* carries only what varies, which today is its anchor, its node
and whether its doors start locked.

Two things are load-bearing:

- **Part order is frozen.** Ids come from one counter shared by every stage, so reordering a
  published template's parts renumbers every object placed after it and changes each seeded map, the
  same way stage order does. [31](31-verification.md) treats that as a versioned gameplay change.
- **Parts are shapes, not boxes.** A part may be a polygon, and `fieldsOf` — the inverse of
  `shapeOf` — writes it back as a record whose `w`/`h` are the axis-aligned extent, so the footprint
  and overlap tests that read raw fields stay correct. A polygon's points are re-anchored to that
  box's corner so `x`/`y` mean for it what they mean for a rect; a circle keeps its centre anchor,
  because that is where `shapeOf` reads it back from.

`templates.ts` holds the catalogue and `REGION_ELEMENTS` maps a block's module kind to the set it
draws from, so a yard, a depot and a garden build from different structures rather than one building
reskinned. Two constraints bind a new template:

- **It must fit a block corner.** `CORNER_CLEARANCE` in `shared/map/structures.ts` is the largest one axis
  may be and still clear the reserved block centre. Fail it in both axes and `clearFootprint` rejects
  the element at every corner of every block, so it silently never appears rather than failing
  loudly — which is exactly what the first warehouse and compound did. `tests/element.test.js` holds
  the catalogue to it.
- **Interior openings are about 100 units.** A gladiator is radius 23 and the navigation grid samples
  at radius 25 every `TILE`, so a narrower way through either refuses the larger role or samples as
  solid and strands a bot behind it. Loot spots need radius-24 clearance or the objectives stage drops
  them, leaving a building that [12](12-player-requirements.md) requires to hold loot holding none.

`REGION_PROPS` does the same for the cover scattered between structures, so a region differs in what
fills it as well as what anchors it. What the element layer deliberately does *not* do yet is vary:
templates in the legacy street generator are static descriptions, so the randomly sized single box
that still fills the remaining corners is emitted inline rather than drawn from the catalogue.
The separate micro-generation path now supplies parameterized room assemblies, arbitrary region
masks and explicit connector contracts; see [20](20-micro-generation.md). It stamps through this
same element layer, and live rooms now use it through the generation chain
([22.2](22.2-map-generation.md#live-map-assembly)); the street generator remains for the frozen
fixture and explicit legacy callers.

Every polygon part in the catalogue is held to `convex` by `tests/element.test.js`, which is the
build-time validation this document asks for above: the catalogue is the place a concave body would
now enter the world.

## Collision

`segmentShapeDistance` supplies continuous distance from a closed segment to a
filled shape, with analytic circles and polygon/rectangle containment and edge
tests. The research navigation adapter in [42.1](42.1-navigation-experiment.md)
uses it for conservative swept clearance, including void and gate geometry.
It is not used by production movement or the current bot planner.

`shared/movement.ts` is the only module that decides whether something may occupy a place.

Bodies are circles: a contestant has radius 12, a gladiator 23, a projectile its own. World geometry
is any shape. Every test is therefore circle-against-shape, dispatched by `separate()`.

Broad phase is a uniform bucket grid of 200 world units, built once per map and cached in a WeakMap
keyed by the map, invalidated when the obstacle array identity or its length changes. A query
collects the buckets a radius touches, then rejects candidates on `nearBounds` — an axis-aligned
bounds test — before any SAT call. **Order matters for cost:** the bounds test must run before a SAT
body is built, not after. Reversing those two for closed gates cost roughly 6x on `sim.move` and 2x
on `sim.step`, because `canOccupy` runs hundreds of times a frame and once built a body per gate on
every call.

`movePlayer` is position-based, not velocity-based: it steps the body to its desired position, then
runs three separation passes over the nearby colliders, subtracting each overlap vector. That is what
produces sliding along walls and around corners. There is no velocity, no mass, no restitution and no
angular term anywhere in the simulation yet, and no continuous sweep — a body that moves further than
its own radius in a tick can pass through thin geometry. Speeds are well under that today.

Final position is rounded to three decimals, which is part of the frozen fixture: changing it changes
recorded outcomes.

## Sight

Sight is separate from collision and uses edges, not bodies. `edgesOf(shape)` turns any shape into
closed segments; a circle becomes a `CIRCLE_SEGMENTS`-sided outline (16), which is fixed and shared
because changing it changes which rays graze a tree. Windows are excluded from sight edges but not
from collision, so a shot and a look pass a window while a body and a dropped item do not.

`visibilityPolygon` sweeps rays in ascending angle over an active set of segments, keeping each
vertex's angle so `litPoint` can answer per-entity visibility with a binary search instead of a fresh
ray. What a viewer may *know* — reveals, cloak, roof concealment — is a gameplay rule and lives in
`shared/view.ts` as `seesPoint`/`seesActor`, which the world renderer and the minimap both call. They
used to implement it separately and had drifted; see [15](15-information-rules.md) for the rule.

## Drawing

Phaser renders everything. There are three kinds of drawn content, and they differ in how often they
are rebuilt:

1. **Static world geometry** — terrain, obstacles, buildings, stations, hazards. Recorded once in
   `buildMap()` as a list of drawings indexed by 512-unit cell, then rasterised into a
   `RenderTexture` per tile the first time a tile comes near the view. A frame costs a textured quad
   per visible tile.
2. **Dynamic content** — loot, traps, projectiles, effects, the hazard band, gates. Cleared and
   redrawn every frame into two `Graphics` (`dynamic`, `fixtures`), because it changes every frame.
3. **Actors** — one `Container` per player holding an SVG image, ring, health bar and name. Retained
   and repositioned, never rebuilt.

**A retained `Graphics` is not a cache.** Phaser 3 keeps a `Graphics` as a list of commands and
replays it on every render: each rounded rectangle becomes a path and each filled polygon is
triangulated again with Earcut, every frame. This document used to say the opposite, and the static
layer was culled per 1024-unit chunk on that belief. The headed-Chrome comparison and its limits are retained in
[42.2](42.2-runtime-performance.md#retained-graphics-observation).
`render.draw` now times Phaser's render pass separately, so this cost can't hide again.

How the tiles are kept:

- **Recorded once, by bounds.** `staticAt(box)` records a drawing's calls once and indexes it under
  every cell its box touches, padded by `SEAM`. A tile replays every drawing indexed in its cells, in
  recorded order and without duplicates, and its texture clips them to its own square. So a shape
  across a seam is drawn whole on both sides, and overlapping translucent shadows are not doubled.
  The old anchor-keyed chunks let a large shape spill a whole chunk past its anchor.
- **Tile size follows zoom.** A tile spans `512 << level` units, and the level rises as the camera
  pulls back, keeping a tile at least `MIN_TILE_PIXELS` across. A player's view uses 512-unit tiles.
  The whole-arena view uses about fifteen 4,096-unit tiles; at 512 units it would need nearly 600,
  and building those together froze the page for over 15 seconds under software GL.
- **One texel per screen pixel.** The resolution is the camera zoom, rounded up to a multiple of
  1/16, so a tile is always a whole number of texels and a window resize rarely rebuilds anything.
  Each texture overlaps its neighbours by one texel. Without that, filtering blends a tile's edge
  with nothing, and the grid shows as faint lines in the whole-arena view.
- **Built under a frame budget.** Each frame builds tiles for up to `BUILD_MS`, and always at least
  one. Holes in the view go first, then visible tiles at a stale resolution, then the ring one tile
  beyond the view, nearest first. A stale tile stays on screen, scaled, until it is replaced.
  Textures more than `RETAIN_TILES` beyond the view, or at another level, are released, so texture
  memory is bounded by the view, not the map.
- **Recreated, not resized.** A texture whose size changes is destroyed and made again.
  `RenderTexture.resize` in Phaser 3.90 left the redrawn content clipped and offset.

Textures drop the canvas's multisampling, but at one texel per pixel a before-and-after screenshot
differed in fewer than 20 pixels. Anything that changes per frame belongs in the dynamic layer, not
in a tile, because a changed tile costs a full rasterise.

An obstacle carrying `points` is drawn from its own outline, so generated geometry needs no matching
branch in the renderer and cannot be drawn as something other than the body the simulation collides
with. Per-kind styling — palettes, highlights, hatching — stays presentation and stays in the scene.

## Drawing planes

Drawn content belongs to a plane, and the plane decides what it occludes:
- **Ground:** floors, markings and thresholds. Door and window decals (`map.decals`, 56.2) reach
  past a roof's overhang, so an entrance shows while its roof is drawn.
- **Objects:** walls, trunks and actors.
- **Overhead:** roofs and canopies, above the actors.

Overhead items occlude what the viewer can already see; they never change what
the viewer may *know*. Sight stays the shared rule above (`seesPoint`, `roofConceals`),
so fading a roof or a crown is cosmetic. A tree keeps its trunk as the collision
and sight shape; its translucent crown is drawn at 1.9 times the trunk radius on
the overhead plane and partly hides a player who steps under it. This styling
reads `kind` and radius from existing records; explicit asset parts remain future
work. Ground and static objects share the static tile cache in recorded order;
actors are retained objects above it, and overhead textures sit above actors.

The overhead cache uses the same camera-dependent tile level, resolution and
frame budget as static geometry. Roofs have one alpha group per building; crowns
share a canopy group. Roof textures are cropped to the roof's own extent, which overhangs
the walls by `ROOF_OVERHANG` on exterior sides, dropping overhang, perimeter fill insets, and seam
strokes where physically abutting another roof or building regardless of fade group (`roofCellBorders`,
comparing boundary contact intervals across unequal cell sizes and staggered origins).
Group visibility and alpha update retained `RenderTexture` quads without replaying
the drawing commands. Offscreen textures are released beyond the retention ring,
and map replacement clears both caches. No overhead `Graphics` is rendered each
frame.

Roof presentation (`shared/view.ts`, so the renderer reads one rule). Roof groups
are declared directly on `map.roofs` via `groupId` by the building SDK (`roofGroups`),
retiring the client-side door-edge derivation when declared roofs are present; legacy
maps without declared roofs fall back to deriving groups from abutting building boxes
sharing a door edge. A builder states its groups. The compound's rule is reachability: roofs
fade together when one can walk between their spaces without leaving the structure
(`reachableRoofGroups`, 56.1). A group fades together, and its target is binary
(`roofRevealed`): revealed (alpha 0) while the viewer is inside any room of the group or within
`ROOF_REVEAL_RANGE` (32 world units) of one of the group's doors, windows or doorway threshold
cells (`openingDistance`), and covered (alpha 1) otherwise. The reveal zone is therefore the
threshold cell outside each exterior door, plus a band about a body's width outside each door and
window; approaching an opening reveals nothing partially. The client moves alpha toward the target
at a constant rate (`stepRoofAlpha`), so a complete fade takes `ROOF_FADE_MS` (300 ms) and a target
flip mid-fade reverses from the current alpha, taking the remaining share of that time. A roof that
reaches zero stops being drawn. An unfogged directed view reveals every roof; a fogged view with no
eye covers them. While the viewer is indoors a player camera zooms in by
`INSIDE_ZOOM`, eased; a directed camera is not touched. None of these presentation changes alters `roofConceals` or sight.

## What a physics system would need next

The proposed design is now in [29.1](29.1-physics-design.md) (physical behavior,
engine comparison, character bodies and items) and
[29.2](29.2-physics-state-networking.md) (ticks, state, prediction and replay).
The issue sequence and evaluation gates are [41.1](41.1-physics-plan.md).
These are design records, not implemented behavior; the baseline below remains.

The shape module is the primitive layer for it, and deliberately stops short of being one:

- `transform(shape, dx, dy, angle)` moves and rotates about a shape's own anchor, which is what a
  jointed assembly needs — a part keeps its local points and only its placement changes. Nothing in
  the simulation rotates bodies yet.
- `overlaps(a, b)` is the general shape-against-shape test. The movement sweep uses the narrower
  circle-against-shape path because that is the hot one. It counts contact as overlap;
  `sharesArea(a, b, tolerance)` does not, and serves authored areas such as a builder's
  addressed-area record ([20.2](20.2-geometry-access.md#addressed-area)), never collision.
- Missing, in the order they would be needed: velocity and integration, an impulse/restitution model,
  rotational inertia, joints and continuous collision for fast bodies. Convex decomposition for
  concave generated content now exists (shape construction, above). F-14 in [13](13-accepted-features.md) accepts the direction and requires
  a measured comparison against middleware before any of it is built.

Any of that must keep the fixed-tick order, the RNG/ID order and the recorded outcomes in
[31](31-verification.md) intact, or be introduced as an explicit versioned gameplay change.
