# 29. Geometry, collision and drawing

How a thing in the arena is described, what the simulation does with that description, and how the
same description reaches the screen. Read with [22](22-ownership.md) for module ownership and
[25](25-pacing-and-rendering.md) for frame pacing and camera behaviour.
Shape construction and element assembly are in [29.3](29.3-shape-construction-and-assembly.md); drawing is in [29.4](29.4-drawing.md).

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
([29.3](29.3-shape-construction-and-assembly.md#shape-construction)).

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
  concave generated content now exists (shape construction, [29.3](29.3-shape-construction-and-assembly.md#shape-construction)). F-14 in [13](13-accepted-features.md) accepts the direction and requires
  a measured comparison against middleware before any of it is built.

Any of that must keep the fixed-tick order, the RNG/ID order and the recorded outcomes in
[31](31-verification.md) intact, or be introduced as an explicit versioned gameplay change.

## Reading guide

| Part | Load for |
| --- | --- |
| [29.1](29.1-physics-design.md) | Proposed physical behavior, engine comparison, character bodies and items |
| [29.2](29.2-physics-state-networking.md) | Physics ticks, state, prediction and replay |
| [29.3](29.3-shape-construction-and-assembly.md) | Shape construction (union, subtraction, convex pieces, #488) and placeable element assemblies and their catalogue |
| [29.4](29.4-drawing.md) | How drawing is cached in tiles, drawing planes, overhead roofs and canopies |

## Earlier heading links

These landing links preserve bookmarks into the former single file.

<a id="shape-construction"></a>

- Shape construction: [29.3](29.3-shape-construction-and-assembly.md#shape-construction).

<a id="one-assembly-stamped-anywhere"></a>

- One assembly, stamped anywhere: [29.3](29.3-shape-construction-and-assembly.md#one-assembly-stamped-anywhere).

<a id="drawing"></a>

- Drawing: [29.4](29.4-drawing.md#drawing).

<a id="drawing-planes"></a>

- Drawing planes: [29.4](29.4-drawing.md#drawing-planes).
