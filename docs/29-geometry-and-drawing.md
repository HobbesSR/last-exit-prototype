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

Collision is the physics engine's: Rapier 2D 0.21.0 behind one adapter, `shared/physics/world.ts`,
which the server and the browser both run. The shipped default, `content-6` ([14](14-match-rules.md),
#523), runs on it. Contents 1 to 5 still run the legacy mover, described last in this section for
characterization and old recordings. The design is [29.1](29.1-physics-design.md), its state,
networking and replay [29.2](29.2-physics-state-networking.md), and the plan and gates
[41.1](41.1-physics-plan.md).

The world uses 40 units to the metre, four fixed substeps in each 50 ms tick and continuous collision
on every moving body, with a per-substep speed cap derived from a body's smallest radius so that
nothing outruns thin geometry. Characters are dynamic, rotation-locked circles driven toward their
desired velocity by a bounded motor, so an impulse from an explosion, a hook or another body survives
until the motor recovers the target speed rather than being overwritten each tick. Each role has three
radii, as match-pinned content: a head (what is drawn), a body (what moves: 11.2875 for a contestant,
16.25 for a gladiator) and a hurt radius (what combat tests: 12 and 23). Actors collide with each other
and with props, with zero restitution and low tangential friction, so a glancing contact keeps its
tangential motion. Heads may overlap a little: actor-to-actor contact alone has a 0.5-unit tolerance,
and walls, doors and void keep their full containment. Dead, inactive and extracted actors do not collide.

World geometry is static convex shapes built from the map's obstacles and playable-area mask
(`buildPhysicsGeometry`), with closed gates as blockers. Props are dynamic, rotating boxes, and loot
is a sensor. `segmentShapeDistance` supplies continuous distance from a closed segment to a filled
shape, with analytic circles and polygon/rectangle containment and edge tests; the swept queries
(`shared/simulation/swept.ts`: the hook tip and tether, shots and the lab's Cast ahead) use it through
`firstContact`, and so does the navigation adapter in [42.1](42.1-navigation-experiment.md). The
engine's own contact does not.

### The legacy mover (contents 1 to 5)

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
angular term anywhere in the legacy simulation, and no continuous sweep — a body that moves further than
its own radius in a tick can pass through thin geometry. Speeds are well under that for these contents.

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

## What the physics system added, and what it still lacks

The design is in [29.1](29.1-physics-design.md) (physical behavior, engine comparison, character
bodies and items) and [29.2](29.2-physics-state-networking.md) (ticks, state, prediction and replay),
and the issue sequence and evaluation gates are in [41.1](41.1-physics-plan.md). The default now
runs it, so the items this section once listed as missing are implemented: velocity and
integration, impulses and restitution, joints (springs and ropes, used by the hook and bounded to
eight constraints in total) and continuous collision. Still absent: rotational freedom for characters
(their bodies are rotation-locked), soft bodies (the jelly and squish of [42.21](42.21-jelly-squish.md) exist
only in the dev lab), and height, roofs and floors for ballistics, which are the P7 lab prototype
([42.18](42.18-physics-p7.md)) and not default behavior.

The shape module remains the primitive layer under the geometry and the swept queries, and
deliberately stops short of being a physics system:

- `transform(shape, dx, dy, angle)` moves and rotates about a shape's own anchor, which is what a
  jointed assembly needs — a part keeps its local points and only its placement changes. Rotating
  props are simulated by the engine, and `physics/presentation-geometry.ts` turns a body back into a shape.
- `overlaps(a, b)` is the general shape-against-shape test. The movement sweep uses the narrower
  circle-against-shape path because that is the hot one. It counts contact as overlap;
  `sharesArea(a, b, tolerance)` does not, and serves authored areas such as a builder's
  addressed-area record ([20.2](20.2-geometry-access.md#addressed-area)), never collision.
- Convex decomposition for concave generated content exists (shape construction,
  [29.3](29.3-shape-construction-and-assembly.md#shape-construction)). F-14 in [13](13-accepted-features.md)
  accepted the physics direction and required a measured comparison against middleware, which
  [42.6](42.6-physics-comparison.md) made before the engine was built.

Any further change must keep the fixed-tick order, the RNG/ID order and the recorded outcomes in
[31](31-verification.md) intact, or be introduced as an explicit versioned gameplay change.

## Reading guide

| Part | Load for |
| --- | --- |
| [29.1](29.1-physics-design.md) | Proposed physical behavior, engine comparison, character bodies and items |
| [29.2](29.2-physics-state-networking.md) | Physics ticks, state, prediction and replay |
| [29.3](29.3-shape-construction-and-assembly.md) | Shape construction (union, subtraction, convex pieces, #488) and placeable element assemblies and their catalogue |
| [29.4](29.4-drawing.md) | How drawing is cached in tiles, drawing planes, overhead roofs and canopies, palettes and the constraints on art passes |

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
