# 51. The generation chain

Status: accepted 2026-09-28 (PR #80). Integrated with the game's micro half
2026-09-29 (50). Not implemented.

This file specifies map generation as a series of checkpoints with clear
interfaces between them. mapgen owns the macro stages, 0 to 5 and the map-level
part of 8. The game owns what happens inside a region, stages 6 and 7 (50).
The pipeline is new, and it reuses existing leaf modules on both sides.

mapgen's old generators, `generateMap` and `generatePlannedMap`, keep working
until the switch-over (step 10). Then they're deleted, not kept as legacy. The
archived mapgen docs in `map/macro/docs/archive/pre-integration/` describe them;
where they disagree with this file about the chain, this file holds.

Corey's directions for the chain (2026-09-28 and 29), verbatim in 17 "Map
generation":
- rebuild generation as a series of transforms with clear interfaces
- name superficially similar objects apart, and make pure readings views
- set pieces keep their distribution, and core elements belong to set piece classes
- region types' builders deliver the core elements
- macro prescribes no geometry
- the library is authored fresh against a region type catalogue

`map/macro/design_notes.txt` is the original statement of intent. Corey's later answers in 17 and the accepted model in 51 govern where they differ. For example, the notes describe segment-aligned fences and doors, and 17 records that macro prescribes no geometry for now.

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
   - A **measurement** is what the built map actually has. Example: "a hunter
     reached this area in the built geometry".

   Prescriptions and guarantees are for macro's reasoning. Region
   strategies promise to honour guarantees, and nothing enforces it (principle
   9).
3. **Objects and views.** An **object** is a checkpoint's output that holds
   decisions (random draws, solver choices, builder output). Objects are what
   can be saved. A **view** is a pure reading of objects, always recomputed and
   never stored, and it needs no provenance of its own. If something can be
   derived from objects cheaply, it is a view.
4. **One name, one meaning.** Every term below has exactly one meaning, and
   each stage's output has its own type even when the shape matches another's.
   A declared class grid and a resolved class grid are different types.
5. **Regions are independent.** A region's strategy reads only its own brief
   and places geometry only inside its own cells, so composing regions is
   order-free. Changing one region's seed changes only that region.
6. **Macro prescribes no geometry.** Tiles and set pieces paint cell classes
   and state prescriptions. Everything physical is built by region strategies.
7. **Each level solves its own problems.** Macro and micro face similar
   problems, such as boundary runs, connectivity and reachability, and each
   solves them within its own scope (Corey, 2026-09-29):
   - Macro works across the whole map, on layout regions and guarantees,
     before anything is built.
   - Micro works inside one region, on its children and its geometry.

   The same problem at the same level has one home. What macro and micro
   must share, such as the contract between them, body scale and the
   definition of a run, lives in a **shared map space** that neither level
   owns (50, 17 M1).
8. **Reachability is a chain of inference** through guarantees at each
   level (Corey, 2026-09-29):
   - Macro proves layout regions connected by guarantees.
   - Each region's strategy guarantees its own portals are mutually
     reachable, and its children's the same way, all the way down.
   - Each link is a promise its level keeps. Nothing floods the whole map to
     establish reachability.
9. **Contracts are promises, not enforcement** (Corey, 2026-09-29):
   - The pipeline doesn't validate builders or enforce anything on them. A
     builder's internals are its own business.
   - The only promise is passability between a region's portals. Everything
     else inside a region, including where its core elements and loot sit, is
     the builder's business.
   - A builder that doesn't reliably meet its passability promise is
     defective. That breaks the macro contract, and it is a **non-local
     defect**. It can be a source of failure somewhere else, though not
     necessarily one: anything that relies on macro's assumptions, such as a
     nav mesh built over the final geometry, or whole-map processing or
     validation after the regions are generated.
     There's no uniform enforcement on region building itself, so the defect
     is either noticed from outside or not.
   - The micro SDK offers validation utilities, which a builder may use or not
     (**elective**). A special region type whose mechanics break the SDK's
     assumptions validates however it chooses, or not at all.
   - General design guidelines that typical builders follow may be written
     later.

## Names

Each term has one meaning. 52 defines the library's terms in full.

| Term | Means | Stage |
| --- | --- | --- |
| **declared class** | The class a design paints on a cell, `any` allowed | Library, Placement |
| **resolved class** | A declared class with every `any` settled; never `any` | Resolution |
| **region type** | What a resolved class names: the strategy (decomposer and builders) that fills a region of that class, in `map/micro/` | Library, Build |
| **passability prescription** | What a design states about crossing a segment: `passable`, `any`, or unstated | Library |
| **passability guarantee** | Whether a solved layout promises a segment passable: `guaranteed` or `none` | Resolution |
| **adjacency prescription** | The class a design requires of the cell across one of its perimeter segments | Library |
| **layout region** | A maximal 4-connected set of cells with one resolved class | Regions |
| **boundary** | A maximal straight run of segments between two layout regions; the same definition of a run as the SDK's interface runs between a region's children | Regions |
| **portal** | A maximal contiguous stretch of guaranteed-passable segments along one boundary. **Derived, never authored.** At macro level it comes from the designs' passable prescriptions; inside a region, from the strategy's own decisions about its children. It says what must stay passable, and is what validation checks, but places no geometry (Corey, 2026-09-29, M3) | Regions, Briefs, Build |
| **brief** | Everything one region's strategy is handed, expressed in the macro/micro contract (`map/kernel/contract.ts`) | Briefs |
| **region result** | What one region's strategy returns, in the contract's result type | Build |
| **built map** | Every region result composed into one map of the game's geometry | Composition |
| **tile design**, **tile set**, **set piece**, **set piece class**, **core element class**, **primary region class** | See 52 | Library |
| **set piece instance** | One placed copy of a set piece: which one, and the slots it covers | Placement |
| **core element** | A spawn, hunter spawn, exit, charger or warp: a required thing a set piece class promises and the report counts. A region type's strategy sites it; macro knows only that a set piece class promises it. Formerly "feature" (17, 2026-10-01). Optional objects with special mechanics are a separate, later term | Build, Measurement |

Retired, and confined to the old paths until they're deleted:
- `open` as a segment label. `open` is only a cell class.
- a set piece's own `class` field (52 calls it the primary region class).
- `ports`: the unread tile side sockets, and the planned path's `PerimeterPort`.
- `edges`, whether as design side strings or as `MapEdge` seams.
- **structure** (`MapStructure`, and `MacroStructure` in `macro.ts`).
- anchors.
- streets and blocks.
- floors and ceilings, and sealed runs (17 M4; deferred in 16).
- `walls`, `gap` and segment spans in the library.
- mapgen's micro layer (`src/micro/`), and its "interiors" of laid classes and
  segments.
- "feature" for a core element. The old paths keep the word until they go.

## The chain

```
Library ─┐
seed ────┼─► Placement ─► Layout ─► Resolution ─► ResolvedLayout ─► Regions ─► LayoutRegions
params ──┘                (object)                (view)                       (view)
                                                                                 │
                                          Proof ◄────────────────────────────────┤
                                          (view)                                 ▼
                                                                    Briefs ─► RegionBrief[] (view)
─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ mapgen above, the game below (50) ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─
                                                                                 ▼ one per region
                                                                    Build ─► RegionResult[] (object)
                                                                                 │
                                                                    Composition ─► BuiltMap (view)
                                                                                 │
                                                                                 ▼
                                                                    Measurement ─► Report (view)
```

Only two things hold decisions: the **Layout** (placement's draws) and the
**region results** (the strategies' output). Everything else is a view. A
saved map is therefore a Layout, optionally with its region results (see
"Saving").

## Stages

### 0. Library (input, all prescriptions)

52 defines the library. What the chain relies on:

- **Tile designs** carry a declared class per cell, adjacency prescriptions on
  perimeter segments, and passability prescriptions (`passable`, `any`, or
  unstated) on any segment.
- **Cell classes** each name a region type, with its parameters. A class's rule
  also lists the **core elements** its strategy sites. For example,
  `contestantCount` spawns, or `exitCount` exits. This is the only way a core element reaches a strategy: in its
  brief, through its class rule. Macro places no points.
- **Set piece classes** are declared in the library. Each names the engine
  placement rule it uses (today's `start`, `end`, `enormous`, `medium`,
  `small`, plus the new `charger`) and the core elements it owns, each with a count
  per instance (a number, or a param: `exitCount`, `contestantCount` or
  `hunterCount`).
- **No geometry and no impassable prescription.** Without macro geometry,
  nothing could honour one, and strategies aren't asked to (Corey, 2026-09-27).
  A suggestion channel for builders is deferred (16).
- **Validity:** every declared class is registered and names a region type,
  and every prescription is well formed. A core element count is a positive whole
  number or a count param (`exitCount`, `contestantCount`, `hunterCount`), and the params'
  values for them are whole numbers. There
  is no ceiling: how many a strategy can site is its own concern, and the
  report finds any it misses (stage 8). Tile sets and set piece classes are
  sets, so neither lists a member twice. A set piece slot that fixes an
  orientation must name a tile set with a member allowing it. A stretch of passable prescriptions
  that lies wholly inside a tile, without reaching the tile's edge, must
  already be at least a hunter wide, because no neighbour can lengthen the
  portal it will become. This is the #73 design check.
- **A new library, authored fresh** against the region type catalogue (track
  B). Today's library stays with the old paths and retires with them.

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
    That rule is what guarantees every owned core element exists.
  - Then WFC for the remaining slots, over adjacency compatibility: a
    neighbour's cell must match each adjacency prescription, or be `any`.
  - Passability prescriptions can't conflict, since neither side can say
    impassable, so they never constrain the solve.
- **Randomness:** only placement's named streams. The same retry loop, with a
  per-attempt stream.
- **Validity:** every adjacency prescription is met, and no `any` cell is asked
  for two different classes.
- **Reachability:** the open-face rule is the proof's gate and the portal
  rule in incremental form, over guarantees as slots are placed (step 4,
  #113). A placement is refused when it seals a component that isn't the whole
  map, or when it settles a portal shorter than a hunter. So placement never
  returns a layout that `proofViolations` or `portalViolations` would refuse.
- **View, `DeclaredGrid`:** the Layout plus the library gives each cell's
  declared class, and each segment's prescriptions from the design on each
  side, kept separate, not merged.

### 2. Resolution: Layout + library → **ResolvedLayout** (view)

This is the knowledge layer: what the solved placement means.

- **Resolved classes:** a declared class stands. An `any` cell takes the class
  its neighbours' adjacency prescriptions require, and otherwise `open`.
- **Passability guarantees:** a segment between two cells on the map is
  `guaranteed` if either side prescribes `passable`, and otherwise `none`. A
  segment facing the map's outside is always `none`, whatever its design
  prescribes: nothing is across it. So a design placed at the map's edge is
  valid, and its outward prescription just doesn't become a guarantee. What
  each side stated (`passable`, `any`, unstated) is kept alongside, as
  provenance for later steps and open questions.
- **Why it's a view:** nothing is decided here, so there's nothing to save.

### 3. Regions: ResolvedLayout → **LayoutRegions** (view)

- **Layout regions:** maximal 4-connected sets of cells with one resolved
  class. No segment splits a region, because macro states no geometry. Ids and
  seeds are functions of each region's own cells and the map seed.
- **Boundaries:** maximal straight runs of shared segments between each pair
  of layout regions, split at corners and wherever the region across changes.
  - Macro finds them with the kernel's `boundaryRuns` (`map/kernel/run.ts`),
    the reference finder that the SDK's `buildInterfaces` also builds on. It
    fits the whole map's scale: on a game map of 64,800 cells and about 300
    regions it takes 14 to 27 ms (step 5). Guarantees are laid over its runs
    afterwards, so macro needs no finder of its own, and mapgen's
    `findBoundaries` and #73's `passableRuns` retire with the old paths.
  - A boundary becomes a region's external run in its brief, so macro's runs
    and the SDK's definition must agree. A test runs every `RUN_CASES` case
    through the regions stage.
  - Runs facing the map's outside aren't boundaries, since they never carry a
    guarantee.
- **Guarantees inside a region:** a guaranteed segment with the same region
  on both sides lies on no boundary. It forms no portal, obliges no strategy,
  and adds nothing to the proof (17 M8). The Map Lab flags it, because it
  promises nothing (B1).
- **Portals** (derived): the guaranteed stretches of each boundary. Authors
  write passable prescriptions, not portals, but they design those sections
  with the portals they will form in mind (Corey, 2026-09-29). So the Map Lab
  shows the portals a design or layout would derive (B1).
- **Validity:** a portal is passable only if a hunter can pass through its
  own geometry (Corey, 2026-09-29):
  - It is straight. Two passable segments meeting at a right angle don't form
    a portal a hunter can pass through, so they don't count as one.
  - It is at least `ceil(2 × hunterRadius)` segments long (#73), with the
    hunter's size from one body scale (17 M5).

  A passable prescription that forms no such portal makes the layout invalid,
  as before. A portal may cross a tile seam, since boundaries ignore tiles.
- **Region graph:** each region is a node. Two regions are joined when a
  boundary between them has a portal.

### 4. Proof: LayoutRegions → **ReachabilityProof** (view)

- **Holds:** the components of the region graph, from a union-find over
  guarantees. This is macro's own proof. The planned path's
  `proveReachability` is material for it. Micro groups a region's children in
  a similar way during portal negotiation (`negotiatePortals`), but that
  answers a different question at a different level. Which region will hold a
  core element isn't known before micro, so the proof names no core element regions.
- **Meaning:** a claim about guarantees, not geometry. It holds for a built
  map only because each strategy keeps its guarantees (stage 6), and the
  measurement checks it (stage 8).
- **Gate:** the proof is macro's link in the chain of inference (principle
  8). It is macro's reasoning about its own output, not enforcement on any
  builder, so it gates placement. The assumption, 17 M2, is that every layout
  region must be in the spawn region's component. That is the pessimistic
  reading of "everything must be reachable by a hunter", and it means the new
  library's designs must prescribe passable segments wherever regions meet, so
  that portals derive there
  (51 track B). The open-face rule enforces it during the solve (stage 1), and
  `proofViolations` states it on the view (step 6).

### 5. Briefs: Layout, LayoutRegions, zones, cell size → **RegionBrief[]** (view)

One brief per layout region, expressed in the macro/micro contract. The
contract is in the shared map space (`map/kernel/contract.ts`, 17 M1),
and evolves from today's `RegionSpec`:

- region id, seed, and the **region type** with its parameters from the class
  rule. This replaces `RegionSpec`'s closed list of five builder ids.
- **cells**, in the contract's global cell coordinates, with the cell size.
  mapgen's flat indices are translated by its grid width (20, "Next
  boundaries").
- **zone context:** each cell's tier, bonus and loot chance
- **core elements** the class rule lists. The spawns, one per contestant, are the
  first case: "The contestant entry areas should be treated like a region that
  gets micro generated" (17, September 22).
- **obligations**, which are passability obligations only (Corey,
  2026-09-29, M4). The brief lists the region's portals, as things to keep
  true and to be checked against, not as geometry to lay. A guaranteed
  segment with the same region on both sides is no portal, and it carries no
  obligation (stage 3, 17 M8).
  - **Every portal on the region's perimeter is reachable from every other
    one, and every part of each portal is reachable, by a hunter from within
    the region,** with no assumption about what lies outside it (Corey,
    2026-09-29). This is the builder's promise, which is 19's September 24
    contract. The SDK's validation utilities can help a builder check it
    (principle 9).
  - **With only one portal, there is no reachability requirement,** because
    there's no other portal to reach.
  - The same holds for a sub-region and its own portals.

  The rule makes neighbours compose without coordinating. Each side keeps all
  of a shared portal reachable from its own interior, so a hunter can cross
  anywhere along it, and neither side needs to know where the other leaves
  room. Two regions that each have one portal, and share it, form a pocket
  nothing outside can reach, so the proof rejects that placement (stage 4,
  every region must connect to the spawn's).

  Today's `RegionPort` works the other way. The caller supplies ports, and the
  SDK's `resolvePorts` walls each one except for a centred gap before any
  builder runs. A brief's portals never do that (C1).

  There are no ceilings and no sealed runs, from macro or between a region's
  own children (16).

A brief never mentions another region's contents. A region type that
decomposes splits its own brief into children with the SDK's decomposition
(19, 20). That happens inside stage 6, not as a stage of its own.

### 6. Build: each RegionBrief → **RegionResult** (object), in the game

- **Dispatch:** by region type, to that type's strategy in
  `map/micro/`: its decomposer, if it has one, and its builders, all
  written on the SDK (track B).
- **Holds:** the contract's result type, evolving from `micro-1`: placed
  elements and shapes, core element sites, loot, and a manifest counted from what
  landed.
- **Write scope:** every collider stays inside the region's own cells, which is
  the SDK's containment rule. So no strategy writes a boundary another region
  shares, and composition needs no merge rule. A strategy never places geometry
  on a guaranteed segment.
- **Children:** a region type that decomposes treats its children like
  regions in general. They get passability obligations only, with no ceilings
  and no seals (Corey, 2026-09-29).
  - **Every two children that share a boundary have at least one portal
    between them,** somewhere along it (Corey, 2026-10-01). The simplest
    decomposition makes every shared segment passable. Since each child keeps
    its own portal promise, a portal between two children makes every portal
    of either reachable from the other, so the children's portals and the
    region's own are all mutually reachable, by inference.
- **Keeping the promise:** a builder keeps the portal rule (stage 5), and
  everything else inside its region is its own business. Nothing in the
  pipeline checks this (principle 9). A builder that breaks it is defective,
  and that can cause failures in systems that rely on macro's assumptions.
- **Elective validation:** geometry inside a region is free-form, with no grid
  to lean on, so the SDK offers utilities for checking these promises from
  placed shapes: swept-disc crossings and routes (Corey, 2026-09-29). A
  builder may call them, typically in its own tests, and a special region
  type may validate its own way. mapgen's `conform`, which enforced, retires.

### 7. Composition: Layout, LayoutRegions, region results → **BuiltMap** (view), in the game

- **Joins** every region result in one cell coordinate system, and checks
  ownership and that the paired obligations on shared boundaries agree: each
  portal is named alike, with the same run, in both briefs.
- **Reads** the results alone. Each brief carries its cells and portals, and
  the game doesn't import macro, so the Layout and LayoutRegions aren't
  inputs in code.
- **Emits** the game's collision geometry through the adapter (`adapter.ts`,
  `placeElement`), so the built map is geometry the game can walk.

### 8. Measurement: BuiltMap, proof, Layout → **Report** (view)

- **Core elements, counted per set piece instance.** This is the first point at
  which a set piece class's promise can be checked (see "Core elements"). It works
  on core element *sites*, not regions:
  1. **Assign each site.** A site is assigned to the set piece instance whose
     slots contain the cell it stands in. Instances never share a slot, so the
     assignment is unique.
  2. **No stray sites.** A site that falls in no instance's slots, or in an
     instance whose class doesn't own that core element, is reported as a defect.
  3. **Exact counts.** Each instance of a class that owns core elements must have
     exactly the promised count of each core element among its assigned sites:
     `contestantCount` spawns for `start`, `exitCount` exits and `hunterCount`
     hunter spawns for `end`, one
     charger for `charger`.

  Two adjacent instances whose core element regions merged are caught this way.
  The one strategy sites one set of core elements, so they all land in one
  instance's slots and the other instance counts zero. The strategy never
  needs to know about instances.
- **Reachability, by inference** (principle 8, 17 M6). The map is reachable
  when every link holds:
  - the proof connects every layout region to the spawn's (stage 4)
  - every builder kept its promise (stage 6)

  No whole-map flood decides anything. The game's diagnostic checks each
  region's portal promise on its own geometry (`diagnoseBuiltMap`), to help
  find a defective builder.
- **The report diagnoses; it doesn't reject.** A failure here names a defect,
  either an authoring defect or a builder that broke its contract. It is not
  an invalid map to discard. Tests, batches and the sweep use the report to
  find defects.
- **Metrics:** measured from the built map, not from a tile graph.

## Core elements

Core elements are spawn, hunter spawn, exits, charger and warp. **Core elements belong
to set piece classes** (Corey, 2026-09-28). The set piece class is the only
macro structure the engine treats as first class.

| Core element | Set piece class | Old tile path |
| --- | --- | --- |
| spawn, one per contestant (`contestantCount`) | `start` | one point: the anchor of the lowest slot in the left third, unrelated to set pieces |
| exits | `end` | anchors of `exitCount` slots in the right third |
| hunter spawn, one per hunter (`hunterCount`) | `end`, for simplicity for now | one point: the anchor of the rightmost slot |
| charger | `charger` (new), one per map for now | none |
| warp | deferred | none |

**A spawn is one contestant's spawn point** (Corey, 2026-10-02, 17 M20). The
`start` set piece forms one `arrival` region, and its strategy places every
contestant's spawn point in it, so `start` promises `contestantCount`
spawns, a map param. The old path's single spawn was a tile anchor, and goes
with anchors (#124). A hunter spawn is likewise one hunter's spawn point:
`end` promises `hunterCount` of them (Corey, 2026-10-02: "Yes done the same
way").

Who is responsible for what:

- **Macro** places each class's quota by its placement rule. That is all macro
  knows about core elements: a placed class instance is trusted to deliver the
  core elements its class promises. Macro doesn't pick a region, a cell or a point.
- **The authors:**
  - Every set piece in a class forms at least one region of a core element class:
    a cell class whose rule lists the core elements the set piece class owns.
  - A core element class is painted only inside the set pieces of its owning set
    piece class. That keeps ordinary fill from forming a region of it, so a
    core element region always comes from an owning instance.
- **The region type's strategy** reads the core elements from its class rule in the
  brief, sites them inside its own region, and returns them in its result. It
  never needs to know which set piece instance formed its region.
- **The report** (stage 8) is the first place a set piece class's promise can
  be seen, per instance. Nothing validates at library load that a set piece
  class delivers its core elements, and nothing can until micro is complete. A
  missing core element is a defect, of an author or a builder. If two adjacent instances' core element
  regions merge and get one set of core elements, the instance left without is
  reported. Avoiding that is the authors' job, as above.

Anchors go. They stood in for "somewhere in this tile a body can stand", and
the strategies now choose that inside their own regions.

## Playground mode

A development aid that is expected to evolve (Corey, 2026-09-28). It isn't
part of this contract. Its only promise is that it goes through the same
stages and the same validation. It may relax placement rules, quotas and zone
sizes however it needs to.

## What the finished map is

The generated map is a container holding the two stage objects, the Layout and
the region results, plus the library it was made with. Every other stage
output is a view computed on demand (#69): the resolved layout, the regions,
the proof, the briefs, the built map and the report. The Map Lab, CLI and MCP
read views through one accessor, not through fields copied into the map.

In code (step 9), the container is `ChainMap` and the accessor is `mapViews`,
both in `map/macro/src/chain/map.ts`. The map also records the briefs' cell
size, an input to the results that the Layout doesn't hold, and the version of
the strategies that built them. Macro can't build or compose regions (50), so
the game lends both as `MapEngines`: a version, `build` and `compose`. The
built map and the report need `compose`; the macro views don't.

## Saving

A save holds the Layout and, optionally, the region results. Each records its
inputs and the version of the algorithm that made it. A missing result is
rebuilt from the Layout, and refused by name on a version mismatch (#70; 17
"Map generation", saving). Views are never saved. The wire version is bumped,
and old artifacts are refused by name (53).

What each save records (`map/macro/src/chain/saving.ts`):
- **The Layout:** its seed, params and library fingerprint, and
  `MACRO_VERSION`, the version of macro's stages from placement through
  briefs. A save from another version is refused, since its views would differ.
- **The results:** the cell size and the `MapEngines` version. They are
  stored or not, and a save of the Layout alone records the version anyway, so
  rebuilding them with other strategies is refused by name.

Results that are stored aren't rebuilt, so any engines may read them.

## Reused, on each side

**mapgen:**
- `primitives.ts` and `tiles.ts` parsing, rewritten for the new schema
- `wfc.ts` (compatibility changes)
- set piece selection, lifted out of `placeLayout`
- `makeZones`
- `coding.ts`, the wire form and BSON (53)
- the sweep and determinism harness
- the Map Lab, CLI and MCP, through the accessor
- the navigation lattice, as a Map Lab diagnostic only
- from the planned path, as material for stages 3–4: `findBoundaries` and
  `proveReachability`

**The game** (`map/micro/`):
- `buildInterfaces`, if it fits the whole map's scale (step 5 decides)
- the access and boundary validators, as elective utilities for builders
- `composeMicroRegions` and the adapter
- the SDK's masks, shapes, routes, placement, `spreadPoints` and
  decomposition machinery
- the example builders, as material for track B

## Retired when the chain lands

In mapgen:
- `generateMap`, `generatePlannedMap`, and everything only they use:
  - `planStreets`, blocks and standing room
  - anchors and the tile-graph metrics
  - `composeMacro` and the macro structure contract (`macro.ts`)
- the planned path (`src/plan/`), once stages 3–4 have taken what they reuse
- mapgen's micro layer (`src/micro/`): its builders, conform, clearance, loot
  and edit contract
- tile side `ports` and library geometry
- today's library

## Build order

Each step is its own issue and PR. Nothing here touches the old paths or the
live game until the switch-over.

1. This specification, reviewed (PR #80), then integrated (50).

**Track A: the macro chain, in mapgen.**

2. The library schema and `validateLibrary`, with a small test library that
   exercises every rule (#33 lands here, and the #73 design check).
3. `chain/types.ts`: every object and view named in this document, with
   interfaces only, plus purity and determinism test harnesses. **Done (#86):**
   - Each stage's output carries a stage mark, so outputs of the same shape
     don't assign to each other (principle 4). `MacroStages` gives each macro
     stage's signature.
   - `RegionBrief` and `RegionResult` are the contract's, re-exported.
   - `tests/chain-harness.ts` holds `assertPure`, `assertDeterministic` and
     `assertRecomputable`. The last saves the objects through JSON before
     recomputing the view from them.
4. Placement. **Done (#87):** `chain/placement.ts` and the `DeclaredGrid` view in
   `chain/declared-grid.ts`.
   - Set piece classes are drawn in rule order (`start`, `end`, `enormous`,
     `medium`, `small`, then `charger`, which places anywhere), then by library
     order, and placed largest first. `enormous` takes distinct pieces, one per
     vertical third, and fails explicitly if its class has fewer than its quota.
     Playground mode places no set pieces, as today.
   - The fill never uses a design that paints a core element class, which is how
     placement keeps a core element class inside its owning set pieces ("Core elements").
   - A design's eligible tiers and bonus hold wherever it is placed. A set
     piece slot draws only from its tile set's members eligible in that slot's
     zone, and allowing the slot's orientation where it fixes one. A piece
     stands only where every slot has such a member.
   - `wfc.ts` takes a compatibility function and a list of named relations
     per cell, in place of fixed compass fields. The old path links its eight
     directions as before (the sweep shows no drift).
   - The fill never places a tile that breaks a prescription. Each seam is a
     relation, and so is each corner of a middle tile. The two neighbours
     beside a corner must not ask that corner's cell for two classes, which
     is the only rule that keeps an `any` corner to one class. It is checked
     during propagation, as the old path's diagonal corner matching was, so a
     conflict prunes options as tiles are placed and is never found after the
     solve. A corner whose middle slot is outside the map links nothing.
   - An adjacency prescription facing the map's outside has no cell to
     constrain, so it is met, as a passability prescription there is.
   - Each attempt draws from its own `placement` stream (`chain/random.ts`).
   - **The open-face rule (#113, 17 M2 and M11):** `chain/open-face.ts`,
     checked by `solveWfc` after each propagation. It judges placed slots
     pessimistically and unplaced ones optimistically, and reads only what
     the newly placed slots touch.
     - A component of placed cells joins as the proof joins regions: the
       same resolved class, or a guaranteed segment. It is refused when no
       face is left open, unless it is the whole map.
     - A face toward an unplaced slot is open only while some option left in
       that slot's domain could join there: the same class, an `any` cell
       that could resolve to it, or a passable statement. Domains only
       narrow, so a hut whose every way out is spoken for is refused when its
       last face closes, not when the last slot beside it is placed.
     - An `any` cell settles when a placed neighbour asks it for a class, or
       when every neighbour is placed.
     - A portal is refused once its cells, and the cells past each end, are
       settled, if it is shorter than `MIN_PORTAL_LENGTH`.
     - A refusal names the placed slots that settle it. The solver backjumps
       to the latest of them (conflict-directed backjumping); without that,
       chronological backtracking hit the iteration cap on every attempt.
       A choice whose options all fail passes their conflicts up, with its
       placed neighbours, whose propagation shaped its domain. Propagation
       through unplaced slots isn't traced, so a jump can miss a solution,
       as the iteration cap already can. It never admits a refused layout.
     - Without the rule's `accept`, the solver backtracks as before, and the
       old path's sweep shows no drift (329 maps).
     - **Teeth:** the fixture's `hut-annex` is a hut column with no portal
       that asks for hut across one edge. It is reachable only where it
       merges with a hut that has one. Over 50 game seeds, every layout
       placed with the rule switched off splits into 10 components on
       average. With the rule on, all 50 prove connected with no short
       portal. That cost 441 ms median against 262 ms, and 7.9 s at worst,
       because 3 attempts in 50 hit the iteration cap and were retried.
       Successful solves took a median of 878 iterations, with a p90 of 1,227.
       So M11's skeleton isn't needed yet.
     - A design that can't connect where it is eligible still exhausts the
       solve. The annex eligible in tier 5, where no hut with a portal can
       face it, fails every attempt. That is a content defect.
5. Resolution and Regions, including macro's boundary runs and the run check
   (#73's logic). **Done (#88):** `chain/resolution.ts` and `chain/regions.ts`.
   - Resolution reads the `DeclaredGrid`. It shares one walk over the
     adjacency prescriptions aimed at each cell with `layoutViolations`
     (`adjacencyAsks`). An `any` cell nothing asks resolves to `open`.
   - `ResolvedLayout.segments` lists only segments a side states passability
     on, `passable` or `any`. A side with no cell of the map, off the map or
     outside its mask, is `null` in `stated`, and the segment is `none`.
   - A layout region's id is its class and lowest cell, `hut@11,6`, and its
     seed hashes the map seed with that id. Both follow the region's own
     cells, by their coordinates, so an unrelated change elsewhere, or a
     change to the map's size, leaves them be.
   - A portal's id is its pair and its first segment,
     `hut@11,6~open@6,6~v:11,11`.
   - `portalViolations` refuses a portal shorter than `MIN_PORTAL_LENGTH`,
     naming the two regions and the cells on each side. It is a check on the
     view. Placement enforces it during the solve through the open-face rule
     (step 4), since placement rules prune as tiles are placed rather than
     check the whole grid afterwards.
6. Proof. **Done (#89):** `chain/proof.ts`.
   - `proof` is a union-find over the region graph. Components come in order
     of their first region, and each lists its regions in their own order.
   - `proofViolations` is the gate's check (17 M2), one message per component
     left out, naming its regions. A spawn region is one whose class promises
     a `spawn` core element. With none, as in playground mode, the largest
     component stands in for it. Every region in the spawn region's component
     is the same as one component, so the check never has to choose among
     several spawn regions.
   - Placement enforces it during the solve through the open-face rule
     (step 4), together with the portal rule.
   - The fixture library was tweaked just enough for the mechanics to show,
     ahead of the new library (B4). Its layouts had split into 87 to 118
     components over 20 seeds, since `hut-row`'s passable pair lay inside its
     own region, and the departure and charger pads stated none. With those
     moved and added, 200 seeds out of 200 prove connected, with no short
     portal. The open-face rule then added `hut-annex`, so that it has
     something to refuse (step 4).
7. Briefs, and the translation into the contract (C1). **Done (#90):**
   `chain/briefs.ts`.
   - One brief per layout region, in the regions' order. The caller chooses
     the cell size in world units, so it is the stage's last input
     (`MacroStages`); it is the game's scale, not macro's.
   - Cells translate from flat indices by the declared grid's width
     (`gridSize`), in ascending order. `chainZones` gives the tier zones in
     cell units from the params alone, and each brief has one zone context per
     zone its cells lie in.
   - The type and parameters come from the class rule as stated, and the
     core elements with their count params resolved from the params.
   - Portals are the layout portals with the region on one side, as a run and
     an id. The id names the two regions (step 5), so both sides' briefs name a
     shared portal alike; nothing else about the region across is passed.
   - The library's own copy of the kind names is gone; it uses the kernel's
     (now `CoreElementKind`, #116).
   - A brief's core element counts are whole numbers with no ceiling. Micro's
     `briefErrors` had carried the SDK's 64-slot tool limit (20), which
     macro has no reason to know; it is dropped. Placement and briefs both
     check that the count params are whole numbers (`countParamsProblem`).
   - `tests/chain-briefs.test.ts` copies micro's `briefErrors` rule, since
     macro and micro don't import each other, and adds that every portal lies
     on the brief's perimeter. A one-off check against micro's own
     `briefErrors` passed 3,956 briefs over 20 game seeds, at about 4 ms a map.
8. The report: core elements per instance, and diagnostics that locate defects
   (C2). **Done (#91):** `chain/measurement.ts`, and `map/micro/diagnose.ts`
   in the game.
   - `measurement(built, proof, layout, library)` reads the kernel's
     `BuiltMap`, which replaces the chain's placeholder type. It reads core
     element sites and briefs, never geometry.
   - Each site is assigned by the slot its cell lies in, and each instance
     whose class owns core elements gets one count per element, in the
     kernel's kind order.
   - It names defects without rejecting the map: an instance short or over
     its class's promise, a stray site, a region the proof doesn't connect to
     the spawn's (`unprovenComponents`, the rule `proofViolations` states), a
     region the proof names that wasn't built or the reverse, and a builder's
     **broken promise**: sites that differ from what its brief asked, or that
     lie outside its own cells. Merged instances report only the instance
     left without, since their builder kept its brief, so the defect is the
     authors'.
   - The spawn region is the one whose brief asks for a spawn, the same
     region the class rule picks for the gate.
   - Metrics are counted from the built map: regions, cells, portals,
     elements, core element sites and loot.
   - **The flood diagnostic is per region.** Macro can't read the game's
     geometry, so `diagnoseBuiltMap` in the game runs the elective
     `validatePortalReach` on each region against its own brief and names the
     regions that broke their portal promise. A region split by its geometry
     is named; a sealed pocket inside a region isn't, and nothing floods the
     whole map. It is a separate view from the report, and the tools join
     them at the switch-over (step 10).
   - The tests are `tests/chain-measurement.test.ts`, with a stub builder that
     sites what each brief asks, and `tests/micro-diagnose.test.js`.
9. The map container, the accessor, saving and the wire version (#69, #70).
   **Done (#92):** `chain/map.ts` and `chain/saving.ts`.
   - `generateChainMap` places a layout and builds every brief with the
     game's engines. `mapViews` computes each view once, on first read.
   - Saving and its versions are in "Saving" above, and the wire form is in 53.
   - Region results are stored as the game's own `region-2` data, less their
     briefs, rather than packed. Macro can't read the game's geometry, so it
     has nothing to pack them by, and a brief is a view of the Layout. A result
     whose brief isn't the one its Layout gives is refused when saving.
   - The game names its registry's strategies `REGION_TYPES_VERSION` in
     `map/micro/region-types.ts`.
   - The tests are `tests/chain-map.test.ts`, with stub engines
     (`tests/chain-stub.ts`), and the root `tests/map-container.test.js`,
     where the game's builders and `composeRegions` meet macro's map.

**Track C: the contract and composition, in the game.**

- C0. **The shared map space** (17 M1, M5), `map/kernel/`: the
  contract types (`contract.ts`, which `map/micro/types.ts`
  re-exports), the single source of body scale and passage widths
  (`scale.ts`), and the definition of a run (`run.ts`), with worked cases
  (`run-cases.ts`) that every run finder is tested against. mapgen and the SDK
  both read body scale from it.
- C1. **The contract:** region type ids instead of a closed builder list;
  portals as derived check targets, which place no geometry (`resolvePorts`
  doesn't wall a brief's portals; 17 M3, M4); and core elements and zone context in
  the brief; and elective SDK utilities for a builder to check its promises
  (principle 9). **Done (#84):**
  - `contract.ts` holds `RegionBrief`, with portals as kernel `Run`s, and
    `RegionResult<Element>` (`region-1`, now `region-2`: #116 renamed its
    `features` to `coreElements`). The result is generic over the
    game's geometry, so the kernel imports nothing outside itself.
  - `map/micro/region-types.ts` is the registry and `buildRegion` dispatches
    to it. Catalogue types join it as B3 builds them, starting with `open`
    (#126), `cover` (#127), `rubble` (#128), `hut` (#129) and `arrival` (#130). Today's example builders, prefixed `example-`, stand in for the
    rest.
  - `validatePortalReach` in `map/micro/portals.ts` is the elective check.
  - The SDK's explicit-port `RegionSpec` and its `micro-1` result, now
    `MicroResult`, stay in `map/micro/types.ts` for the examples and
    decomposition (20).
- C2. **Whole-map composition:** generalize `composeMicroRegions` beyond 16
  regions and the per-region bounds, as macro-sized regions need (17 M7).
  **Done (#93):**
  - `composeRegions` in `map/micro/compose.ts` joins up to 4,096 `region-2`
    results into a `BuiltMap`, the kernel's type, so step 8 can read it
    without the engine. It refuses two owners for a cell, and a portal that
    faces no owner, straddles two regions, or isn't named alike, with the
    same run, on its other side. A portal id names one pair map-wide. It checks no geometry (principle 9).
  - The SDK's region bounds are one module, `map/micro/limits.ts`, raised to
    65,536 cells, 512 per axis and 4,096 portals. The fixture's open ground
    is one region of about 29,500 cells, 360 across, with about 440 portals.
    The example open builder fills a 360 × 90 region with 200 portals in
    about 3.5 s.
  - `stampBuiltMap` and `builtMapCollision` in `adapter.ts` emit the map's
    geometry, each region under its id.
  - `tests/micro-compose-map.test.js` composes a synthetic map of 301
    regions, one of them 7,000 cells, the same in any order.
  - Left for B3 (20, "Next boundaries"): decomposition contexts keep their
    old bounds, and a brief's loot keeps the 64-slot cap.

A whole-map reachability measurement (formerly C3) isn't needed, because
reachability is inferred (principle 8).

**Track B: the library (content).** It starts after step 2.

- B1. **Map Lab authoring** for the new schema: adjacency and passability
  prescriptions, core element classes, set piece classes, and a preview of the
  portals the passable sections would derive. There are browser tests,
  and no geometry tools.
- B2. **The region type catalogue**, a document for Corey's review. For each
  region type:
  - its role in play
  - its strategy: the decomposer and the builders, on the SDK
  - the core elements it sites, if it is a core element class
  - its shape needs, such as minimum area and width
  - its obligations, such as `open`'s privilege (#61)

  The game's example builders and mapgen's six are material, not
  constraints. **Drafted (#85):** 54, a working draft. Corey answered its
  questions, 17 M18 to M25, on 2026-10-02.
- B3. **The strategies** the catalogue calls for, in `map/micro/strategies/`,
  each its own issue: #126 to #132 for the minimal set, under #96.
  **Done:** `open` (#126), `cover` (#127), `rubble` (#128), `hut` (#129),
  `arrival` (#130), `departure` (#131), `charging` (#132).
- B4. **The new library**, authored against the catalogue:
  - cell classes, tiles and tile sets
  - set pieces and set piece classes, including `start`, `end` and
    `charger` with their core element classes

  It starts minimal, with enough to exercise every stage and to play, and
  grows afterwards. **Minimal set done (#97):**
  `map/macro/content/chain-library.json`, described in 52 ("The chain's
  library"). Its classes bind to the game's own strategies, with no example
  builder. The tests are `tests/chain-content.test.ts` in mapgen, and the
  root `tests/map-library.test.js` and `tests/slow/map-library.test.js`;
  `tests/map-container.test.js` saves and reloads a map built from it.

**Switch-over.**

10. Switch the Map Lab, CLI and MCP to the new chain and the new library (it
    needs tracks A, B and C). Capture the new chain's first baseline, then
    delete mapgen's old paths, its micro layer and the old library. The tools
    move to `map/tools/` (17, "Where the tools live"), in three issues under #98:
    - 10a (#144): `map/tools/` with the game's engines, and the CLI and MCP on
      the chain. **Done:** 53, "Tools".
    - 10b (#145): the Map Lab on the chain. **Done:** 53, "Tools".
    - 10c (#146): the first baseline, then the deletions.

Replacing the live game's interim street maze is a later, separate checkpoint
(20, 41).

Content is expected to change. The old #47 baseline is no reference for the
new chain. The bar is that the report shows no defects and maps play acceptably, and
then the new chain's first baseline is captured, last.

## Earlier issues

| Issue | Becomes |
| --- | --- |
| #25 tile edge-constraint work, #32 v2 library schema | superseded by step 2 and track B |
| #33 segment prescriptions | step 2 |
| #34 a placed tile seals its interior | retires with the old tile path; in the chain, sealing off a region's portals is a builder defect (stage 6, principle 9) |
| #45 anchors at tile centre | retires with anchors |
| #52 layer separation (tracking) | done (#49–#51), and superseded by this chain |
| #59 reachability contract | step 6, then the open-face rule in step 4 |
| #61 `open` is privileged | B2 states it, B3 builds it |
| #65 the old chain (tracking) | superseded by the tracker, #82, which lists each step's issue |
| #68 independent builders | stages 5–7: steps 7, C1, B3 |
| #69 map container | step 9 |
| #70 saving with provenance | step 9 |
| #71 planned path joins the chain | closed: the planned path retires |
| #73 / PR #78 | closed unmerged. Its labels and design check went to step 2, its run check to step 5 |
| #76 streets retire, region handed whole | stage 6 and B3; streets retire at step 10 |
| #79 stage types and views | step 3 (this document is its design) |
