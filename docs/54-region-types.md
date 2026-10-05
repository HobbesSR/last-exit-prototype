# 54. Region types

Status: **working draft**, 2026-10-02 (B2, #85). Corey's answers to its
questions, 17 M18 to M25, are recorded in 17 and applied here. The catalogue
itself stays deferred (M18): B3 and B4 build its minimal set to hook the chain
up top to bottom, and authoring and specially recognized details are reworked
after that. Marked proposals and numbers are not requirements until Corey
adopts them (53, "Provenance rule").

This is the catalogue the new library (B4) and its strategies (B3) are built
against. A cell class names a region type (52), and the type's strategy fills
each layout region of that class (51 stage 6). The game's example builders and
mapgen's six are material for these types, not constraints (51 track B).

## What every type shares

These hold for every entry below, so the entries don't repeat them.

- **The strategy** is the type's own code in `map/micro/`: a decomposer if it
  has one, and its builders, written on the SDK (50, "The SDK is a library").
  It reads only its brief and places geometry only inside its own cells (51
  principle 5).
- **The one promise:** every part of every portal is reachable by a hunter
  from every other portal, from within the region. One portal carries no
  requirement (51 stage 5). Nothing enforces it, and a builder that breaks it
  is defective (51 principle 9). *Proposed:* each type checks itself with
  the SDK's elective validation in its own tests.
- **Guaranteed segments** carry no geometry (51 stage 6).
- **Core elements** are sited before the loot fill, as the entry builder does
  today (20). A core element class sites exactly the counts its brief lists.
- **Loot** rolls each cell's loot chance and takes the cell's tier, from the
  brief's zones (52, "Tier zones"). `open` places none (M25).
- **Core elements first.** Elements with mechanics other than core elements,
  such as traps, sensors and turrets (F-05, F-15), how builders incorporate
  them, and locked doors (P-06) are deferred until generation with core
  elements works (17 M22 and M23, 16).
- **Parameters:** what is intrinsic to the type goes in its class rule, and
  what varies with position comes from the zone (52). The parameters named
  below are proposals.
- **Fitting the region** (Corey, 2026-10-02, 17 M24): the type's decomposer
  decides. If it can't make a subregion with what one of the type's builders
  needs, it may hand that subregion to a different builder, and the `open`
  builder is always the last resort. A type below with no decomposer takes
  its region whole. A core element class that can't site its core elements
  leaves the shortfall for the report (51 stage 8).

## How many portals a region has

The proof and the promise give a region's portal count a meaning that authors
design with:

| Portals | What the region is | What its strategy owes |
| --- | --- | --- |
| none | unreachable: the proof refuses the layout (17 M2) | — |
| one | a dead end, or a pocket | nothing between portals, so its interior is free |
| two or more | a passage, or a junction | a hunter route joining every part of every portal |

There is no obstacle type, and no region is exempt from the proof. Authors
may use these rules as they stand to make a region act as an obstacle (Corey,
2026-10-02, 17 M19).

## The catalogue

| Type | Family | Role in play | Core elements |
| --- | --- | --- | --- |
| `open` | ground | circulation: the clear ground everything else sits in | — |
| `cover` | friction | scattered cover on open ground, for fights and sightlines | — |
| `rubble` | friction | contestant-only squeezes beside a longer hunter route | — |
| `ruins` | friction | broken walls and part-buildings: maze-like friction and partial sight | — |
| `hall` | friction | a pillared lattice that breaks sight without blocking a walk | — |
| `checkpoint` | friction | a military choke: chicane barriers across a passage, a guard post | — |
| `park` | friction | overgrown ground: tree clumps and hedge runs with door-wide gaps, soft cover, open sight | — |
| `hut` | structure | one building in its yard: walls, door, windows, roof | — |
| `depot` | structure | warehouses and container aisles: long sightlines, hard corners | — |
| `plant` | structure | an industrial works: machinery blocks, pipe runs, long lines | — |
| `compound` | structure | rooms around a walled court with few gates: a pocket with dead ends | — |
| `block` | district | a city block that decomposes into the types above | — |
| `market` | drafted | stall rows and narrow lanes: dense, low, sight-breaking cover | — |
| `arrival` | core element | the contestants' start | `spawn` × `contestantCount` |
| `departure` | core element | extraction and the hunters' start | `exit` × `exitCount`, `hunter-spawn` × `hunterCount` |
| `charging` | core element | the power-cell charging station (F-03) | `charger` |
| `transit` | core element | the hunters' transit stations (P-09) | `warp` |

**Minimal first set** for B3 and B4, *proposed*: `open`, `cover`, `rubble`,
`hut`, `arrival`, `departure` and `charging`. That is enough to hook the chain
up top to bottom, with every stage, every core element class, and the
contestant-only asymmetry (P-04).

## Ground

### `open`

- **Role:** the circulation that joins everything. The deferring class `any`
  settles as `open` (52), so it is also the fill.
- **Privilege** (Corey, 2026-09-27, #61, verbatim in 17): every cell of an
  `open` region is passable, and so is every segment inside it. Its builder
  promises that, on top of the portal promise.
- **Strategy:** no decomposer. For now the builder builds nothing, so an
  `open` region is pure open cells (Corey, 2026-10-02, 17 M25). What else it
  may hold is deferred. Cover comes from other types placed among it (17 M10).
  It is also every decomposer's last resort for a subregion (M24).
  **Built (#126):** `map/micro/strategies/open.ts`. It places nothing, so it
  keeps the portal promise exactly when the region's shape does. A one-cell
  neck between portals breaks it by shape alone, which is macro's to avoid
  (17 M9).
- **Shape needs:** a door's width, 2 cells, wherever it carries a route (17
  M9, assumption). A one-cell neck carries no hunter.
- **Formed by:** fill, and the margins of every set piece.
- **Parameters:** none.

## Friction

These make the map "somewhat of a maze" (design notes): dead ends, choke
points, and routes that aren't a straight shot.

### `cover`

- **Role:** cover to fight from and to break pursuit, on ground that stays
  easy to cross. Sightlines are broken but rarely blocked for long.
- **Strategy:** no decomposer. A builder scatters small cover: crates,
  barriers, low walls, the odd container, spaced so aisles stay at least a
  door wide. It protects a hunter route between portals while it places
  pieces.
  **Built (#127):** `map/micro/strategies/cover.ts`. It protects the route by
  spacing, not by a route search, so it scales to macro's open ground: a
  29,500-cell region with over 400 portals builds in well under a second.
  - **Slots:** they lie on a lattice one tile (6 cells) apart. Each slot is
    taken with chance `density`, by a cluster of one to three crates,
    barriers and containers inside a 4 × 4 box.
  - **The aisle:** a cluster's bounding box keeps 2 clear cells from the next
    cluster's and from any cell the region doesn't own. That is a doorway
    (52), which a hunter fits (20.2).
  - **Why that keeps the promise:** each box is convex, with a clear ring
    wider than a hunter around it, so the boxes can't divide the ground
    outside them, where every portal is. Like `open`, a `cover` region keeps
    the portal promise exactly when its shape does.
  - **Loot:** each cell rolls its chance and takes its tier. Loot lands only
    where the cell and its eight neighbours are owned and free of cover, so
    it has standing room.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
- **Shape needs:** none. A region too small for one piece stays clear: a
  piece needs 3 clear cells on every side.
- **Formed by:** small set pieces and tile fill among open ground (17 M10).
- **Parameters:** `density`.
- **Material:** the game's `example-open` (sparse cover and shelters), and
  mapgen's `open-field` and `loot-scatter`.

### `rubble`

- **Role:** the asymmetry (P-04). Dense debris whose gaps are mostly the
  1.5-cell squeeze, so a contestant cuts through where a hunter has to go
  round. The design notes ask for these choke points.
- **Strategy:** no decomposer. A builder first keeps one hunter route joining
  every portal, then fills the rest with debris, leaving squeezes as
  contestant shortcuts across it. A one-portal `rubble` region needs no
  hunter route at all, so it can be a contestant-only hideout.
  **Built (#128):** `map/micro/strategies/rubble.ts` protects the portal
  approaches and hunter routes, then places seeded debris on a two-cell
  lattice. The `density` and `squeezeShare` parameters range from 0 to 1.
  Squeezes are opportunistic; the strategy promises no minimum count.
  Regions below the proposed shape needs use the `open` builder.
- **Shape needs:** *proposed*, at least 12 cells and 3 cells across, so that a
  hunter route and a squeeze both fit.
- **Formed by:** small set pieces (`rubble-strip`) and the fill's rubble banks, between open areas (52).
- **Parameters:** `density`, and the share of gaps that are squeezes.
- **Material:** mapgen's `rubble` (its surviving gaps sit in the contestant
  band), and the game's `example-ruins` decay into rotated rubble.
- **Macro-required squeezes** are deferred until the layers work end to end
  (17 M21, 16). Until then squeezes are this builder's choice.

### `ruins`

- **Role:** broken walls and part-buildings. Friction, partial occlusion, and
  rooms without roofs, in the "cyberpunk urban dystopian ruins" direction (11).
- **Strategy:** no decomposer. A builder lays discontinuous walls and rotated
  debris around a protected hunter route.
  **Built (#157):** `map/micro/strategies/ruins.ts`. It protects the portal
  approaches and hunter routes as `rubble` does, with the helpers both share
  in `strategies/scatter.ts`, and drops any piece that would touch them.
  - **Rooms:** slots lie on a lattice 6 cells apart, at a seeded phase. A slot
    is taken with chance `density` by a roofless room 3 or 4 cells a side,
    wholly on owned cells, so at least a doorway's width (52) parts two rooms.
  - **Walls:** a quarter cell thick, as `hut`'s are, laid a cell at a time
    along the inside of the room's box. Each span falls with chance `decay`;
    half of the fallen lie as a rotated slab inside their cell, and the rest
    are gone.
  - **The doorway:** two cells wide, on a side whose cells beyond are owned
    two deep, so no room is sealed off. A doorway at a corner takes the
    meeting wall's end span too, to stay two cells wide.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every piece.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region of fewer than 24 cells, or with no owned 3 × 3
    box for a room, goes to `open` (17 M24).
- **Shape needs:** *proposed*, at least 24 cells.
- **Formed by:** small set pieces (`ruins-lot`), and as a child of `block` (52).
- **Parameters:** `density`, `decay`.
- **Material:** the game's `example-ruins`.

### `hall`

- **Role:** a regular lattice of pillars or blocks, with offset rows. It
  breaks a sightline without blocking a walk, so it's good ground for
  pursuit.
- **Strategy:** no decomposer. A builder picks a contained rectangle, lays the
  lattice on it, and keeps the rest of the region clear.
  **Built (#158):** `map/micro/strategies/hall.ts`. It protects the portal
  approaches and hunter routes as `rubble` and `ruins` do, and drops any
  pillar that would touch them.
  - **The rectangle:** the region's largest contained rectangle with both
    sides at least 6 cells. Ties go to the first in row order.
  - **Pillars:** each stands a quarter cell inside a 2 × 2 block of cells, so
    it is 1½ cells square. Blocks lie `spacing` cells apart, centred across
    the rectangle, and the aisle between two pillars is `spacing` less 1½
    cells.
  - **The stagger:** each line of blocks is offset from the last along one
    axis, drawn from the seed, by as near half a period as whole cells allow
    while sharing no factor with it: 5 cells at spacing 6, 7 at 10. So the
    lines visit every phase within a period's worth of them, and a sightline
    down the other axis meets a pillar. A stride sharing a factor would visit
    only some phases and leave a lane open the whole way (PR #176 review).
    That axis keeps clean lanes. Staggering both would
    pinch pillar corners together.
  - **The roof:** with `roofed`, the rectangle is one enclosing element, so a
    roof hides what's under it as a building's does.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every pillar.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no such rectangle goes to `open` (17 M24).
- **Shape needs:** *proposed*, a contained rectangle of at least 6 × 6.
- **Formed by:** medium set pieces (`pillar-hall`), and as `market`'s stand-in (52).
- **Parameters:** `spacing`, whole cells from 4 (5 by default), and
  `roofed`, true or false (false by default).
- **Material:** mapgen's `pillar-hall`.

## Structures

Buildings give concealment (P-11, F-18): solid walls and roofs hide what's
inside, and windows and doors let sight through.

### `checkpoint`

- **Role:** the half of the old `military` that isn't a walled base. A choke
  across a passage: barriers, a guard post and staggered chicanes that slow a
  crossing and break the sightline along it.
- **Strategy:** no decomposer. Chicane barriers across the line between its
  two farthest portals, alternating sides, with a small roofed post beside
  them. A one-portal region is a guard post alone.
  **Built (#220):** `map/micro/strategies/checkpoint.ts`. Unlike the spacing
  types it keeps its promise by pruning during the solve, since a chicane is
  meant to stand across the route.
  - **The line:** from one portal's centre to another's, the farthest pair
    (the first in id order on a tie).
  - **Barriers:** along the line's longer axis, 5 cells in from either end at
    a seeded offset of 0 to 2, then every 4 cells. Each is a half-cell wall of
    kind `ruin-wall`, so it blocks movement and sight. It reaches 4 cells
    either side of the line, or as far as the region goes, attaches to the
    region's edge on one side and stops 2 cells (a doorway) short of the
    other. The sides alternate along the line, from a seeded first side, so a
    body crossing slaloms. Where the region is wider than the barrier a body
    can go round it, which slows a crossing without sealing it. A station
    needs a run of at least 3 owned cells across the line, or it gets no
    barrier.
  - **The post:** a roofed box 6 to 8 by 5 or 6 cells, its long side along the
    line, built as `depot`'s warehouse is (56): a roofed design with shelves
    on its floor, traced for the lab. It stands nearest the middle of the
    barriers, off the line, with a 2-cell owned ring clear of the region's
    edge and of every barrier. With one portal it stands nearest a point 5
    cells in from the portal, and with none nearest the region's middle.
  - **Why that keeps the promise:** the empty shape is checked once with the
    elective flood check (`validatePortalReach`, 20.1), and a region whose own
    shape fails is `open`. Each barrier is then kept only while the check
    still finds a hunter route between every pair of portals, and each post
    candidate likewise, nearest first, up to 6. Nothing is rebuilt: a piece
    that fails is dropped as the solve goes on. The check's search is
    sampled, so a miss drops a piece that might have been fine, and a kept
    piece is always proved.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every piece, indoors or out.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no post and no barrier placed goes to
    `open` (17 M24).
- **Shape needs:** *proposed*, a chicane needs two portals and 3 cells across
  the line, and a post needs a contained 6 × 5 with its ring. Either alone is
  enough to build.
- **Formed by:** medium set pieces, where the old library's `military`
  pieces were.

### `park`

- **Role:** the old `park` and `tree` classes. Overgrown ground with tree
  clumps and hedges: soft cover, open sightlines, and hedge lines that wall
  off stretches of ground except at a gap.
- **Strategy:** no decomposer and no buildings. Clumps of trees (round
  obstacles) at a seeded density, and hedge runs that leave a gap a door wide.
  **Built (#221):** `map/micro/strategies/park.ts`, which keeps its promise by
  spacing, as `cover` and `plant` do.
  - **Slots:** a lattice 6 cells apart at a seeded phase. A slot's pieces stay
    in its first 4 cells, so 2 are aisle.
  - **Hedges:** with chance `hedges` (default 0.2) a slot starts a hedge run,
    across or down into the next slot, 10 cells long, in a seeded row of the
    slot's band. Its two stubs are 0.4 cell thick, of kind `hedge`, which
    blocks movement and hands but not sight or shots, as `pipe` does
    (17.2.8 M34, `seeThrough` in `shared/movement.ts`). The gap is 2 cells (a
    doorway) at a seeded place that leaves at least a cell of hedge each side.
  - **Clumps:** each other slot holds a clump with chance `density` (default
    0.6): 1 to 3 trees, each a circle of kind `tree` 1.5 cells across in a
    2-cell footprint, at seeded places in the slot's band that don't overlap.
    A tree blocks bodies and sight, so a clump is soft cover, not a wall.
  - **Why that keeps the promise:** every clump's box and every hedge run's
    keeps 2 owned cells from every other and from the region's edge, so
    each is a convex box with a ring wider than a hunter. Such boxes can't
    divide the ground a hunter can reach outside them, where every portal is,
    and a hedge's gap only adds ground inside its ring. So the region keeps
    the promise exactly when its shape does, with no route search. The
    consequence is that a hedge line is never the only way across: the hunter
    can go round its ends as well as through its gap.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every piece.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region too small for a piece stays clear.
- **Parameters:** `density` and `hedges`, each from 0 to 1.
- **Shape needs:** none, as `cover`.
- **Formed by:** small set pieces (52). Its ground is weighted 0.15 in the fill (52, #221), as `cover`'s is, so a lone 6 × 6 tile of it holds a tree at most.

### `hut`

- **Role:** one small building in its yard, with walls, a door, windows and a
  roof. It is 52's worked case: four corner blocks across a tile junction form
  one 6 × 6 region, and the hut stands anywhere inside it.
- **Strategy:** no decomposer. A builder picks a contained rectangle for the
  building, puts its door where the yard keeps every portal joined, and leaves
  the yard around it. A route through the building counts only through
  unlocked doors.
  **Built (#129), with larger houses since L5 (#192, 56):**
  `map/micro/strategies/hut.ts`. It reasons in cells, where a hunter is a
  2 × 2 block of yard cells, so it needs no route search.
  - **The designs:** it tries a house of three spaces, then two, then one,
    then goes to `open` (17 M24). Three spaces take a 6 × 6, 8 × 6 or 9 × 4
    box, two a 6 × 4 or 7 × 5, either way round, and one a 4 × 4.
  - **The size:** a box is tried only in a region at least 2 cells wider and
    taller than it, so a region less than 6 cells across on either axis goes
    to `open` before any box is tried, even where a box and its doorstep would
    fit, and one up to 7 across keeps the one-space house. The L and the ring
    count by their extent, not by a contained rectangle.
  - **The box:** each design tries its sizes, and each size the region's
    contained boxes, in a seeded order. It takes the first that stays off
    every portal's approach (the two cells inward along it), leaves joined
    every two portals the empty region joined, and has a side whose doorstep
    the yard joins to a portal. A box with a clear ring 2 cells wide passes
    the last two by shape alone.
  - **The house:** it fills its box with quarter-cell walls and a roof. It has
    one outside door, a doorway wide, on the doorstep's side. The one-space
    house centres it and faces it with a window as wide. A larger house's
    spaces are allocated in the box (56 L5), at least 3 × 3 each, joined by
    interior doors, with windows where they fit. Its door and the doors
    joining every space must be placed, or the side isn't used. With one
    outside door, no route runs through the house, and every space is reached
    through it.
  - **Why that keeps the promise:** the house takes only its box, so the yard
    joins what the empty region joined. A region with no such box, such as
    the fixture's 2 × 3 huts, goes to `open` (17 M24), so a `hut` region keeps
    the portal promise exactly when its shape does.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of the walls and the door, indoors or out.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
- **Shape needs:** *proposed*, a contained 4 × 4 for the building, in a
  region of at least 6 × 6. Two spaces need a region of at least 8 × 6, and
  three at least 8 × 8 or 11 × 6.
- **Formed by:** the fill's hut quarters, and as a child of `block` (52).
- **Parameters:** none yet. Locked doors are deferred (M23).
- **Material:** the game's room shell in `builders.ts` (real windows, a door
  sized by the profile, optional shelves), and mapgen's `compound`.

### `depot`

- **Role:** industrial ground: warehouses and container aisles. Long
  sightlines down the aisles, hard corners at their ends.
- **Strategy:** no decomposer at first. A builder places warehouses on
  contained rectangles and container rows between them, aisles at least a
  door wide.
  **Built (#159):** `map/micro/strategies/depot.ts`. Like `cover`, it keeps
  its aisles by spacing, not by a route search, so it scales to enormous set
  pieces.
  - **Lanes:** everything lines up on lanes 3 cells apart along one axis,
    drawn from the seed, at a seeded phase.
  - **Warehouses:** `roomCells` long and three quarters of that across, at
    least 5, with quarter-cell walls and a roof. They stand at seeded places
    on the lanes until about `density` of a quarter of the ground is taken.
    **Designs (#218, 17.2.8 M34):** each box is allocated as a building
    design (56), trying in a seeded order a floor with an office and a store,
    or a floor with an office. The floor takes at least half the box and asks
    for a door on each end. The office asks for a door into the floor, a door
    out on the far end, where it can front the warehouse, and a window. The
    store asks for a door into the floor. A design is kept only if at least
    two doors lead outside, so the warehouse stays a way through, and every
    space is reached through doors. A box neither fits, such as
    `roomCells` 6, is a one-room design with a doorway-wide door centred on
    each end. Every warehouse is traced for the lab, and the trace names the
    designs passed over and why.
    Shelf islands a cell across run down the floor, keeping 2 cells from its
    walls and from each other. The interior is guidance and adds nothing to
    the promise, which the box's clear ring keeps (M29).
  - **Container rows:** two or three 2-cell containers end to end, packed
    along each lane around the warehouses. Each place that fits one is taken
    with chance `density`, and the next starts 2 cells on, so the aisles run
    long and end in hard corners.
  - **Why that keeps the promise:** every piece's box keeps 2 clear cells
    from every other piece's and from any cell the region doesn't own, as
    `cover`'s clusters do. So a `depot` region keeps the portal promise
    exactly when its shape does.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every wall, door, shelf and container, indoors or
    out.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no contained 10 × 10 goes to `open` (17
    M24).
- **Shape needs:** *proposed*, at least 10 × 10.
- **Formed by:** enormous and small set pieces, where the old library's `industrial` sheds and yards were (52).
- **Parameters:** `density`, from 0 to 1 (0.55 by default), and `roomCells`,
  whole cells from 6 to 16 (8 by default).
- **Material:** the game's `example-depot`.

### `plant`

- **Role:** the half of the old `industrial` that isn't a warehouse. Big
  machinery blocks and pipe runs on a factory floor: hard cover, long lines
  between machines, and a few tight corners.
- **Strategy:** no decomposer. Machinery on a coarse grid, joined by low pipe
  runs, with an optional roofed shed.
  **Built (#219):** `map/micro/strategies/plant.ts`. Like `depot`, it keeps
  its promise by spacing.
  - **Slots:** a lattice 8 cells apart at a seeded phase. A slot's pieces stay
    in its first 6 cells, so 2 cells of aisle run between slots.
  - **Shed:** with chance `shed` (default 0.5), a block of two by one, one by
    two or two by two slots, at the first block in a seeded order whose box
    keeps a 2-cell owned ring. It is built as `depot`'s warehouse is: a
    roofed building design (56) with shelves on its floor, traced for the lab.
  - **Machines:** every other slot holds one with chance `density` (default
    0.6): a block 2 to 4 cells a side at a seeded place in the slot, half of
    them with chamfered corners. A machine whose box can't keep a 2-cell owned
    ring is left out.
  - **Pipe runs:** neighbouring machines across or down are joined, with
    chance 0.7, along a row both face, when at least 3 cells part them. The
    game is 2D, so a pipe blocks movement but not sight or shots, as a window
    does (obstacle kind `pipe`, 29; 17 M34). Each run leaves one gap a door
    wide, 2 cells, at a seeded place, which both roles use. A gap only a
    contestant fits waits for the squeeze balance (P-04). Gantries wait for
    collision planes (16).
  - **Why that keeps the promise:** every machine's and the shed's box keeps
    2 clear cells from every other's and from any cell the region doesn't
    own, and so does every run's but for the two machines it joins. A run
    stays in its machines' band and crosses only the aisle between them, so
    runs never meet. Machines and runs can wall ground in, but every run has
    its door-wide gap, so no ground is shut off. So a `plant` region keeps
    the portal promise exactly when its shape does.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every piece, indoors or out.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no contained 10 × 10 goes to `open` (17
    M24).
- **Shape needs:** *proposed*, at least 10 × 10, as `depot`.
- **Formed by:** enormous and small set pieces, where the old library's
  `industrial` pieces were.

### `compound`

- **Role:** rooms in a ring around a walled court, with two or three gates.
  A pocket that rewards a contestant who knows its gates and traps one who
  doesn't. It is where dead ends live.
- **Strategy:** a builder puts the ring on the region's outline and the court
  inside, and places gates so every portal reaches the court. A region with a
  hole suits it whole, as 19's ring example does.
  **Built (#160), its ring one building design since L5 (#192, 56):**
  `map/micro/strategies/compound.ts`. No decomposer. It
  stands one compound inside its yard, not on the region's outline: a wall on
  the outline would need a gate at every portal, more than two or three
  wherever the region has more portals. Like `depot`, it keeps the portal
  promise by spacing, not by a route search.
  - **The box:** the region's largest contained rectangle, inset 3 cells on
    every side and capped at 24 × 24, at a seeded place inside that.
  - **The ring:** roofed rooms 3 cells deep along the inside of the box, with
    quarter-cell walls. The box's edge is their back wall, so the compound's
    outer wall is the rooms'. Each side's middle, between the corners, is
    split into rooms 3 to 5 cells long, as evenly as whole cells allow, each
    with a door a doorway wide onto the court. The rooms and passages are the
    spaces of one design over the ring's cells, so two rooms share one wall,
    and each room is its own element with its own roof.
  - **Dead ends:** a 3 × 3 room stands at each corner. It opens only into its
    neighbour along the north or south side, a room or a gate's passage.
  - **Gates:** `gates` sides, drawn from the seed, each have a passage 2
    cells wide through the ring at a seeded place, from a door in the outer
    wall to the court. The passage widens to the corner where what's left
    would be too short for a room. A passage keeps its whole width: the walls
    it shares stand in the rooms beside it. It is open to the court along its
    length. The rest of the ring is closed.
  - **The court:** the open ground inside the ring, at least 4 × 4. It holds
    nothing but loot.
  - **Doors and passages:** every door is centred in its wall, and each
    passage is a doorway wide (52), so a hunter passes through them.
  - **Why that keeps the promise:** the box keeps 3 clear cells from any cell
    the region doesn't own, as `depot`'s pieces do. It is convex with a clear
    ring wider than a hunter, so it can't divide the yard, where every portal
    is. A `compound` region keeps the portal promise exactly when its shape
    does. A hole in the region stays in the yard.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every wall and door, in the rooms, the court or the
    yard.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no contained 16 × 16 goes to `open` (17
    M24).
- **Shape needs:** *proposed*, a compound of at least 10 × 10, with a court of
  at least 4 × 4. As built, that is a contained 16 × 16 with its yard.
- **Formed by:** medium set pieces, where the old library's walled `military` bases were (52).
- **Parameters:** `gates`, whole numbers from 1 to 4 (2 by default), one per
  side.
- **Material:** the game's `example-courtyard`, and mapgen's `courtyard` and
  `compound`.

## District

### `block`

- **Role:** a large urban block that is several things at once: buildings,
  yards and alleys. It's the first type with a decomposer, and the one that
  makes the large set pieces read as places.
- **Strategy:** the SDK's decomposition (19, 20) splits the region into
  children and dispatches each to another type's builders: `hut`, `depot` or
  `compound` for rooms, `ruins` or `cover` for lobes, and `open` for the
  circulation left over. Region types may borrow each other's builders (19).
  **Built (#161):** `map/micro/strategies/block.ts`. It is not built on the
  SDK's decomposition. That search scores candidate pieces in a bounded beam,
  and its contexts stop at 4,096 cells and 64 per axis. An enormous set piece
  outgrows both. Instead, the block splits its region by spacing, as `depot`
  does, so it needs no route search and scales the same way. It reuses
  `hall`'s largest-rectangle finder and the other types' strategies. That
  deviation is recorded here for review.
  - **The split:** the region's bounding box is split, guillotine fashion,
    across its longer side at a seeded place. Each split leaves an alley 3
    cells wide between the parts, and splitting stops once no part is longer
    than 24 cells.
  - **Lots:** in each part, the lot is the largest rectangle, at least 6 cells
    a side, of cells with 3 owned cells all round them. So every lot keeps 3
    clear cells from any cell the region doesn't own and from every other lot.
    A part with no such rectangle stays alley.
  - **Children:** each lot is a `hut` (no side over 12), `depot` (sides at
    least 10), `compound` (at least 16), `ruins`, or `cover` (at least 9)
    region. Its type is drawn from those its size suits, and it gets its own
    seed. The alleys, everything left, are one `open` region. Each child's
    zones are the block's, cut to its cells. `planBlock` returns the child
    briefs, and the block's result gathers the children's geometry, loot and
    manifest counts. Each element's label is prefixed with its lot.
  - **Frontages:** each lot has two portals onto the alleys, the two whole
    sides at a seeded corner. Two, not one, so the lot is a passage its
    strategy must keep joined, rather than a pocket that owes nothing. A `hut`
    still fits in the far corner of the smallest lot. The alleys hold every
    frontage and every one of the block's own portals.
  - **Why that keeps the promise:** a lot is a convex box with a clear ring
    wider than a hunter around it, in the alleys, so the lots can't divide the
    alleys, as `depot`'s pieces can't divide its yard. Every one of the block's
    portals lies on the alleys, so the block keeps its promise exactly when
    its shape does. Each lot keeps its own promise between its frontages.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no contained 12 × 12 (a 6 × 6 lot and its
    alley) goes to `open` (17 M24).
- **Obligations:** every two children that share a boundary have at least
  one portal between them (51 stage 6, Corey 2026-10-01). Each child keeps its
  own promise, so the block's portals are joined by inference. As built, lots
  touch only the alleys, through their frontages.
- **Shape needs:** *proposed*, at least two tiles' worth, 72 cells. As built,
  a contained 12 × 12 for one lot with its alley.
- **Formed by:** enormous set pieces (`city-block`, 52).
- **Parameters:** none yet. Each lot's type takes its own defaults.
- **Material:** `decomposition/example.ts` and `decomposition/realize.ts`, the
  demonstration strategy.

## Drafted types

These bring the old library's areas back as types closer to the intended
world (Corey, 2026-10-03 and 2026-10-04, 17.2.7). Their roles and shape needs
are drafts until Corey gives art direction on theme and geometry.

Each is registered under its own name and **bound to the nearest built
strategy** until its own is written. A library paints the type's own name, so
writing the strategy later rebinds the type in the registry and needs no
re-authoring. There is no placeholder marking: a stand-in builds what its
strategy builds, and an existing builder doing something reasonable beats
plain ground (Corey, 2026-10-04). While bound, a type takes its stand-in's
parameters, keeps its promise and sites no core elements.

### `market`

- **Role:** the old library's market. Rows of stalls and awnings with narrow
  lanes between them: dense, low cover that breaks sightlines everywhere and
  rewards close fights.
- **Strategy:** *proposed*, stall rows along the region's longer axis on a
  regular pitch, lanes a door wide (52), with cross-lanes at seeded places so
  no row is a wall. Awnings are roofs that hide but don't block.
- **Stand-in:** `hall`. Its staggered lattice is rows and lanes already.
- **Shape needs:** *proposed*, a contained rectangle of at least 6 × 6, as
  `hall`.
- **Formed by:** enormous and medium set pieces, where the old library's
  `market` pieces were.

## Core element classes

Each is painted only inside its owning set piece class's set pieces (51,
"Core elements"), and its strategy sites exactly the counts in its brief. The
report checks those counts per set piece instance (51 stage 8).

### `arrival`

- **Role:** where contestants enter, on the western edge. The `start` set
  piece class owns its spawns.
- **Strategy:** the decomposer picks one subregion for spawns, and its
  builder does the `entry` builder's job, grown up: spread every spawn point
  with roughly equal spacing over that subregion (17, September 22),
  then cover and loot around them. The live game puts a pistol near every
  start (14).
- **Core elements:** `spawn` × `contestantCount`. A `spawn` is one
  contestant's spawn point, and one `arrival` region holds every spawn point
  on the map (Corey, 2026-10-02, 17 M20). There's no anchor: the old single
  spawn was a tile anchor (51, "Core elements").
- **Shape needs:** room for every contestant's point at the spacing chosen.
  The live adapter uses these spread sites directly (14). The old street
  generator's 400-unit spacing is not a requirement here.
- **Formed by:** `start` set pieces only.
- **Parameters:** the spacing.
- **Material:** the game's `example-entry` and `spreadPoints`.

### `departure`

- **Role:** the far east, where contestants extract and hunters start. The
  `end` set piece class owns its exits and its hunter spawns.
- **Strategy:** site `exitCount` extraction points and every hunter's spawn
  point, with the hunters' starts set back from the exits so the hunt begins
  as a pursuit.
  **Built (#131):** `map/micro/strategies/departure.ts`. No decomposer yet:
  it takes the region whole. Exits are spread farthest-first, so they sit as
  far apart as the region allows, and may share one corridor (17 M13's
  assumption, keep the tip). Hunters' spawns are spread over the ground at
  least the set-back from every exit. Cover and loot fill around both, as in
  `arrival`. What doesn't fit is a shortfall for the report.
- **Core elements:** `exit` × `exitCount`, `hunter-spawn` × `hunterCount`,
  one hunter spawn point per hunter, the same way as spawns (Corey,
  2026-10-02, 17 M20). 51 keeps the hunter spawns in `end` "for simplicity
  right now" (Corey, 2026-09-28).
- **Shape needs:** room for the exits apart from each other. How far apart,
  and whether they share the diamond's narrow tip, is 17 M13.
- **Formed by:** `end` set pieces only.
- **Parameters:** `exitSpacing`, a floor on the distance between exits in
  cells, none by default. `setBack`, the least distance in cells from a
  hunter's spawn to any exit: *proposed* 6, one tile.

### `charging`

- **Role:** the power-cell charging station (F-03). A contestant stands still
  in range for five seconds (14), so the station is a moment of exposure.
- **Strategy:** site one charger with standing room around it, and cover close
  enough to make the wait a choice rather than a death.
  **Built (#132):** `map/micro/strategies/charging.ts`. No decomposer yet: it
  takes its region whole. The charger stands as near the region's middle as a
  contestant fits and can walk to from the first portal. Cover and loot keep
  off the standing room around it. Then, if no cover already stands within 2
  cells of that room (*proposed*, a doorway's width), one container is added
  there, keeping cover's aisles, where the region has room. A pad too small
  for that, like the fixture's 2 × 2, takes its cover from its neighbours.
  What doesn't fit is a shortfall for the report.
- **Core elements:** `charger` × 1.
- **Shape needs:** room for the station and its stand. Spacing rules that
  reach into other regions, such as the live game's traps 850 units from a
  charger (14), are deferred (17 M22).
- **Formed by:** `charger` set pieces only.
- **Parameters:** `standing`, the radius in cells kept clear around the
  charger: *proposed* 2, which covers the live game's 70-unit charging range
  at 40 units a cell (14).

### `transit`

The hunters' private transit network (P-09), and their respawn points (14).
Corey brought it into the live checkpoint on 2026-10-03 (17). The `transit`
set piece class owns one `warp` per instance, and its region strategy sites it.
`map/micro/strategies/transit.ts` uses hunter clearance and first-portal access,
then keeps two cells of standing space free of cover and loot. Nearby cover
uses the existing cover strategy. Insufficient space leaves a report shortfall.
Macro distributes the authored instances (52); the live adapter only converts
these sites to stations. Initial hunter spawns remain departure's responsibility.

## Today's names

The old library's classes (`market`, `depot`, `park`, `landing`, `evac`,
`tree`, `rock`, `rubble`, `hut`), all bound to `open-field`, and its set
pieces' primary classes (`market`, `industrial`, `landing`, `military`) are
material only (52, "The old library"). The chain's fixture libraries use
`open`, `hut`, `arrival`, `departure` and `charging`, and this catalogue
keeps those names.

The old names come back like this (17.2.7):

| Old class | Region type |
| --- | --- |
| `landing` | `arrival` |
| `evac` | `departure` |
| `rock`, `rubble` | `rubble` |
| `tree`, `park` | `park` |
| `hut` | `hut` |
| `depot` | `depot` |
| `market` | `market` |
| `industrial` | `depot` for its sheds, `plant` for its works |
| `military` | `compound` for its walled bases, `checkpoint` for its chokes |

## Material to mine, by type

| Type | The game (`map/micro/`) | mapgen (`src/micro/builders/`, deleted in #146; in git history) |
| --- | --- | --- |
| `open` | — (it builds nothing) | — |
| `cover` | `example-open` (built, #127) | `open-field`, `scatter` |
| `rubble` | `example-ruins` decay (built, #128) | `rubble` |
| `ruins` | `example-ruins` (built, #157) | — |
| `hall` | — | `pillar-hall` (built, #158) |
| `hut` | the room shell in `builders.ts` (built, #129) | `compound` |
| `depot` | `example-depot` (built, #159) | — |
| `compound` | `example-courtyard`, 19's ring example (built, #160) | `courtyard`, `compound` |
| `block` | `decomposition/example.ts`, `realize.ts`, `negotiate.ts` (built on spacing instead, #161) | — |
| `market` | `hall` (its stand-in) | `pillar-hall` |
| `plant` | `depot`'s warehouse for its shed (built, #219) | — |
| `checkpoint` | `cover`'s barriers and `depot`'s warehouse for its post (built, #220) | — |
| `park` | `cover`'s spacing, its clusters' aisles (built, #221) | `open-field` |
| `arrival` | `example-entry`, `spreadPoints` | — |
| `departure` | `spreadPoints` (built, #131) | — |
| `charging` | `spreadPoints` (built, #132) | — |
