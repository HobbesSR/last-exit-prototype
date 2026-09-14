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

Polygons must be **convex** and consistently wound: SAT separation is only defined for convex bodies,
and a concave one separates in the wrong direction rather than failing loudly. `convex(points)`
checks this; generated content should be validated once at build time rather than trusted. Concave
shapes must be decomposed into convex pieces before they become geometry. No decomposition helper
exists yet — that is the next piece of this module when the generator needs it.

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

- **It must fit a block corner.** `CORNER_CLEARANCE` in `map/structures.ts` is the largest one axis
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
templates are static descriptions, so the randomly sized single box that still fills the remaining
corners is emitted inline rather than drawn from the catalogue. Parameterised templates and connector
contracts are F-01, still deferred on the specification in [17](17-open-questions.md).

Every polygon part in the catalogue is held to `convex` by `tests/element.test.js`, which is the
build-time validation this document asks for above: the catalogue is the place a concave body would
now enter the world.

## Collision

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

1. **Static world geometry** — terrain, obstacles, buildings, stations, hazards. Drawn once in
   `buildMap()` into per-chunk `Graphics` objects keyed by 1024-unit cell, then only culled per frame
   by `setVisible`. The retained `Graphics` *is* the cache: its geometry is uploaded once, and a frame
   costs a visibility flag per chunk, not a redraw.
2. **Dynamic content** — loot, traps, projectiles, effects, the hazard band, gates. Cleared and
   redrawn every frame into two `Graphics` (`dynamic`, `fixtures`), because it changes every frame.
3. **Actors** — one `Container` per player holding an SVG image, ring, health bar and name. Retained
   and repositioned, never rebuilt.

So the answer to "would live vector rendering be a performance problem" is that the static half is
already cached in exactly the way that matters, and the dynamic half is bounded by what is on screen
rather than by the size of the map. A shape drawn from `outline()` costs the same as the hand-written
drawing it replaces. What would *not* be free is redrawing static geometry per frame, or building a
`Graphics` per object rather than per chunk; neither is done today and neither should be introduced.
If generated content ever makes `buildMap` itself slow, the next step is to build chunks lazily as
they first come into view, not to cache rasterised textures — a texture cache trades memory and
sharpness at zoom for a cost that is currently not being paid.

An obstacle carrying `points` is drawn from its own outline, so generated geometry needs no matching
branch in the renderer and cannot be drawn as something other than the body the simulation collides
with. Per-kind styling — palettes, highlights, hatching — stays presentation and stays in the scene.

## What a physics system would need next

The shape module is the primitive layer for it, and deliberately stops short of being one:

- `transform(shape, dx, dy, angle)` moves and rotates about a shape's own anchor, which is what a
  jointed assembly needs — a part keeps its local points and only its placement changes. Nothing in
  the simulation rotates bodies yet.
- `overlaps(a, b)` is the general shape-against-shape test. The movement sweep uses the narrower
  circle-against-shape path because that is the hot one.
- Missing, in the order they would be needed: velocity and integration, an impulse/restitution model,
  rotational inertia, joints, continuous collision for fast bodies, and convex decomposition for
  concave generated content. F-14 in [13](13-accepted-features.md) accepts the direction and requires
  a measured comparison against middleware before any of it is built.

Any of that must keep the fixed-tick order, the RNG/ID order and the recorded outcomes in
[31](31-verification.md) intact, or be introduced as an explicit versioned gameplay change.
