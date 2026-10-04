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
| `hut` | structure | one building in its yard: walls, door, windows, roof | — |
| `depot` | structure | warehouses and container aisles: long sightlines, hard corners | — |
| `compound` | structure | rooms around a walled court with few gates: a pocket with dead ends | — |
| `block` | district | a city block that decomposes into the types above | — |
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
    barriers and containers inside a 3 × 3 box.
  - **The aisle:** a cluster's bounding box keeps 3 clear cells from the next
    cluster's and from any cell the region doesn't own. That is a door's
    width plus one, which the sampled route check can see (20).
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
- **Formed by:** small and medium set pieces, between open areas.
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
- **Formed by:** medium and small set pieces, and as a child of `block`.
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
    axis, drawn from the seed, by about half a period. The stride never
    divides the period, so a sightline down the other axis meets a pillar
    within a few lines. That axis keeps clean lanes. Staggering both would
    pinch pillar corners together.
  - **The roof:** with `roofed`, the rectangle is one enclosing element, so a
    roof hides what's under it as a building's does.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every pillar.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no such rectangle goes to `open` (17 M24).
- **Shape needs:** *proposed*, a contained rectangle of at least 6 × 6.
- **Formed by:** medium and enormous set pieces.
- **Parameters:** `spacing`, whole cells from 4 (5 by default), and
  `roofed`, true or false (false by default).
- **Material:** mapgen's `pillar-hall`.

## Structures

Buildings give concealment (P-11, F-18): solid walls and roofs hide what's
inside, and windows and doors let sight through.

### `hut`

- **Role:** one small building in its yard, with walls, a door, windows and a
  roof. It is 52's worked case: four corner blocks across a tile junction form
  one 6 × 6 region, and the hut stands anywhere inside it.
- **Strategy:** no decomposer. A builder picks a contained rectangle for the
  building, puts its door where the yard keeps every portal joined, and leaves
  the yard around it. A route through the building counts only through
  unlocked doors.
  **Built (#129):** `map/micro/strategies/hut.ts`. It reasons in cells, where
  a hunter is a 2 × 2 block of yard cells, so it needs no route search.
  - **The size:** a region less than 6 cells across on either axis goes to
    `open` before any box is tried, even where a box and its doorstep would
    fit. The L and the ring count by their extent, not by a contained 6 × 6.
  - **The box:** it tries the region's contained 4 × 4 boxes in a seeded
    order, and takes the first that stays off every portal's approach (the
    two cells inward along it), leaves joined every two portals the empty
    region joined, and has a side whose doorstep the yard joins to a portal.
    A box with a clear ring 2 cells wide passes the last two by shape alone.
  - **The house:** it stands a quarter cell inside its box, 3½ cells square,
    with quarter-cell walls and a roof. The door is a doorway wide, centred on
    the doorstep's side, and a window as wide faces it. The inset makes a
    door-wide yard visible to the sampled route check (20). With one door, no
    route runs through the house.
  - **Why that keeps the promise:** the house takes only its box, so the yard
    joins what the empty region joined. A region with no such box, such as
    the fixture's 2 × 3 huts, goes to `open` (17 M24), so a `hut` region keeps
    the portal promise exactly when its shape does.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of the walls and the door, indoors or out.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
- **Shape needs:** *proposed*, a contained 4 × 4 for the building, in a
  region of at least 6 × 6.
- **Formed by:** small set pieces, and as a child of `block`.
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
  - **Lanes:** everything lines up on lanes 4 cells apart along one axis,
    drawn from the seed, at a seeded phase.
  - **Warehouses:** `roomCells` long and three quarters of that across, at
    least 5, with quarter-cell walls and a roof. A doorway-wide door is
    centred on each end. Shelf islands a cell across run down the length,
    keeping 2 cells from the walls and from each other, so the doors open
    onto clear ends. They stand at seeded places on the lanes until about
    `density` of a quarter of the ground is taken.
  - **Container rows:** two or three 2-cell containers end to end, packed
    along each lane around the warehouses. Each place that fits one is taken
    with chance `density`, and the next starts 3 cells on, so the aisles run
    long and end in hard corners.
  - **Why that keeps the promise:** every piece's box keeps 3 clear cells
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
- **Formed by:** medium and enormous set pieces.
- **Parameters:** `density`, from 0 to 1 (0.55 by default), and `roomCells`,
  whole cells from 6 to 16 (8 by default).
- **Material:** the game's `example-depot`.

### `compound`

- **Role:** rooms in a ring around a walled court, with two or three gates.
  A pocket that rewards a contestant who knows its gates and traps one who
  doesn't. It is where dead ends live.
- **Strategy:** a builder puts the ring on the region's outline and the court
  inside, and places gates so every portal reaches the court. A region with a
  hole suits it whole, as 19's ring example does.
  **Built (#160):** `map/micro/strategies/compound.ts`. No decomposer. It
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
    with a door a doorway wide onto the court.
  - **Dead ends:** a 3 × 3 room stands at each corner. It opens only into its
    neighbour along the north or south side, a room or a gate's passage.
  - **Gates:** `gates` sides, drawn from the seed, each have a passage 3
    cells wide through the ring at a seeded place, from a door in the outer
    wall to the court. The passage widens to the corner where what's left
    would be too short for a room. The rest of the ring is closed.
  - **The court:** the open ground inside the ring, at least 4 × 4. It holds
    nothing but loot.
  - **The lattice:** every door's centre, and each passage's width, are set
    so the sampled route search sees a hunter through them (20).
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
- **Formed by:** medium and enormous set pieces.
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
- **Obligations:** every two children that share a boundary have at least
  one portal between them (51 stage 6, Corey 2026-10-01). Each child keeps its
  own promise, so the block's portals are joined by inference.
- **Shape needs:** *proposed*, at least two tiles' worth, 72 cells. Today's
  decomposition contexts stop at 4,096 cells and 64 per axis, which this type
  raises when it is built (20, "Next boundaries").
- **Formed by:** enormous set pieces.
- **Material:** `decomposition/example.ts` and `decomposition/realize.ts`, the
  demonstration strategy.

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
| `block` | `decomposition/example.ts`, `realize.ts`, `negotiate.ts` | — |
| `arrival` | `example-entry`, `spreadPoints` | — |
| `departure` | `spreadPoints` (built, #131) | — |
| `charging` | `spreadPoints` (built, #132) | — |
