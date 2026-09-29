# The generation chain: specification

Status: proposed, 2026-09-28. Written for Corey's review before any code.

This specification is for rebuilding map generation as a series of checkpoints
with clear interfaces between them. The pipeline is new, and it reuses the
existing leaf modules. The old paths (`core.generateMap` and
`plan/compose.generatePlannedMap`) keep working until the new chain replaces
them. Then they are deleted rather than kept as legacy.

Direction it follows (Corey, 2026-09-28):

- "maybe we keep what we currently have, but now that we have a better
  understanding we also just try implementing from scratch the whole series
  of transformers, defining clear interfaces between the layers' transforms,
  and then implementing within them."
- "a series of transforms to new classes of objects, some very superficially
  similar, and perhaps relegated to a 'view' over the primitive data
  structure."
- The interfaces are "somewhat like transformation checkpoints", and they
  "resolve conflation of things with the same name like the declaration of
  passability versus the knowledge of what segments are passable".
- Set pieces keep "the same distribution as before", chosen from set piece
  classes.
- Features belong to set piece classes, "which are the only things we give
  first class status in the engine". A new set piece class owns charging
  stations. The hierarchy: "set piece classes are sets of set pieces, which
  are layouts of tile sets, which are sets of tiles, sometimes with just one."
- A region type's builder is responsible for the features. Authors make sure
  every set piece in a class forms regions that satisfy it, and macro knows a
  feature exists only by trusting the set piece class. Nothing checks this at
  load; it can be checked only after every builder has run. Hunter spawn goes
  with `end` for now, and one charger per map is enough for now.
- Playground mode "is just supposed to make our lives easier. It's a debug /
  development feature that needs to evolve."
- Macro prescribes no geometry. Walls and fences go from the library for now
  and may come back later.
- The rest is left to the architect: "My architectural directives have been
  suggestive and the most concrete thing I've prescribed is clear interfaces
  between different layers / views of map generation."

design_notes.txt still takes precedence. Where this document and
DESIGN_DECISIONS disagree about the new chain, this document holds until the
chain lands and DESIGN_DECISIONS is rewritten to match.

## Principles

1. **Checkpoints.** Each stage is a pure function from named objects to one
   new named object. It reads nothing a later stage writes, changes none of its
   inputs, and draws randomness only from streams named for itself. Every
   checkpoint's output can be checked on its own terms. It's valid or it isn't,
   before anything later runs.
2. **Three kinds of truth, never confused.** Each fact about the map passes
   through up to three stages, and each stage has its own name for it:
   - A **prescription** is what a design states. It is declarative, and it
     belongs to the tile or set piece. Example: "this segment is prescribed
     passable".
   - A **guarantee** is what a solved, valid layout promises before anything is
     built. It is knowledge derived from prescriptions once placement is solved.
     Example: "this segment is guaranteed passable", or "these regions are
     proven connected".
   - A **measurement** is what the finished map actually has. Example: "a hunter
     reached this region on the lattice".

   Builders honour guarantees, and validation compares measurements against
   them.
3. **Objects and views.** An **object** is a checkpoint's output that holds
   decisions (random draws, solver choices, builder output). Objects are what
   can be saved. A **view** is a pure reading of objects, always recomputed and
   never stored, and it needs no provenance of its own. If something can be
   derived from objects cheaply, it is a view.
4. **One name, one meaning.** Every term below has exactly one meaning, and
   each stage's output has its own type even when the shape matches another's.
   A declared class grid and a resolved class grid are different types.
5. **Regions are independent.** A builder reads only its own brief, and
   composing interiors is order-free. Changing one region's seed changes only
   that region.
6. **Macro prescribes no geometry.** Tiles and set pieces paint cell classes
   and state prescriptions. Everything physical is built by region builders.

## Names

Each term has one meaning. Terms retired from the old code are listed so they
don't come back with a second meaning.

| Term | Means | Stage |
| --- | --- | --- |
| **declared class** | The class a design paints on a cell, `any` allowed | Library, Placement |
| **resolved class** | A declared class with every `any` settled; never `any` | Resolution |
| **built class** | A resolved class with what a builder laid over it (e.g. `solid`) | Composition |
| **passability prescription** | What a design states about crossing a segment: `passable`, `any`, or unstated | Library |
| **passability guarantee** | Whether a solved layout promises a segment passable: `guaranteed` or `none` | Resolution |
| **adjacency prescription** | The class a design requires of the cell across one of its perimeter segments | Library |
| **layout region** | A maximal 4-connected set of cells with one resolved class | Regions |
| **built region** | The same search over built classes and built segments, after micro | Composition |
| **boundary** | A maximal straight run of segments between two layout regions, or between a region and the map's outside | Regions |
| **passable run** | A maximal contiguous stretch of guaranteed-passable segments along one boundary | Regions |
| **brief** | Everything one region's builder is handed | Briefs |
| **interior** | What one region's builder returns | Build |
| **tile design** | One 6 × 6 tile the library holds | Library |
| **tile set** | A set of tile designs, sometimes just one | Library |
| **set piece** | A layout of tile sets: slots at tile offsets, each naming a tile set | Library |
| **set piece class** | A set of set pieces, with a placement rule and a quota, and the features it owns. The only first-class macro structure. The code calls it `category` today | Library, Placement |
| **set piece instance** | One placed copy of a set piece: which one, and the slots it covers | Placement |
| **feature** | A spawn, hunter spawn, exit, charger or warp. The builder of a region type sites it; macro knows only that a set piece class promises it | Build, Measurement |
| **primary region class** | The cell class a set piece is mainly meant to form; an editor default, unread by generation | Library |

Retired, or confined to the old paths until they're deleted:
- `open` as a segment label. `open` is only a cell class.
- a set piece's own `class` field. It means the primary region class (Corey,
  2026-09-28): "a suggested 'default' or primary region class/type", whose
  main effect is to give the editor a default cell class. Generation doesn't
  read it, and two of its four values in the shipped library (`industrial`,
  `military`) aren't declared cell classes. The converter renames it
  `primaryRegionClass`, keeps the values that name a declared cell class, and
  reports the rest. "Class" alone now means a cell class; the grouping is
  always "set piece class".
- `ports`: the unread tile side sockets, and the planned path's `PerimeterPort`.
- `edges`, whether as design side strings or as `MapEdge` seams.
- **structure** (`MapStructure`, and `MacroStructure` in `macro.ts`).
- anchors.
- streets and blocks.
- floors and ceilings.
- `walls`, `gap` and segment spans in the library.

## The chain

```
Library ─┐
seed ────┼─► Placement ─► Layout ─► Resolution ─► ResolvedLayout ─► Regions ─► LayoutRegions
params ──┘                (object)                (view)                       (view)
                                                                                 │
                                          Proof ◄────────────────────────────────┤
                                          (view)                                 ▼
                                                                    Briefs ─► RegionBrief[] (view)
                                                                                 │ one per region
                                                                                 ▼
                                                                    Build ─► RegionInterior[] (object)
                                                                                 │
                                           Layout + ResolvedLayout + interiors ─►Composition ─► BuiltMap (view)
                                                                                 │
                                                                                 ▼
                                                                    Measurement ─► Report (view)
```

Only two things hold decisions: the **Layout** (placement's draws) and the
**interiors** (the builders' output). Everything else is a view. A saved map is
therefore a Layout, optionally with its interiors (see "Saving").

## Stages

### 0. Library (input, all prescriptions)

- **Tile design:**
  - A declared class for each of its 36 cells (`any` allowed).
  - For each perimeter segment, an **adjacency prescription**: the class
    required of the neighbour's cell, or `any`.
  - For any segment, perimeter or interior, a **passability prescription**:
    `passable` or `any`. Leaving a segment unstated is recorded as its own
    value.
  - Orientations, eligible tiers and bonus, and labels, as today.
- **Set piece classes, set pieces, tile sets and tile designs**, in that
  hierarchy. Placement is unchanged: the same quotas, zone filters and
  distribution.
  - Set piece classes are declared in the library, not a closed list in code.
    Each names the engine placement rule it uses (today's `start`, `end`,
    `enormous`, `medium`, `small`) and the features it owns.
  - A new **`charger`** class owns charging stations. It needs at least one
    charger set piece authored. Until then a map has no charger, as the tile
    path has none today.
- **No geometry.** There are no walls, gaps, spans or fences. The six walled
  fence tiles (`depot-*`, `evac-*`) lose their walls when converted and keep
  their classes.
- **No impassable prescription.** Without macro geometry, nothing could honour
  one, and builders aren't asked to (Corey, 2026-09-27). A suggestion channel
  for builders is deferred.
- **Validity:** every declared class is registered, and every prescription is
  well formed. A passable run that lies wholly inside a tile, without reaching
  the tile's edge, must already be at least a hunter wide, because no
  neighbour can lengthen it. This is the #73 design check.
- **Conversion:** a one-time converter turns today's library into this
  schema:
  - `edges` class words become adjacency prescriptions.
  - `open` in `edges` becomes passable.
  - `walls` and `ports` are dropped.

  It reports every design it changed. The library gets a new version number.

### 1. Placement: seed, params, library → **Layout** (object)

- **Holds:**
  - seed, params and library fingerprint
  - each slot's design and orientation
  - the **set piece instances**: which set piece, of which class, covering
    which slots. Today's layout keeps only the set piece's id per slot, so two
    copies of one piece can't be told apart. Measurement needs to know which
    class instances were placed, to check what their classes promise.

  Nothing else. The primitive grid isn't stored; it's a view (below).
- **Solver:**
  - Set pieces first, exactly as today: each class's rule places its quota.
    That rule is what guarantees every owned feature exists.
  - Then WFC for the remaining slots, over adjacency compatibility: a
    neighbour's cell must match each adjacency prescription, or be `any`.
  - Passability prescriptions can't conflict, since neither side can say
    impassable, so they never constrain the solve.
- **Randomness:** only placement's named streams. The same retry loop, with a
  per-attempt stream.
- **Validity:** every adjacency prescription is met, and no `any` cell is asked
  for two different classes.
- **Later:** the open-face rule (#59) runs here as the incremental form of the
  reachability proof, over guarantees as slots are placed.
- **View, `DeclaredGrid`:** the Layout plus the library gives each cell's
  declared class, and each segment's prescriptions from the design on each
  side, kept separate, not merged.

### 2. Resolution: Layout + library → **ResolvedLayout** (view)

This is the knowledge layer: what the solved placement means.

- **Resolved classes:** a declared class stands. An `any` cell takes the class
  its neighbours' adjacency prescriptions require, and otherwise `open`.
- **Passability guarantees:** a segment is `guaranteed` if either side
  prescribes `passable`, and otherwise `none`. What each side stated
  (`passable`, `any`, unstated) is kept alongside, as provenance for later
  steps and open questions.
- **Why it's a view:** nothing is decided here, so there's nothing to save.

### 3. Regions: ResolvedLayout → **LayoutRegions** (view)

- **Layout regions:** maximal 4-connected sets of cells with one resolved
  class. No segment splits a region, because macro states no geometry. Ids and
  seeds are functions of each region's own cells and the map seed.
- **Boundaries:** `findBoundaries` (lifted from `plan/ports.ts`) gives maximal
  straight runs between each pair of regions, split at corners and wherever the
  region across changes. A run facing the map's outside is included.
- **Passable runs:** the guaranteed stretches of each boundary.
- **Validity:** every passable run is at least `ceil(2 × hunterRadius)`
  segments long (#73). A run may cross a tile seam, since boundaries ignore
  tiles.
- **Region graph:** each region is a node. Two regions are joined when a
  boundary between them has a passable run.

### 4. Proof: LayoutRegions → **ReachabilityProof** (view)

- **Holds:** a union-find over the region graph, giving the components that
  guarantees connect. This is `proveReachability`, adapted from planned floors
  to guarantees. Which region will hold a feature isn't known before micro, so
  the proof names no feature regions.
- **Meaning:** a claim about guarantees, not geometry. It holds for a built
  map only because each builder keeps its guarantees (stage 6), and the
  measurement checks it (stage 8).
- **Gate:** none for now; the proof is reported. Measurement is the gate (see
  QUESTIONS "The chain rebuild" item 2). The shipped library prescribes
  nothing passable yet, so the proof has nothing to connect until designs do.

### 5. Briefs: Layout, LayoutRegions, zones → **RegionBrief[]** (view)

One brief per layout region, as plain data:

- region id, resolved class, the class rule (builder and parameters), cells,
  and seed
- **zone context:** each cell's tier, bonus and loot chance
- **obligations:**
  - every guaranteed-passable segment in or on the region stays passable
  - all its passable runs stay mutually reachable at hunter size

A brief never mentions another region's contents. A decomposing region type
(#76) splits its own brief into sub-briefs inside its build. That isn't a
stage.

### 6. Build: each RegionBrief → **RegionInterior** (object)

- **Holds:**
  - the classes it lays on its own cells
  - the spans it states on segments with at least one side in its cells
  - props (containment as today)
  - spawns and feature sites, in its own cells
  - a manifest
- **Write scope:** a builder writes only its own cells, and only segments
  touching them. It never narrows a guaranteed-passable segment.
- **Conform:** `conform` checks each interior against its own brief
  (containment, obligations) before composition. This is the minimum-passage
  check from `micro/conform.ts`, without maximums.
- **Builders:** the existing catalogue, called through a brief-to-context
  adapter.

### 7. Composition: Layout, ResolvedLayout, interiors → **BuiltMap** (view)

- **Built classes:** resolved classes with each interior's cells laid over
  them.
- **Built segments:** a segment between two cells on the map starts open, and
  one facing the map's outside is closed. A segment inside one region
  takes that region's statement. A boundary segment takes the **intersection**
  of what its two sides stated. Intersection is commutative, so build order
  can't matter. Guaranteed segments were left open by both sides, so they stay
  open.
- **Also holds:** props, features (from interiors), navigation walls, and
  built regions (a search over built classes and built segments).

### 8. Measurement: BuiltMap, proof, Layout → **Report** (view)

- **Features:** the map has a spawn, a hunter spawn, at least one exit, and a
  charger when a charger instance was placed. This is the first point at which
  the set piece classes' promise can be checked (see "Features").

- **Lattice validation:** a hunter reaches every built region that has
  standing room, starting from the spawn. This replaces "every tile anchor
  reached".
- **Also checked:**
  - a contestant can reach every exit
  - the proof agrees with the measurement: every proven-connected region is
    reached
  - every interior conformed
- **Metrics:** measured from the built map, not from a tile graph.

## Features

Features are spawn, hunter spawn, exits, charger and warp. **Features belong
to set piece classes** (Corey, 2026-09-28). The set piece class is the only
macro structure the engine treats as first class.

| Feature | Set piece class | Today |
| --- | --- | --- |
| spawn | `start` | the anchor of the lowest slot in the left third, unrelated to set pieces |
| exits | `end` | anchors of `exitCount` slots in the right third |
| hunter spawn | `end`, for simplicity for now | the anchor of the rightmost slot |
| charger | `charger` (new), one per map for now | none on the tile path |
| warp | deferred | none |

Who is responsible for what:

- **Macro** places each class's quota by its placement rule. That is all macro
  knows about features: a placed class instance is trusted to deliver the
  features its class promises. Macro doesn't pick a region, a cell or a point.
- **The authors** make sure every set piece in a class forms at least one
  region whose type delivers the class's features.
- **The builder of a region type** sites the features that type is for, inside
  its own region, and returns them in its interior. For example, the builder
  of the region type the `start` pieces form sites the spawn.
- **Measurement** is the first and only check (stage 8). Nothing validates at
  library load that a set piece class delivers its features, and nothing can
  until micro is complete.

Anchors go. They stood in for "somewhere in this tile a body can stand", and
the builders now choose that inside their own regions.

## Playground mode

A development aid that is expected to evolve (Corey, 2026-09-28). It isn't
part of this contract. Its only promise is that it goes through the same
stages and the same validation. It may relax placement rules, quotas and zone
sizes however it needs to.

## What the finished map is

The generated map is a container holding the two stage objects, the Layout and
the interiors, plus the library it was made with. Every other stage output is
a view computed on demand (#69), such as the resolved layout, the regions, the
proof, the briefs, the built map and the report. The GUI, CLI and MCP read views through one accessor, not
through fields copied into the map.

## Saving

A save holds the Layout and, optionally, the interiors. Each records its inputs
and the version of the algorithm that made it. A missing interior is rebuilt
from the Layout and refused by name on a version mismatch (#70, QUESTIONS
"Saving a map"). Views are never saved. The wire version is bumped, and old
artifacts are refused by name.

## Reused as they are, or lifted

- `primitives.ts` and `tiles.ts` parsing, rewritten for the new schema
- `wfc.ts` (compatibility changes)
- set piece selection (lifted out of `placeLayout`)
- `makeZones`
- `findBoundaries` and `proveReachability`
- the micro builder catalogue, mask, canvas and clearance
- `conform` (the minimum-passage half)
- the navigation lattice
- `coding.ts`, the wire form and BSON
- the sweep and determinism harness
- the Map Lab, CLI and MCP (through the accessor)

## Retired when the chain lands

- `planStreets` and blocks
- standing room
- anchors and the tile-graph metrics
- `composeMacro` and the macro structure contract (`macro.ts`, MACRO_STRUCTURES.md)
- the whole planned path except the two lifted functions:
  - partition
  - port bands and ceilings
  - `enforcePorts`
  - loot planning (`LootCriteria` returns if loot becomes a macro concern)
- tile side `ports`
- library geometry

## Build order

Each step is its own issue and PR. Steps 2 to 8 build the new chain beside the
old paths without touching them.

1. This specification, reviewed.
2. The library schema and converter, with the new `validateLibrary`. This
   includes declared set piece classes with their owned features, and the
   `charger` class. The converter's report of changed designs goes on the
   issue (#33 lands here). Charger content is authored separately.
3. `chain/types.ts`: every object and view named in this document, with
   interfaces only, plus purity and determinism test harnesses.
4. Placement.
5. Resolution and Regions, including the run check (#73's logic, rebuilt on
   `findBoundaries`).
6. Proof.
7. Briefs, Build (the builder adapter, conform, and features sited by
   builders), and Composition (#68, #76).
8. Measurement.
9. The map container, the accessor, saving and the wire version (#69, #70).
10. Switch the Map Lab, CLI and MCP over. Capture the first baseline of the
    new chain, then delete the old paths.

Content is expected to change. The old #47 baseline is no reference for the
new chain. The bar is that validation passes and maps play acceptably, and
then the new chain's first baseline is captured, last.

## In-flight work

| Issue | Becomes |
| --- | --- |
| #33 segment prescriptions | step 2 |
| #73 / PR #78 | parked; its labels and run check move to steps 2 and 5 |
| #79 stage types and views | step 3 (this document is its design) |
| #68 independent builders | step 7 |
| #76 streets retire, region handed whole | step 7 |
| #69 map container | step 9 |
| #70 saving with provenance | step 9 |
| #71 planned path joins the chain | closed: the planned path is retired |
| #59 reachability contract | step 6, then the open-face rule in step 4 |
| #61 `open` is privileged | an obligation on `open` briefs, after step 7 |
