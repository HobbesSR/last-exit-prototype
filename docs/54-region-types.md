# 54. Region types

Status: every type in the catalogue below has a strategy registered in
`REGION_TYPES` (`map/micro/region-types.ts`), and the shipped libraries use
them all. Each type now has its own strategy, including `market` (#534).
First drafted 2026-10-02 (B2, #85). Corey's answers to its questions,
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

These hold for every entry in the catalogue's parts (54.1 to 54.4), so the entries don't repeat them.

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
  in the entries are proposals.
- **Fitting the region** (Corey, 2026-10-02, 17 M24): the type's decomposer
  decides. If it can't make a subregion with what one of the type's builders
  needs, it may hand that subregion to a different builder, and the `open`
  builder is always the last resort. A type with no decomposer takes
  its region whole. A core element class that can't site its core elements
  leaves the shortfall for the report (51 stage 8).
- **Decoration keeps the promise.** Cosmetic decay, damage markings and color
  treatments never change a region's collision geometry or its portal promise
  ([29.4](29.4-drawing.md)). How types tell districts and landmarks apart is
  11.1 §7's direction, staged in #586.

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

## Navigation structure

Corey's direction (2026-10-30, [17.2.11](17.2.11-navigation-structure-direction.md)):
the catalogue and its content are stand-ins until he gives authorship direction.
Content should leave much less empty space and make movement need exploration:
barriers that deflect a path relative to its target, and emergent dead ends in the
walkable space that sometimes force backtracking. Density alone does not do this.

The contract already allows it. The one promise joins portals to portals; a
region's interior, and reaching it, are its builder's business
([20.6](20.6-passable-margins.md)), and a one-portal region is a dead end by the
table above.

*Observation, unmeasured until #688:* paths across current maps are close to
straight. Most builders keep a complete clear ring around every piece and space
pieces apart: hut's additional houses, market's stalls, depot's warehouses and
rows, and the hint-aware box filter in `map/micro/hints.ts`. A walker can pass on
either side of any isolated convex piece, so many pieces add little detour and no
dead ends. That ring is a builder choice, not an obligation of the contract; Corey
described the early two-cell collar as pragmatic, meeting no thematic requirement
(17.2.10).

*Proposed levers, not requirements:*

- **Within a region:** long, connected barriers instead of ringed islands: pieces
  that join each other or grow inward from the not-guaranteed-passable fill
  perimeter, forming peninsulas and pockets. Movable portal cords keep the
  portal-to-portal routes while that growth pushes them around
  ([20.10](20.10-portal-cords.md), growth helpers #649). That is one candidate
  support; static authored barriers checked with the SDK's elective validation are
  another. Pockets off the portal routes are the dead ends.
- **Across the map:** fewer portals per region boundary, longer impassable
  boundary runs and more one-portal regions. However winding each region is,
  crossing the map stays straight while region boundaries are porous.

Judge content work by its effect on detour, dead-end area and empty space, measured
as proposed in [51.10](51.10-measurement.md), not by occupied cells or piece
counts.

## The catalogue

| Type | Family | Role in play | Core elements |
| --- | --- | --- | --- |
| [`open`](54.1-ground-and-friction.md#open) | ground | circulation: the clear ground everything else sits in | — |
| [`cover`](54.1-ground-and-friction.md#cover) | friction | scattered cover on open ground, for fights and sightlines | — |
| [`rubble`](54.1-ground-and-friction.md#rubble) | friction | contestant-only squeezes beside a longer hunter route | — |
| [`ruins`](54.1-ground-and-friction.md#ruins) | friction | broken walls and part-buildings: maze-like friction and partial sight | — |
| [`hall`](54.1-ground-and-friction.md#hall) | friction | a pillared lattice that breaks sight without blocking a walk | — |
| [`checkpoint`](54.2-structures.md#checkpoint) | friction | a military choke: chicane barriers across a passage, a guard post | — |
| [`park`](54.2-structures.md#park) | friction | overgrown ground: tree clumps and hedge runs with door-wide gaps, soft cover, open sight | — |
| [`hut`](54.2-structures.md#hut) | structure | one building in its yard: walls, door, windows, roof | — |
| [`depot`](54.2-structures.md#depot) | structure | warehouses and container aisles: long sightlines, hard corners | — |
| [`plant`](54.2-structures.md#plant) | structure | an industrial works: machinery blocks, pipe runs, long lines | — |
| [`compound`](54.2-structures.md#compound) | structure | rooms around a walled court with few gates: a pocket with dead ends | — |
| [`block`](54.3-district-and-drafted.md#block) | district | a city block that decomposes into the types above | — |
| [`market`](54.3-district-and-drafted.md#market) | district | stall rows and narrow lanes: dense, low, sight-breaking cover | — |
| [`arrival`](54.4-core-element-classes.md#arrival) | core element | the contestants' start | `spawn` × `contestantCount` |
| [`departure`](54.4-core-element-classes.md#departure) | core element | extraction and the hunters' start | `exit` × `exitCount`, `hunter-spawn` × `hunterCount` |
| [`charging`](54.4-core-element-classes.md#charging) | core element | the power-cell charging station (F-03) | `charger` |
| [`transit`](54.4-core-element-classes.md#transit) | core element | the hunters' transit stations (P-09) | `warp` |

**Minimal first set** for B3 and B4, proposed then and since built: `open`,
`cover`, `rubble`, `hut`, `arrival`, `departure` and `charging`. That was enough to hook the chain
up top to bottom, with every stage, every core element class, and the
contestant-only asymmetry (P-04).

## Reading guide

Load the shared rules above, then the part that holds the type being changed.
Builder mechanics are in [20.3](20.3-builders-decomposition.md).

| Part | Load for |
| --- | --- |
| [54.1](54.1-ground-and-friction.md) | The `open` ground and the friction types: `cover`, `rubble`, `ruins` and `hall`. |
| [54.2](54.2-structures.md) | The structure section: `checkpoint`, `park`, `hut`, `depot`, `plant` and `compound`. The catalogue table lists `checkpoint` and `park` in the friction family; their entries sit in this section. |
| [54.3](54.3-district-and-drafted.md) | The `block` district, which decomposes into the other types, and `market` stall rows. |
| [54.4](54.4-core-element-classes.md) | The core element classes: `arrival`, `departure`, `charging` and `transit`. |

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
| `market` | Dedicated `market-stall` rows and awnings (#534) | Former stand-in: `pillar-hall` via `hall` |
| `plant` | `depot`'s warehouse for its shed (built, #219) | — |
| `checkpoint` | `cover`'s barriers and `depot`'s warehouse for its post (built, #220) | — |
| `park` | `cover`'s spacing, its clusters' aisles (built, #221) | `open-field` |
| `arrival` | `example-entry`, `spreadPoints` | — |
| `departure` | `spreadPoints` (built, #131) | — |
| `charging` | `spreadPoints` (built, #132) | — |

## Earlier heading links

These landing links preserve bookmarks into the former single file.

<a id="ground"></a>

- Ground: [54.1](54.1-ground-and-friction.md#ground).

<a id="open"></a>

- `open`: [54.1](54.1-ground-and-friction.md#open).

<a id="friction"></a>

- Friction: [54.1](54.1-ground-and-friction.md#friction).

<a id="cover"></a>

- `cover`: [54.1](54.1-ground-and-friction.md#cover).

<a id="rubble"></a>

- `rubble`: [54.1](54.1-ground-and-friction.md#rubble).

<a id="ruins"></a>

- `ruins`: [54.1](54.1-ground-and-friction.md#ruins).

<a id="hall"></a>

- `hall`: [54.1](54.1-ground-and-friction.md#hall).

<a id="structures"></a>

- Structures: [54.2](54.2-structures.md#structures).

<a id="checkpoint"></a>

- `checkpoint`: [54.2](54.2-structures.md#checkpoint).

<a id="park"></a>

- `park`: [54.2](54.2-structures.md#park).

<a id="hut"></a>

- `hut`: [54.2](54.2-structures.md#hut).

<a id="depot"></a>

- `depot`: [54.2](54.2-structures.md#depot).

<a id="plant"></a>

- `plant`: [54.2](54.2-structures.md#plant).

<a id="compound"></a>

- `compound`: [54.2](54.2-structures.md#compound).

<a id="district"></a>

- District: [54.3](54.3-district-and-drafted.md#district).

<a id="block"></a>

- `block`: [54.3](54.3-district-and-drafted.md#block).

<a id="drafted-types"></a>

- Former drafted types: [54.3](54.3-district-and-drafted.md#market); `market` now has its own builder.

<a id="market"></a>

- `market`: [54.3](54.3-district-and-drafted.md#market).

<a id="core-element-classes"></a>

- Core element classes: [54.4](54.4-core-element-classes.md#core-element-classes).

<a id="arrival"></a>

- `arrival`: [54.4](54.4-core-element-classes.md#arrival).

<a id="departure"></a>

- `departure`: [54.4](54.4-core-element-classes.md#departure).

<a id="charging"></a>

- `charging`: [54.4](54.4-core-element-classes.md#charging).

<a id="transit"></a>

- `transit`: [54.4](54.4-core-element-classes.md#transit).
