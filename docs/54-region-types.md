# 54. Region types

Status: every type in the catalogue below has a strategy registered in
`REGION_TYPES` (`map/micro/region-types.ts`), and the shipped libraries use
them all; the drafted `market` is bound to `hall`'s strategy until its own is
written. First drafted 2026-10-02 (B2, #85). Corey's answers to its questions,
17 M18 to M25, are recorded in 17 and applied here. The catalogue itself stayed
deferred (M18): B3 and B4 built its minimal set to hook the chain up top to
bottom, and further types followed. Marked proposals and numbers are not
requirements until Corey adopts them (53, "Provenance rule").

This is the catalogue the new library (B4) and its strategies (B3) are built
against. A cell class names a region type (52), and the type's strategy fills
each layout region of that class (51 stage 6). The game's example builders (retired
in #483, in git history) and mapgen's six are material for these types, not
constraints (51 track B).

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

**Minimal first set** for B3 and B4, proposed then and since built: `open`,
`cover`, `rubble`, `hut`, `arrival`, `departure` and `charging`. That was enough to hook the chain
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
  **Built (#127):** `map/micro/strategies/cover.ts`. It keeps slot spacing and
  uses boundary or corridor checks according to its portal count (20.3). Its
  boundary mode, past 32 portals, avoids a route search for every portal.
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#cover-builder).
  - **Historical audit:** A #361 audit of every `cover` and `plant` region
    past 32 portals in the sweep and 20 maps each of the 24 × 12 and 36 × 18
    libraries found no sealed portal (42); `park` and `depot`, which did seal,
    now protect routes.
  - **Loot:** each cell rolls its chance and takes its tier. Loot lands only
    where the cell and its eight neighbours are owned and free of cover, so
    it has standing room.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
- **Shape needs:** none. A region too small for a piece stays clear.
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
  Then it stands `ruin-wall` walls along every hinted run where no debris
  or route is (`wallHints`, 20.3; #407).
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
  After its rooms, it stands quarter-cell `ruin-wall` walls along every
  hinted run where no piece or route is (`wallHints`, 20.3; #407).
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#ruins-builder).
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
  lattice on it, and keeps the rest of the region clear but for walls along
  its hints.
  **Built (#158):** `map/micro/strategies/hall.ts`. It protects the portal
  approaches and hunter routes as `rubble` and `ruins` do, and drops any
  pillar that would touch them. Then it stands quarter-cell `building` walls
  along every hinted run where no pillar or route is (`wallHints`, 20.3;
  #407). `market`, bound to `hall`, gets them too.
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#hall-builder).
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
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#checkpoint-builder).
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every piece, indoors or out.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no post and no barrier placed goes to
    `open` (17 M24).
- **Shape needs:** *proposed*, a chicane needs two portals and 3 cells across
  the line, and a post needs a contained 6 × 5 footprint. Either alone is
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
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#park-builder).
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
- **Strategy:** a builder picks a contained rectangle for the building, puts
  its door where the yard keeps every portal joined, and leaves the yard around
  it. A route through the building counts only through unlocked doors. After
  siting the house, it may delegate unused yard lobes to `cover` while retaining
  the two-cell house yard and a hunter standing-block route from the doorstep to
  the original entrances (20.7).
  **Built (#129), with larger houses since L5 (#192, 56):**
  `map/micro/strategies/hut.ts`. It reasons in cells, where a hunter is a
  2 × 2 block of yard cells, using cell-level connectivity and circulation.
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#hut-builder).
  - **Yard delegation pilot (#330, built as `types-24`):** connected unused yard
    components of at least 9 cells are offered to `cover` with reason
    `unused-yard-lobe`. The key names the canonical first cell as
    `yard:<x>,<y>`; the owning snapshot records the full footprint. Within one
    generation invocation, cover's receiving check and child build reuse the
    preview cached by exact child brief. An offer with no usable cover
    placement is rejected and its cells remain with the hut. A small `block`
    lot can have no suitable lobe, so nested huts do not imply cover uptake.
    Ownership retains the house box expanded by 2 cells in each direction,
    and the two-cell perimeter band. Hunter standing-block paths join the
    doorstep to each original portal, favoring existing retained yard with
    zero-cost steps.
    The bounded pilot-yard sample and its content-balance caveat are in [42.3](42.3-generation-and-delegation-evidence.md#hut-pilot-yard-sample).
  - **Why that keeps the promise:** the retained house yard and the standing-
    block route connect the doorstep to each original entrance. Only connected
    unused lobes are offered, and accepted children keep their paired crossing
    interface (20.7). Core counts and portal obligations remain with the hut;
    the pilot adds no core exclusion or loot overhaul. With no usable fill or
    no house with a reachable doorstep, the hut takes the terminal empty path;
    original requested core counts remain for reporting. For example, an
    incapable 2 by 3 hut is now terminal empty and loses the open-zone loot it
    formerly produced.
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of the walls and the door, indoors or out. Retained hut
    loot rolls in canonical cell order and is clipped to retained ownership;
    delegated cover uses its existing
    loot behavior.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
- **Shape needs:** *proposed*, a contained 4 × 4 for the one-space house; the
  larger designs use their listed box sizes. The region needs no extra extent
  margin around the house.
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
  aisles between pieces by spacing, in the reduced fill, with corridor or
  boundary checks as `cover` uses.
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#depot-builder).
  - **Historical timing:** The tree costs about 0.1 s on a 54-portal,
    6,480-cell depot, so depot builds it at every portal count (42).
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
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#plant-builder).
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
  stands one compound in a contained box. The box can touch hinted perimeter
  while portal approaches and usable gate doorsteps stay clear.
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#compound-builder).
  - **Loot:** each cell rolls its chance and takes its tier, wherever a loot
    disc stands clear of every wall and door, in the rooms, the court or the
    retained yard. Delegated cover uses its existing loot behavior.
  - **Exterior-yard delegation (#338, `types-25`):** after the ring is built,
    reserve its entire court/room box, two-cell approach and perimeter bands,
    and hunter swept routes joining every original portal and actual gate yard
    stand. Narrow circulation strips stay retained; a component needs a 3×3
    yard pocket before it is considered for cover. Connected exterior components may go to cover only if the exact
    inherited interface yields usable content. Refused cells stay retained.
    The owning executor, protection, footprint identity and snapshot contracts
    are specified in [20.7](20.7-builder-delegation.md); measured balance is in
    [42.3](42.3-generation-and-delegation-evidence.md#compound-exterior-yard-adoption-338-2026-10-13). This also applies within block lots.
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no usable contained box of at least 10 × 10
    or no ring with accessible gates takes terminal empty (20.7), preserving
    original ownership and requests without geometry or loot.
    Large original ownership does not imply usable fill: internal guaranteed
    margins can prevent every minimum ring box. The exact #340 diagnosis and
    reproduction and the later `military-quarter` content correction are recorded
    in [42](42-performance-history.md). The original constrained brief still falls
    back; [52](52-map-primitives-and-library.md) supplies suitable authored joins
    for the corrected blueprint.
- **Shape needs:** *proposed*, a compound of at least 10 × 10, with a court of
  at least 4 × 4, plus usable portal approaches and gate doorsteps.
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
  - **Builder mechanics:** [20.3](20.3-builders-decomposition.md#block-builder).
  - **Core elements:** it sites none. Any its brief lists are left for the
    report.
  - **Too small:** a region with no viable 6 × 6 lot and its two usable
    frontages goes to `open` (17 M24).
- **Obligations:** every two children that share a boundary have at least
  one portal between them (51 stage 6, Corey 2026-10-01). Each child keeps its
  own promise, so the block's portals are joined by inference. As built, lots
  touch only the alleys, through their frontages.
- **Shape needs:** *proposed*, at least two tiles' worth, 72 cells. As built,
  a contained 12 × 12 for one lot with its alley.
- **Formed by:** enormous set pieces (`city-block`, 52).
- **Parameters:** none yet. Each lot's type takes its own defaults.
- **Material:** `decomposition/example.ts` and the retired demonstration
  strategy `decomposition/realize.ts` (#483, in git history).

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
  it takes the region whole. Its placement and fill mechanics are in [20.3](20.3-builders-decomposition.md#departure-builder).
  Exits, hunter spawns, cover and loot that do not fit are reported as shortfalls.
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
  takes its region whole. Its placement and fill mechanics, including the marked proposal, are in
  [20.3](20.3-builders-decomposition.md#charging-builder).
  Its charger needs first-portal access and clear standing room. If cover does
  not already stand within 2 cells of that room, adding one container is a
  *proposed* content choice; a pad without room takes cover from its neighbours.
  A charger or cover that does not fit is reported as a shortfall.
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
`map/micro/strategies/transit.ts` is implemented; its placement and fill
mechanics are in [20.3](20.3-builders-decomposition.md#transit-builder).
The station needs hunter clearance and access from the first portal, and
keeps two cells of standing room free of cover and loot. Insufficient space
leaves a report shortfall.
Macro distributes the authored instances (52); the live adapter only converts
these sites to stations. Initial hunter spawns remain departure's responsibility.

## Today's names

The old library's classes (`market`, `depot`, `park`, `landing`, `evac`,
`tree`, `rock`, `rubble`, `hut`), all bound to `open-field`, and its set
pieces' primary classes (`market`, `industrial`, `landing`, `military`) are
material only (52, "The old library"). The chain's shipped libraries use this
catalogue's names; the first fixture libraries used only `open`, `hut`,
`arrival`, `departure` and `charging`.

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

A record of what each type's strategy drew from; the types are built (Status,
above).

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
| `block` | `decomposition/example.ts`, the retired `realize.ts` and `negotiate.ts` (built on spacing instead, #161) | — |
| `market` | `hall` (its stand-in) | `pillar-hall` |
| `plant` | `depot`'s warehouse for its shed (built, #219) | — |
| `checkpoint` | `cover`'s barriers and `depot`'s warehouse for its post (built, #220) | — |
| `park` | `cover`'s spacing, its clusters' aisles (built, #221) | `open-field` |
| `arrival` | `example-entry`, `spreadPoints` | — |
| `departure` | `spreadPoints` (built, #131) | — |
| `charging` | `spreadPoints` (built, #132) | — |
