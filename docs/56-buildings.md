# 56. Buildings

Status: **request for comments**, 2026-10-04. Corey's write-up, "Procedural
Building Geometry Library", is issue #185. Its full text stays there. This
record holds the parts this project adopts, how each maps onto what exists, the
departures and why, and the build order. The open choices are 17 M26 to M33
([17.2.8](17.2.8-building-questions.md)). Nothing here is implemented yet, and
marked proposals are not requirements until Corey adopts them.

> **Building topology and building geometry are related but distinct procedural problems.**

> A generator should be able to first decide *what building it wants* and then determine *how that building can be realized in the available space*.

> The grid should be treated as a **coordination framework**, not a geometric prison.

> **A semantic element occupying some space, with constraints and interfaces to other semantic elements.**

## Why now

Three strategies already build rooms, each with its own copy of the walls:
- `hut` (`map/micro/strategies/hut.ts`) draws four walls with a centred door
  and a window opposite it.
- `compound` (`compound.ts`) draws a ring of rooms with doors onto a court, and
  gate passages, through its own `roomTemplate` and `gateTemplate`.
- `depot` (`depot.ts`) draws warehouses with a door at each end.
- The game's original room shell in `builders.ts` is a fourth.

Each turns "this side of this box has walls with an opening in them" into
element parts its own way. The library is that machinery done once, so that
`block`'s lots and the drafted types (54) can have real buildings without a
fifth copy. It belongs in the SDK, as a library builders share (50, "The SDK is
a library"). A region type still owns its strategy. The library is mechanics:
it doesn't pick what a type builds (19).

## How the design maps onto the project

| #185 | Here | Status |
| --- | --- | --- |
| Region: a connected cell set, maybe concave, maybe with holes | A brief's cells (20.1); `RegionContext` for decomposition (19) | exists |
| Cells, segments | 52's primitives. Inside a region they are micro's own, not macro's prescriptions | exists |
| Span: an ordered path along segments | A chain of the kernel's **runs** (`map/kernel/run.ts`), straight stretches between two owners, joined at corners | runs exist; a span is new |
| Anchor | Element `spot` parts, core element sites, loot sites | partly; a general anchor is new |
| Zone | Renamed **space** (M27): "zone" already means a tier zone (52) and a zone plan (55) | new |
| Design graph, space nodes, connections | A building design: plain data | new |
| Space allocation over cells | 19's candidate allocation: contracts with hard feasibility and named soft utility, bounded search, residuals | the machinery exists; adjacency between pieces is new |
| REQUIRED / PREFERRED / DISCOURAGED / FORBIDDEN | 19's hard feasibility and named soft scores. Rules prune during the search, never a check after it with retries | exists |
| Residual space resolver | 19's residuals ("Treat the residual as another allocation") | exists |
| Fallback: ideal, acceptable, fallback | 17 M24: the decomposer hands a piece to another builder, and `open` is the last resort | exists |
| Boundary extraction | `boundaryRuns` over the spaces and the outside, with the outside as one more owner | exists |
| Wall run, door, window | Element parts (29): `building` and `window` obstacles, `gate` doors, `encloses` for the roof | parts exist; the wall-run emitter is new |
| Visual, collision and semantic geometry per primitive | One shape description feeds collision, sight and drawing (29). The library emits shapes once, never a second collision model | exists |
| Door widths | The kernel's scale (52, "Units and scale"): a doorway is 2 cells, a squeeze 1.5 | exists |
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
- **The design graph.** Spaces are nodes, connections are edges. A space
  states an area range in cells, whether it needs the outside (a window, a
  door to the yard), and tags. A connection states its kind and whether it is
  required.
- **Connection kinds, by what can cross** (*proposed*, M29):
  - `door`: a doorway wide, a gate. Both roles pass.
  - `squeeze`: 1.5 cells, no gate. Contestants pass, hunters don't (P-04).
  - `open`: no wall at all.
  - `window`: blocks movement, lets sight through (P-11).
  - `wall`: neither.

  Architecture's archway, half wall and railing are these same kinds with
  another look. They wait for kits.
- **Realization passes**, each its own function with its own output type:
  1. **Footprint**: the cells the building takes, a contained rectilinear set,
     chosen so the region keeps its portal promise (54).
  2. **Allocation**: each space gets cells. Every required connection's two
     spaces share a run long enough for its opening.
  3. **Boundaries**: the runs between every two spaces, and between each space
     and the outside, chained into spans.
  4. **Openings**: each connection takes a place on its spans, then windows on
     outside spans that the design asks for.
  5. **Walls**: each span becomes wall pieces with its openings cut out, as
     element parts. Rects are convex, so corners and junctions need no
     decomposer (29).
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

- **Regions stay independent.** #185 calls a region "an allocation of space
  ... rather than a strict construction boundary". 51 principle 5 says a
  strategy places geometry only inside its own cells, and composition relies
  on it. *Proposed* (M26): keep principle 5. Within its region a building
  needn't fill the cells nor lie on cell edges.
- **TypeScript functions, not classes.** The API in #185 is C++ with virtual
  `design` and `realize` methods. Here it is pure functions over plain data,
  in `map/micro/building/`, exported through `sdk.ts`.
- **Gameplay comes before architecture.** A bedroom and a bathroom mean
  nothing in play. A space here carries what play needs: enclosed and roofed,
  dead end or passage, loot weight, who can enter. An architectural name is a
  label and a hook for later art (M28).
- **The grid is coarse for rooms.** A contestant is more than a cell across,
  a doorway is 2 cells, and `compound`'s rooms are 3 deep. A usable room is at
  least 3 × 3 cells, and #185's shop, a 2-cell bathroom in an 8 × 4 building,
  doesn't fit at this scale. Buildings with several spaces need regions of
  roughly 8 × 8 and up. A 4 × 4 `hut` stays one space.
- **No separate collision model.** #185's primitives each emit visual,
  collision and semantic geometry. Here one shape does all three (29).

## Build order

The first milestone is #185's §36, cut to fit. Each stage is its own issue
under the tracker, #187. The first stage changes no output, so the existing
sweep baseline proves it. Later stages add content and re-baseline last
(53).

| Stage | Builds | Proof |
| --- | --- | --- |
| L1 (#188) | **Walls from runs.** A wall-run emitter takes a run, a thickness and openings, and returns element parts. `hut`, `compound` and `depot` draw their walls through it | the sweep baseline is unchanged |
| L2 (#189) | **The design and its passes.** The design graph and its validation; boundaries and spans from an allocation; openings placed from connections. `hut` builds its one-room house as a design | the baseline is still unchanged |
| L3 (#190) | **Allocation.** Spaces are allocated in a footprint, on 19's allocator or a guillotine split, whichever the tests favour, with required adjacency as a hard rule | focused tests over shapes and seeds; every required connection gets its opening |
| L4 (#191) | **A building lab.** The micro lab shows a building's design graph, allocation, spans and openings beside its geometry | browser check |
| L5 (#192) | **Buildings with several spaces.** `hut` grows larger designs where its region allows; `compound`'s ring becomes a design | promise tests, then re-baseline |

The second milestone, #185 §37, takes components and grammar, candidate sites,
constraint scoring beyond required adjacency, residual use inside a footprint,
and hallways. Its stages are filed once L5 lands. Kits wait for art direction,
and the third milestone, §38, waits for multiple floors (16).
