# 56. Buildings

Status: **request for comments**, 2026-10-04. Corey's write-up, "Procedural
Building Geometry Library", is issue #185. Its full text stays there. This
record holds the parts this project adopts, how each maps onto what exists, the
departures and why, and the build order. The choices it raised are 17 M26 to
M33 ([17.2.8](17.2.8-building-questions.md)); M26, M28 and M29 are answered.
L1's wall-run emitter is implemented; L2–L5 remain planned. Marked proposals
are not requirements until Corey adopts them.

> **Building topology and building geometry are related but distinct procedural problems.**

> A generator should be able to first decide *what building it wants* and then determine *how that building can be realized in the available space*.

> The grid should be treated as a **coordination framework**, not a geometric prison.

> **A semantic element occupying some space, with constraints and interfaces to other semantic elements.**

## The one requirement

A building owes its region exactly what any strategy owes: the portal
promise (54). Every portal on the region's boundary is reachable by a hunter
from every other portal, through passable ground (Corey, 2026-10-04, M29).
Nothing else in a design is a requirement:
- **Region boundaries are hard** (M26). A region or subregion is "absolutely
  a hard boundary", with constraints on its perimeter (51 principle 5).
- **Labels are guidance** (M28). A space's name and tags guide the generator
  and carry no gameplay meaning. If architecture gains mechanical
  requirements, they are decided once buildings make layouts that work in
  play.
- **Connections are guidance** (M29). How two spaces join is the design's own
  intent, used to place openings. The promise is the only check.

## Why now

Three strategies already build rooms, and now share L1's wall-run emitter:
- `hut` (`map/micro/strategies/hut.ts`) draws four walls with a centred door
  and a window opposite it.
- `compound` (`compound.ts`) draws a ring of rooms with doors onto a court, and
  gate passages, through its own `roomTemplate` and `gateTemplate`.
- `depot` (`depot.ts`) draws warehouses with a door at each end.

The game's original room shell in `builders.ts` remains a fourth implementation.

Each formerly turned "this side of this box has walls with an opening in them"
into element parts its own way. The library is that machinery done once, so that
`block`'s lots and the drafted types (54) can have real buildings without a
fifth copy. It belongs in the SDK, as a library builders share (50, "The SDK is
a library"). A region type still owns its strategy. The library is mechanics:
it doesn't pick what a type builds (19).

## How the design maps onto the project

| #185 | Here | Status |
| --- | --- | --- |
| Region: a connected cell set, maybe concave, maybe with holes | A brief's cells (20.1); `RegionContext` for decomposition (19) | exists |
| Cells, segments | 52's primitives. Inside a region they are micro's own, not macro's prescriptions, and a segment is a guide: its geometry may extend past either side (M26) | exists |
| Span: an ordered path along segments | A chain of the kernel's **runs** (`map/kernel/run.ts`), straight stretches between two owners, joined at corners | runs exist; a span is new |
| Anchor | Element `spot` parts, core element sites, loot sites | partly; a general anchor is new |
| Zone | Renamed **space** (M27): "zone" already means a tier zone (52) and a zone plan (55) | new |
| Design graph, space nodes, connections | A building design: plain data | new |
| Space allocation over cells | 19's candidate allocation: contracts with hard feasibility and named soft utility, bounded search, residuals | the machinery exists; adjacency between pieces is new |
| REQUIRED / PREFERRED / DISCOURAGED / FORBIDDEN | 19's hard feasibility and named soft scores. Rules prune during the search, never a check after it with retries | exists |
| Residual space resolver | 19's residuals ("Treat the residual as another allocation") | exists |
| Fallback: ideal, acceptable, fallback | 17 M24: the decomposer hands a piece to another builder, and `open` is the last resort | exists |
| Boundary extraction | `boundaryRuns` over the spaces and the outside, with the outside as one more owner | exists |
| Wall run, door, window | Element parts (29): `building` and `window` obstacles, `gate` doors, `encloses` for the roof | L1 wall-run emitter exists; roof assembly stays with the caller |
| Visual, collision and semantic geometry per primitive | One shape description feeds collision, sight and drawing (29). The library emits shapes once, never a second collision model | exists |
| Door widths | The kernel's scale (52, "Units and scale"): a doorway is 2 cells | exists |
| Hierarchical seeds | Named random channels per region (`rng(seed, channel)`) | exists |
| Debug views | The micro lab, decomposition lab and generation demo (20.5) | exist; building views are new |
| Kits | Deferred until art direction (M32) | deferred |
| Multiple floors, stairs, roof planes | 16's multi-floor direction, after collision planes (M32) | deferred |

## Adopted

- **Two stages, each a pure step.** A strategy first produces a **building
  design**, then **realizes** it in its cells. Each output is plain data, so it
  can be saved, loaded and shown in a lab, as every chain stage can (51
  principle 3). The design is decisions, an object. Boundaries and spans are
  derived from the allocation, so they are views and are recomputed.
- **The design graph.** Spaces are nodes, connections are edges, all of it
  guidance (M28, M29). A space states an area range in cells, whether it
  wants the outside (a window, a door to the yard), and labels. A connection
  says which opening joins two spaces, or a space and the outside: a door (a
  gate, a doorway wide), an open passage, or a window. Archways, half walls
  and railings are the same openings with another look, and wait for kits.
- **Realization passes**, each its own function with its own output type:
  1. **Footprint**: the cells the building takes, a contained rectilinear set,
     chosen so the region keeps its portal promise (54).
  2. **Allocation**: each space gets cells, and the two spaces of each
     connection share a run long enough for its opening, where they can.
  3. **Boundaries**: the runs between every two spaces, and between each space
     and the outside, chained into spans.
  4. **Openings**: each connection takes a place on its spans, then windows on
     outside spans that the design asks for.
  5. **Walls**: each span is a guide, and becomes wall pieces with its
     openings cut out, as element parts. A wall may stand on either side of
     its segments or straddle them (M26), but never outside the region's
     cells. Rects are convex, so corners and junctions need no decomposer (29).
- **Provenance in labels.** Every element and part says what made it, such as
  `hut/space-1/wall-n` or `compound/room-3/door`. The design and the
  allocation are the rest of the "why", kept with the build while it runs and
  shown in the lab.
- **Feedback stays inside the strategy.** When realization fails, the
  strategy tries a smaller design or hands the region on (M24). Nothing goes
  back to macro: the chain runs one way, and a shortfall goes to the report
  (51 stage 8) (M31).
- **Candidate sites:** where something can go, apart from what will. A wall
  run offers its door and window candidates and the openings pass chooses
  among them. This is the second milestone's.

## Departures

- **Regions are hard boundaries.** #185 calls a region "an allocation of
  space ... rather than a strict construction boundary". Corey, 2026-10-04
  (M26): "a region / subregion is absolutely a hard boundary that even have
  constraints on its perimeter. Internally a segment can be a guide that has
  geometry that extends past either side." So 51 principle 5 stands, and
  inside the region a building needn't fill the cells or follow cell edges.
- **TypeScript functions, not classes.** The API in #185 is C++ with virtual
  `design` and `realize` methods. Here it is pure functions over plain data,
  in `map/micro/building/`, exported through `sdk.ts`.
- **Design semantics are guidance, not contracts.** #185's spaces and
  connections carry architectural meaning, and its constraints treat them as
  requirements. Here they only guide the generator (M28, M29), and the portal
  promise is the one requirement.
- **The grid is coarse for rooms.** A contestant is more than a cell across,
  a doorway is 2 cells, and `compound`'s rooms are 3 deep. A usable room is at
  least 3 × 3 cells, and #185's shop, a 2-cell bathroom in an 8 × 4 building,
  doesn't fit at this scale. Buildings with several spaces need regions of
  roughly 8 × 8 and up. A 4 × 4 `hut` stays one space.
- **No separate collision model.** #185's primitives each emit visual,
  collision and semantic geometry. Here one shape does all three (29).

## L1 wall-run API

`emitWallRun` in `map/micro/building/walls.ts`, exported through `sdk.ts`,
accepts a kernel `Run` and options for cell size, wall thickness, offset,
start/end trims and openings. Thickness, offset, trims and opening centres and
lengths are in cells. The offset locates the wall's near face relative to the
guide: positive is toward +y for a horizontal run and +x for a vertical run.
An offset of minus half the thickness straddles the guide. Trims give adjoining
walls explicit corner ownership.

Openings are sorted along the run. A `door` emits a gate, a `window` emits a
window obstacle, and `open` leaves a gap. Invalid, overlapping or out-of-bounds
openings are rejected. Parts follow the run, with gates at their openings;
callers assemble them in their established order to preserve generated IDs.
The emitter does not know a region's cells: callers still own containment and
the portal promise.

The emitter works in cells and scales once. It refuses a cell size that isn't a
whole number of world units (52, "Coordinates"), and that integer ratio is what
lets `hut`, authored in world units, come out exactly the same through it.

## Build order

The first milestone is #185's §36, cut to fit. Each stage is its own issue
under the tracker, #187. The first stage changes no output, so the existing
sweep baseline proves it. Later stages add content and re-baseline last
(53).

| Stage | Builds | Proof |
| --- | --- | --- |
| L1 (#188), implemented | **Walls from runs.** A wall-run emitter takes a run, cell size, thickness, offset and openings, and returns element parts. `hut`, `compound` and `depot` draw their walls through it | the sweep baseline is unchanged |
| L2 (#189) | **The design and its passes.** The design graph and its validation; boundaries and spans from an allocation; openings placed from connections. `hut` builds its one-room house as a design | the baseline is still unchanged |
| L3 (#190) | **Allocation.** Spaces are allocated in a footprint, on 19's allocator or a guillotine split, whichever the tests favour. Its own checks, *proposed*: each space's area is in its range, each space is connected, and the openings join every space. Those are the allocator's internal rules, not part of the region's contract, whose one requirement stays the portal promise. Connections only steer it | focused tests over shapes and seeds for those checks |
| L4 (#191) | **A building lab.** The micro lab shows a building's design graph, allocation, spans and openings beside its geometry | browser check |
| L5 (#192) | **Buildings with several spaces.** `hut` grows larger designs where its region allows; `compound`'s ring becomes a design | promise tests over shapes and seeds, then re-baseline |

The second milestone, #185 §37, takes components and grammar, candidate sites,
constraint scoring, residual use inside a footprint,
and hallways. Its stages are filed once L5 lands. Kits wait for art direction,
and the third milestone, §38, waits for multiple floors (16).
