# 20. Bounded micro generation

The game now has a standalone micro-generation implementation in
`shared/map/micro/`. It accepts explicit regions and resolves them into the same
obstacles, roofs, windows and doors used by the live game. The default street
generator does not call it yet. The sibling `last_exit_map` remains a separate
macro experiment, with no runtime imports or copies of its generated artifacts.

This is the current user-directed F-01 work. Macro gives micro an owned area and
constraints; micro chooses what occupies it. Cells and segments organize that
work without prohibiting freeform shapes. The priority is a reusable local SDK
of geometry and placement primitives; the shipped architecture builders are
examples, not an art-style backlog. The child-region decomposer now supplies
bounded candidate analysis and allocation; its design record is [19](19-decomposition-design.md).

## Input and output

`generateMicroRegion(spec)` takes a serializable `RegionSpec`:

- Stable region `id`, integer `seed`, and builder class: `open`, `depot`,
  `courtyard`, `ruins` or `entry`.
- `cellSize` in game world units and a contiguous, non-overlapping list of cell
  coordinates. Masks may be concave, holed or span arbitrary tile boundaries.
  There is no six-cell tile restriction in this layer.
- Explicit perimeter runs (`ports`): side, first inside cell, length in segments,
  passage floor (`required`) and ceiling (`allowed`). Passage classes are `none`,
  `contestant`, `hunter`. A horizontal run advances x; a vertical run advances y.
- Macro-owned rectangular `reservations`, which must remain free of geometry and
  loot, plus optional loot budget/tier.
- Reversible class tuning: `density` in [0,1], integer `roomCells` in [4,12], and
  `decay` in [0,1]. Density adjusts proposals rather than guaranteeing a coverage
  fraction; decay affects ruins. The loot tier is metadata, not implemented weapon
  tier statistics or trap scaling.
- Optional `bodyProfile: 'live' | 'cell'`. Omission retains the legacy `live`
  profile. An `entry` region accepts `entry.count`, from 0 through 64, and uses
  24 when omitted.

Outputs are JSON-compatible `micro-1` artifacts containing the input, resolved
ports, proven clearance routes, placed `ElementTemplate` assemblies, budgeted
loot candidate positions, and counts of actual output and rejected placements.
An entry result also carries `entry.points`, `requested`, `shortfall`, and
`minimumSpacing`; a shortfall is explicit rather than represented by invented
positions.
There are no timestamps, runtime IDs or shared random draws. Named RNG streams
separate structural and decoration draws; cell input order is normalized.

The current defaults are 40 world units per cell, 8 loot candidates, tier 1,
density 0.55, room size 6 cells and decay 0.35. `live` preserves current game
radii of 12/23 and navigation clearance of 14/25 from `map/navigation.ts`.
`cell` is an explicit preview/profile choice: contestant and hunter diameters are
1.25 and 1.75 cells, a doorway is 2 cells, and a contestant-only squeeze is 1.5
cells. This is not a conversion of the sibling's abstract scale. A local artifact
made with `cell` must not silently change the live game's bodies, clearance,
capacity, or spawn rules.

## Geometry and reachability

Unmentioned region boundaries emit nothing. They are ownership boundaries, not
automatic walls or fences. An explicit port produces only its local jambs or
closed span; a contestant-only span is 34 world units in the live profile and
1.5 cells in the cell profile.
An opening permits crossing, while an actual door remains an interactable object.
Roofs belong to room assemblies, never to a whole concave region bounding box.

Before decoration, required entrances are joined inside the mask for each body
class. The local planner tries direct visibility, then a bounded half-cell search.
Every edge is checked as a swept disc: two circles and a convex strip, using
`shape.ts`'s SAT dispatch. It cannot accept a thin wall between clear endpoints.
Routes and entrance approaches are protected from subsequent placements.
This is a conservative sampled planner: finding a path establishes a continuous
clear route; failure does not prove no continuous route exists.

The builder canvas applies whole-assembly placement atomically. Every collider,
roof footprint and reservation must fit the owned cells. Containment checks the
whole shape against missing cells, so a diagonal body cannot bridge a hole merely
because its vertices are inside. Convex polygons and off-grid rotation are supported;
concave collider decomposition and elevation remain separate work. Rectangular
architecture can select contained subrectangles without forcing the whole region
to be rectangular. Invalid placements do not consume IDs or leave half a building.

Loot has at most one candidate per cell, standing room at least the active
contestant clearance, and a route from a required entrance where one exists.
Accepted loot routes stay protected from
later placement. The budget is a cap; constrained regions may provide fewer slots,
and the artifact reports the actual count. No feature is claimed for a missing slot.
Routes through rooms assume unlocked doors can be opened; preview collision starts
with doors closed. There is no claim to validate dynamic player-created obstructions.

`validateMicroRegion` independently checks emitted shapes, canonical boundary
geometry, floor/ceiling crossings, required entrance connectivity, loot and manifest
counts. It does not accept a builder's reachability assertion in lieu of geometry.
The public interface is bounded to 4,096 cells / 64 per axis, 64 ports, 64 loot
slots and 64 entry points; these are tool limits, not desired match dimensions.

### Segment requirements across hierarchy levels

`sdk.ts` now exposes `resolveAccessRequirements` and `validateRegionAccess` from
`access.ts`. They accept the region mask, scale, body profile and `RegionPort`
requirements independently of any builder. The validator takes final collision
shapes and recomputes threshold clearance, interior standing and connections
between every required crossing for each body class. Hunter requirements also
require contestant access. Optional `allowed` passage is a ceiling, not a promise
that the crossing exists or participates in required connectivity.

The current contract locates a centered aperture within a perimeter segment run;
the run is not a promise that every point along its length is open. This retains
the existing two-cell doorway / 1.5-cell squeeze semantics. The validator operates
on these resolved crossing locations. A different crossing placement must be
communicated explicitly rather than inferred from a child's interiors.

`inheritBoundaryPorts(parent, childFootprints)` passes complete parent runs to
their owning children in global cell coordinates. It checks exact ownership and
rejects a run split across multiple children instead of clipping away part of an
obligation. `pairedBoundaryPort` constructs the neighboring side of a selected
inter-child interface. Callers choose these interfaces and content parameters.

After generation, `validateBoundaryComposition(parent, children)` checks inherited
requirements, paired internal contracts, scale, collision containment and each
child's required connectivity against the combined collision geometry. It then
checks the parent's external obligations over the combined result. Children need
only expose their boundary and collision output; the validator needs no knowledge
of their internal generation strategy. It returns errors and fresh route evidence,
and never modifies geometry or repairs a contract. At deeper levels the same
operation applies to each immediate partition (currently up to 16 children).

The existing example builders still protect paths during construction as a useful
heuristic. Correctness is established afterward: `validateMicroRegion` delegates
access checks to the independent utility, and the combined demo runs the child
composition check after generation. Unlocked-door handling remains explicit:
callers pass blockers representing the assumed door state; existing examples
assume unlocked doors can open. A failed sampled route search rejects acceptance
but does not mathematically prove no continuous route exists. This adds SDK
contracts; it does not yet adapt macro artifacts or physically execute explored trees.

## Builders and composition

`builders.ts` shares a parameterized room shell with actual windows, an unlocked
door sized by the active profile and optional shelves. Open ground proposes sparse cover/shelters;
depots propose warehouses and container aisles; courtyards propose a room ring
around clear ground; ruins propose discontinuous walls and rotated convex debris.
Placement counts and tests guard against a builder silently producing no content.

`entry` is deliberately small: after region geometry resolves, it calls the
reusable `spreadPoints` primitive. It samples a bounded half-cell lattice, keeps
only circles fully contained and clear of blockers/reservations, then selects
farthest points with non-overlap at the active contestant clearance. With a
required entrance it also checks each accepted point is reachable from that root.
It reports a shortfall when this sampled placement cannot meet the requested
count. That does not prove maximum packing capacity. It is a local spacing
result, not a proof that a complete match can support that many players.
Entry placement uses the region seed to break ties between equally scored
farthest-point candidates. It preserves the spacing objective and can legitimately
remain unchanged where the best positions are unique. Omitting the optional seed
on the reusable `spreadPoints` primitive retains canonical tie ordering.
Ruin decay now changes intact spans into smaller rotated rubble and adds scatter;
it is not a parameter of the other builders.

`shared/map/micro/sdk.ts` exports the pure reusable layer: region-mask and shape
queries, collision/route helpers, `spreadPoints`, and `microMetrics`, with their
types. It also exports decomposition analysis, immutable region contexts,
candidate allocation, interface discovery, and independent plan validation.
These are mechanics: they describe cells and structural facts, but do not select
the caller's content strategy. It imports neither the builder catalogue nor live
game state, assigns no gameplay IDs, and does not choose a macro plan. It is a source-level
SDK for this project, not a separately published package.

## Child-region decomposition

`createRegionContext` accepts one connected four-neighbor polyomino and freezes a
canonical copy of its cells, reservations, required cells, forbidden cells and
entrance annotations. Analysis is cached by normalized footprint, and `child()`
creates a constrained child context by restricting those annotations. This keeps
context mechanics immutable while callers retain strategy intent.

`analyzeRegion` reports graph and cell facts: connected components, holes and
boundary ownership, articulation cells, maximal contained rectangles, four-neighbor
depth, local straight-run width, monotonicity and rectangularity. Depth and local
width are grid measurements only: neither is a true body-clearance measurement.
Candidate helpers also grow a bounded predicate/cost-controlled region and propose
straight, bounded-width neck cuts. They do not construct a skeleton or delete a
cut from the final ownership plan. Holes are legitimate topology, so a candidate
is not convexified or split into rectangles merely to make it easier to assign.

The caller supplies candidate footprints and generator contracts. Allocation
assigns non-overlapping candidates to compatible generators, rather than treating
geometric convexification as the decomposition objective. A contract uses roles,
tags, area bounds, hole policy and optional rectangularity as hard feasibility;
its `utility` returns named soft score components. `requiredTags` are enforced,
whereas `preferredGenerators` are only candidate metadata. Reserved, assigned and
forbidden cells have separate ownership roles. The remaining connected components
are first-class residual regions, scored for unused area, fragmentation, small
remainders, seams and piece count according to caller policy.

The allocator uses deterministic bounded beam/fork search over bitset claims. It
reports considered/truncated candidates, expansions, budget exhaustion and
per-candidate rejection or non-selection reasons. A retained result is explicitly
non-optimal: a feasible alternative may be absent because of overlap, utility or
beam pruning. The validator independently recomputes ownership, residuals, cuts,
interfaces and score accounting; an optional generator registry additionally
rechecks contract feasibility. It does not certify a physical route, doorway or
optimal allocation.

Shared boundaries are coalesced into straight interface runs. Runs at least the
configured width are portal opportunities for later negotiation, never physical
doors or traversability guarantees. The combined demo now applies an explicit
physical realization policy after allocation; general portal negotiation, sibling
adapters and recursive execution remain unimplemented.

The concrete example in `decomposition/example.ts` supplies the policy and four
consumer contracts. On the 252-cell neck example, defaults select two 120-cell
room footprints and a 12-cell connector grown from a neck cut. Their two shared
boundaries each have one three-cell straight run. The 252-cell ring example instead
selects the intact courtyard footprint, preserving its hole. The same allocator
can prefer less coverage when the caller increases residual-fragmentation cost;
this tradeoff has a dedicated test. None of these choices is hard-coded into the
allocator or asserted globally optimal.

Contexts are bounded to 4,096 cells and 64 cells per axis. Analysis retains at
most 256 maximal rectangles. Allocation evaluates at most 128 candidates against
16 contracts, retains up to 32 beam states, assigns at most 16 pieces, and stops
after 20,000 expansions. The example uses smaller defaults. Cuts are full straight
cross-sections, not a medial-axis or graph-min-cut implementation. Entrance records
are preserved annotations; physical access obligations still need downstream
negotiation and collision checks. Reserved cells remain reserved in a child view;
later-stage reservation consumption and automatic recursive dispatch are not yet
provided.

`composeMicroRegions(specs)` joins up to 16 **supplied** regions in one cell
coordinate system. It refuses overlapping ownership, duplicate identities,
partial boundary ownership and disagreeing paired floor/ceiling contracts.
Shared required entrances are also checked against both regions' combined geometry.
Generation is stable under region ordering. It neither chooses a macro partition
nor proves a required global spawn-to-exit topology: those remain macro duties.
An outside port without a supplied neighbor remains an explicit external boundary.

`adapter.ts` stamps validated assemblies through `placeElement`. It retains roof
ownership and unlocked doors and exposes only the checked loot list as generation
spots. `regionCollisionMap` uses that same adapter for the preview's real movement
and collision queries. It does not start a multiplayer match or alter the default
generator, global RNG order, fixture, snapshot schema or recording version.
The caller owns placement within the arena's world boundary and collision checks
against content outside the supplied regions; local validation cannot establish those.

## Combined decomposition and generation

### Bounded hierarchical exploration

`decomposition/explore.ts` is a strategy-level tree explorer alongside the flat
allocator. Each refinement stores its local plan and partitions its parent exactly;
assigned pieces and residuals can be considered for further refinement. Reserved
and forbidden ground stays terminal. Retaining a piece is an explicit alternative
to subdividing it. Whole-footprint no-op refinements are rejected.

The lab retains a small portfolio under Balanced usefulness, Smaller room groups,
or Preserve large shapes and holes. Objectives score terminal ownership, rather
than double-counting both a parent and its children. Each selected branch exposes
its depth and reason for stopping or refinement. The example proposal family adds
midpoint rectangle splits to the existing room/courtyard/lobe proposals; this is
not a universal rectangle decomposition rule.

Search depth is capped at three, retained alternatives at eight and expansions at
64 (lab defaults: two, four and 24). A `decomposition-exploration-1` export preserves
the retained trees and named score components, with explicit non-optimal search
diagnostics. This explores structural allocation hierarchies, not recursive physical
generation. General dispatch, portal negotiation and macro integration remain separate.

### Physical demonstration policy

`decomposition/realize.ts` is an example strategy adapter, outside the generic SDK.
It maps rectangular rooms to depots (optionally open ground or ruins), courtyard
rings to courtyards, generic lobes to ruins, and circulation/residual regions to
clear entry geometry with zero spawns. It preserves the plan's cell ownership.
For each shared interface it opens one centered two-cell hunter passage in the
longest eligible straight run and seals the other runs. An interface without a
two-cell opportunity fails explicitly. External macro entrances are rejected until
an adapter can preserve their obligations; reserved/forbidden cells stay excluded.

The `realized-decomposition-1` artifact includes the original plan, assignments,
generated children, paired physical portals, anchors and swept routes connecting
all children for both body sizes. Validation rechecks ownership, local geometry,
portal pairs and those routes. Unlocked doors are assumed open for route proofs;
the walking preview starts with doors closed. This is static connectivity of the
generated children, not a whole-match spawn-to-exit guarantee.

`decomposition/preview.ts` stamps the children into one collision map and adds
tool-only collision around missing cells and holes. Those bounds are not exported
architecture. The default neck demo produces two populated room regions joined
through a circulation region. Content seeds and density vary micro generation
without changing the selected decomposition.

## Inspect and verify

Run `npm run dev` and open `http://localhost:3000/micro-lab.html`; use the actual
port printed by the server when 3000 is occupied. Choose class, profile, shape and
seed, tune the parameters, inspect roofs/ports/clearance, walk as either body with
WASD, open doors with E, and download the result. The lab defaults to the cell
profile, displays the diameters/doorway/squeeze in cells, and draws numbered entry
positions. It imports either a `RegionSpec` or a validated `micro-1` result; an
imported result remains the downloaded artifact until a new example is generated.
This page is a development preview.
Example controls now apply automatically; sliders use a short debounce. Controls
that do not affect the selected builder are disabled. Imported artifacts remain
intact until a control generates a new example or a new artifact is imported.

```powershell
node tools/micro-region.mjs --builder=depot --seed=42 --out=test-results/region.json
node tools/micro-region.mjs --builder=entry --profile=cell --count=24 --out=test-results/entry.json
node tools/micro-region.mjs --validate=test-results/region.json
node tools/micro-region.mjs --builder=courtyard --shape=hole --batch=20
node tools/micro-region.mjs --spec=region-spec.json --out=region.json
node tools/micro-region.mjs --layout=region-spec-list.json --out=layout.json
node tools/decompose-region.mjs --shape=neck --out=test-results/decomposition.json --beam=8 --residual-penalty=10 --piece-penalty=3
node tools/decompose-region.mjs --validate=test-results/decomposition.json
node --test tests/micro-*.test.js
node tests/micro-lab.mjs
node tests/decomposition-lab.mjs
node tests/generation-demo.mjs
```

The CLI, browser and adapter share the core. `--profile=cell|live` and `--count=N`
set the generated example's profile and entry count. `examples.ts` contains hand-authored
macro inputs for the tools, not a second generation algorithm. The focused suite
includes four builders × three masks × eight seeds, tuning extremes, actual
roof/loot counts, thin-wall swept collisions, real-body squeezes, deliberately
broken artifacts, and adjacent-region contract conflicts. Broader acceptance is
in [31](31-verification.md). `decompose-region` emits or validates a
`decomposition-1` plan; `--shape`, `--spec`, `--beam`, `--residual-penalty` and
`--piece-penalty` select its example/context and caller policy. The decomposition
lab at `/decomposition-lab.html` is an allocation visual inspector: its seams and
portal opportunities are structural, not physical geometry. `/micro-lab.html`
continues to inspect and walk actual micro geometry. Decomposition controls apply
automatically; presets demonstrate different allocation policies, while status
explains unchanged winners. Advanced search settings are not style controls.

Open `/generation-demo.html` for Region, Decomposition, Generated and Walk stages
of the same example. Inspect each child's assignment and geometry, vary contents,
seed and density, show seams/routes/roofs, and export the combined artifact. Walk
uses the game's actual collision movement; WASD/arrows move and E operates doors.
Ownership outlines distinguish region perimeters from decorative grid gutters;
these are drawn separately from the generated walls and roofs.
`npm run test:micro` runs the focused unit tests and all three browser previews,
including actual movement across a child-region join.

## Next boundaries

Feature-region placement beyond local entry spacing, primitive material sets, and
authored segment/vertex metadata still need expansion. The next decomposition
boundary is generalized generator dispatch and portal negotiation beyond the
explicit demo policy, followed by a sibling adapter and recursive execution.

The sibling `../last_exit_map` is read-only input for a future adapter. At current
head `544b13c`, its compact post-composition region artifact is defined by
`src/types.ts` (`MapRegion`) and packed by `src/artifact.ts`; `src/core.ts`
discovers regions from same-class cells and fully open segments, then re-discovers
them after its own micro edits. Its planned `src/plan/types.ts` has the closer
floor/ceiling port vocabulary, but is not this SDK. An adapter must translate its
flat cell indices using its grid width into this SDK's global integer cell
coordinates, preserve explicit `cellSize`, turn planned perimeter runs into
`RegionPort`s, keep source-region provenance separate from its final partition,
and validate world bounds, external geometry, and whole-map spawn-to-exit routes.
It must not treat sibling graph or sampled connectivity as proof of this game's
physical geometry. The existing generator remains live until that explicit
integration checkpoint is satisfied.
