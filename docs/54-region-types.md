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
| *transit* | core element, deferred | the hunters' transit stations (P-09) | `warp`, deferred (51) |

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
  pieces, as the example builders do (20).
- **Shape needs:** none. A region too small for one piece stays clear.
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
- **Shape needs:** *proposed*, a contained rectangle of at least 6 × 6.
- **Formed by:** medium and enormous set pieces.
- **Parameters:** `spacing`, and whether it is roofed.
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
- **Shape needs:** *proposed*, at least 10 × 10.
- **Formed by:** medium and enormous set pieces.
- **Parameters:** `density`, `roomCells`.
- **Material:** the game's `example-depot`.

### `compound`

- **Role:** rooms in a ring around a walled court, with two or three gates.
  A pocket that rewards a contestant who knows its gates and traps one who
  doesn't. It is where dead ends live.
- **Strategy:** a builder puts the ring on the region's outline and the court
  inside, and places gates so every portal reaches the court. A region with a
  hole suits it whole, as 19's ring example does.
- **Shape needs:** *proposed*, at least 10 × 10, with a court of at least
  4 × 4.
- **Formed by:** medium and enormous set pieces.
- **Parameters:** gate count.
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
  The live game spaces starts 400 units apart, 10 cells at 40 units a cell
  (14). That is a live tuning value, not a requirement here.
- **Formed by:** `start` set pieces only.
- **Parameters:** the spacing.
- **Material:** the game's `example-entry` and `spreadPoints`.

### `departure`

- **Role:** the far east, where contestants extract and hunters start. The
  `end` set piece class owns its exits and its hunter spawns.
- **Strategy:** site `exitCount` extraction points and every hunter's spawn
  point, with the hunters' starts set back from the exits so the hunt begins
  as a pursuit.
- **Core elements:** `exit` × `exitCount`, `hunter-spawn` × `hunterCount`,
  one hunter spawn point per hunter, the same way as spawns (Corey,
  2026-10-02, 17 M20). 51 keeps the hunter spawns in `end` "for simplicity
  right now" (Corey, 2026-09-28).
- **Shape needs:** room for the exits apart from each other. How far apart,
  and whether they share the diamond's narrow tip, is 17 M13.
- **Formed by:** `end` set pieces only.
- **Parameters:** exit spacing.

### `charging`

- **Role:** the power-cell charging station (F-03). A contestant stands still
  in range for five seconds (14), so the station is a moment of exposure.
- **Strategy:** site one charger with standing room around it, and cover close
  enough to make the wait a choice rather than a death.
- **Core elements:** `charger` × 1.
- **Shape needs:** room for the station and its stand. Spacing rules that
  reach into other regions, such as the live game's traps 850 units from a
  charger (14), are deferred (17 M22).
- **Formed by:** `charger` set pieces only.

### *transit* (deferred)

The hunters' private transit network (P-09), and their respawn points (14).
51 lists `warp` as a core element and defers it. Whether `warp` is the
transit station, and which set piece class would own it, stays deferred with
the catalogue (17 M18).

## Today's names

Today's library classes (`market`, `depot`, `park`, `landing`, `evac`,
`tree`, `rock`, `rubble`, `hut`), all bound to `open-field`, and its set
pieces' primary classes (`market`, `industrial`, `landing`, `military`) are
material only (52, "Today's library"). The chain's fixture libraries use
`open`, `hut`, `arrival`, `departure` and `charging`, and this catalogue
keeps those names.

## Material to mine, by type

| Type | The game (`map/micro/`) | mapgen (`src/micro/builders/`, retiring) |
| --- | --- | --- |
| `open` | — (it builds nothing) | — |
| `cover` | `example-open` | `open-field`, `scatter` |
| `rubble` | `example-ruins` decay | `rubble` |
| `ruins` | `example-ruins` | — |
| `hall` | — | `pillar-hall` |
| `hut` | the room shell in `builders.ts` | `compound` |
| `depot` | `example-depot` | — |
| `compound` | `example-courtyard`, 19's ring example | `courtyard`, `compound` |
| `block` | `decomposition/example.ts`, `realize.ts`, `negotiate.ts` | — |
| `arrival` | `example-entry`, `spreadPoints` | — |
| `departure` | `spreadPoints` | — |
| `charging` | — | — |
