# Macro structure contract, version 1

This is the executable contract for the first redesign milestone, implemented
by `src/macro-types.ts` and `composeMacro` in `src/macro.ts`. It is an experimental
composition API, not yet the generator used by the GUI, CLI or MCP. Its four
acceptance cases live in `tests/macro.test.ts`. They exercise composed physical
geometry using the existing swept-disc navigation and cell-region search.

## Footprints and placement

A structure owns an explicit set of integer local cells. The set may be
nonrectangular, disconnected, span many tiles or occupy part of a tile. A
six-by-six patch is simply 36 listed cells. The caller selects a placement;
random selection, tier eligibility and required feature selection belong to
the later planner. They are not implicit effects of composition.

Rotation is 0, 90, 180 or 270 degrees clockwise in screen coordinates about
local vertex (0,0), followed by an integer world-cell translation. Rotating a
cell transforms its square, not just its lower corner. Segments, aperture spans,
entrances, reservations and route probes use the same transformation.

The input mask explicitly lists playable cells in a bounded world rectangle.
Mask boundaries emit barriers, including around holes. Internal tile boundaries
emit nothing. Flat cells are the only supported layer; a future layer contract
requires a version change rather than silently interpreting a height field.

## Ownership and composition

Each cell has at most one structure owner. Overlap fails even when the paints
agree. Unowned mask cells receive the composition's `defaultCellClass`; owned
cells receive their structure's default, unless an explicit cell paint overrides
it. This gives filler a precise scope and makes composition independent of
placement order. Filler does not overwrite structures. A future tile-patch
compiler must emit this same representation rather than a second composition
algorithm.

A structure can state unit segments incident to its cells, including footprint
boundaries. An omitted segment defers; `null` is a wall, `[0,1]` explicitly open,
and `[lo,hi]` a single open span. Separate fractional spans in adjacent unit
segments express a 1.5-cell aperture. Rotation reverses spans when segment
direction reverses. On ingest, endpoints are rounded to the nearest 1e-9 cell
using `Math.round(value * 1e9)` integer ticks; reversal subtracts ticks from 1e9.
Spans that collapse at this precision are rejected. Shared declarations must
agree exactly after this normalization; contradictory
requirements fail instead of using last-writer precedence. Unstated segments
between playable unfilled cells are open. Solid cells and the outside mask
cannot be opened by a segment declaration. No tile interior margin applies.

This precision is a reversible experimental default. It preserves decimal
apertures through rotation without bit-equality failures or order-dependent
tolerance merging. It does not restrict authors to half/quarter-cell apertures.

Region paint never emits geometry. The existing region search aggregates
cells of the same class across fully clear shared unit segments.
Region identity is independent of agent radius; sampled navigation components
are separate products. Filled cells form material regions without a micro builder.

## Entrances, reservations and constraints

An entrance is a named position, not an instruction to cut a wall or declare
connectivity. Its geometry must be stated separately. Local entrance, corridor
and constraint points must lie in the closure of the owned footprint. A planner
can use entrance positions for external approach constraints.

A reserved corridor is a polyline plus a positive disc radius. The composer
checks every segment against the final walls, including neighbouring geometry.
Its swept clearance may extend beyond the structure's footprint: ownership of
paint is not ownership of clearance. Reservations remain in the output for a
future micro pass to honor; this milestone does not enable micro blockers.

A route constraint gives two half-cell lattice positions, a radius and desired
connectivity. Both endpoints must be occupiable. Connected results are backed by
the existing lattice's swept-disc edges. A disconnected result means no sampled
route was found; it is not a proof that no continuous route exists. This is
especially relevant to requested cuts. IDs and observed results are reported
in the manifest; failed requirements reject composition.

The cul-de-sac fixture demonstrates a corridor crossing multiple tile seams,
with two physical sides, a cap and an open mouth. It does not introduce a
general dead-end detector or relabel tile degree as a geometric observation.

## Pass ordering to implement next

1. Build the playable mask and horizontal tier/vertical bonus field.
2. Select required structures and feature positions, with explicit bounded
   candidate/reroll budgets. Compile any local patches into owned cells and
   segment declarations.
3. Compose structure and filler paint/geometry. Route shaping may propose
   additional physical structures in unowned cells; it cannot close a tile seam
   merely by setting a graph edge.
4. Derive navigation for each required radius and evaluate route constraints,
   entrance approaches and protected corridors. Obstruction set pieces can
   request cuts through these constraints. On failure, try a different candidate
   or report failure within the budget; do not erase required architecture.
5. Search regions, run micro generation with the reservations, then revalidate
   final geometry and actual micro manifests. Navigation caches must be
   invalidated after any geometry change.

The fixtures establish that broad open space, cross-tile architecture and
body-dependent cuts are expressible with this order. They do not establish a
successful randomized placement rate or solve maze tuning.

## Version and artifact migration

`MacroStructure.version` and `MacroCompositionInput.version` are both 1 and form
a separate experimental contract. A composition is a `NavTarget`, not a legacy
`GeneratedMap`, and must not be passed to the existing artifact codec or
`validateMap`. Fresh composition results use fresh navigation cache keys;
external callers who edit their walls must call `clearNavCache` before querying.

Composition output retains `seed`, the dense resolved `segmentOpen` array
(vertical segments first, then horizontal, as in `PrimitiveGrid`), and world-space
`constraints` with endpoints, radius and desired connectivity. These are source
data for later checks; the manifest records observations and never replaces
constraint definitions. Points are copied so later author-input edits do not
change them. Cell class/solid arrays plus segment spans and seed are sufficient
to rerun the shared region search. Walls remain the final collision geometry;
future off-grid micro obstacles do not change region paint or macro spans.

`checkMacroRoutes` is the shared check used by composition and post-edit callers.
It invalidates navigation caches, rejects malformed/non-finite walls before
navigation, and rechecks retained corridors and constraints against current
final walls. It returns fresh observations without changing prior manifests.
A connectivity mismatch invalidates the declared requirement; blocked endpoints
are errors, never successful cuts. This is a geometry check of a constructed
composition, not a decoder or complete validator for arbitrary imported data.
Artifact structural validation and actual micro-output containment/count checks
remain separate migration work. Callers should use `valid` and structured
constraint observations, not parse diagnostic strings for control flow. Add
structured per-corridor results only when a real consumer needs them.

Current priority is structural expressiveness and geometry/traversal correctness.
Runtime thresholds, route-length targets, difficulty and balance tuning are
deferred. The large-field fixture checks correct composition without a timing
gate. Bounded search attempts are termination safeguards, not tuning objectives.

When the generator adopts composition, bump both the library and generated-map
schema versions. The legacy library now uses `defaultCellClass`, matching this contract, in that
migration, and rename `metrics.deadEnds` to `tileGraphLeaves` if the old diagnostic
is retained. Do not serialize tile traversability as authority. Rework the wire
codec to reconstruct walls from the composed primitive geometry and preserve
ownership/reservations needed for validation. Require JSON/BSON round-trip tests
and GUI/CLI/MCP parity before switching defaults. For this standalone prototype,
reject old versions with a useful error unless a small explicit migration proves
worth retaining. Current legacy artifacts and the active generator remain at
their existing versions during this contract milestone.
