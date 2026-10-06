# 55. Zone plans

Status: accepted direction, 2026-10-03 (17, "Zone plans and library modules").
The diamond is implemented as the one plan, in
`map/macro/src/chain/zone-plan.ts` (#166). Libraries declare their plan and size and resolve shared modules (schema 3,
[52](52-map-primitives-and-library.md), #168). The diamond is authored at
12 × 6, 24 × 12 and 36 × 18 (#171).

A **zone plan** is a map's macro shape: the paradigm the live game and the
generator share about where a match starts, widens, funnels and ends. This
file is the one statement of it. Other files link here instead of restating
the grid, the mask, the sizes or where placement rules may anchor.

The live game is meant to support a variety of plans in time. The diamond is
the first: "a convenient starting place" that "gives the expanding and
funnelling arc of the game" (Corey, 2026-10-03, 17).

"Layout" already names placement's output (51 stage 1), so the shape is called
a plan.

## Who authors what

| Owner | Authors | Where |
| --- | --- | --- |
| The zone plan | The zone grid and which zones are occupied; each zone's tier and bonus; the zone sizes it accepts and its default; where each placement rule may anchor, as fractions of the map | `zone-plan.ts` |
| A library, one per plan and size | Cell classes, tiles, tile sets and set pieces; which set pieces belong to which class; each class's quota and the core elements it owns | `map/macro/content/` (52) |
| Region strategies | Everything physical inside a region | `map/micro/` (54, 20) |

- **Hand authored per size.** Quotas, class membership and footprint sizes
  stay hand authored for each plan and size. The plan doesn't scale them
  (Corey, 2026-10-03, 17). A piece that is enormous at one size may be medium
  at another.
- **Sizes are authored, not free.** Game mode accepts only the zone sizes a
  library is authored for. Playground mode accepts any size (51).
- **Rule names are the engine's.** The placement rules (`start`, `end`,
  `enormous`, `medium`, `small`, `charger`, `transit`) are the engine's
  vocabulary. A library's set piece class names the rule it uses (52), and the
  plan says where that rule may anchor.

## The diamond

The zone grid is 5 × 5, and 13 zones are occupied: those within two steps of
the centre by Manhattan distance. Each cell below is tier + bonus, as the
design notes draw it:

```
X X 5 X X
X 3 4 3 X
1 2 3 4 5
X 3 4 3 X
X X 5 X X
```

- **Tier** is horizontal progression: the zone column plus one, 1 to 5.
  Entry is the western tip, and exits are at the eastern edge.
- **Bonus** is the novelty axis: zone rows away from the middle, 0 to 2. How
  tier and bonus combine is 17 M16; the code keeps them separate. Loot rises
  by tier (52, "Tier zones and the mask").
- **Size:** every zone is `zoneWidth × zoneHeight` tiles, so the map's grid is
  `5 × zoneWidth` by `5 × zoneHeight` tiles. The map is exactly the tiles the
  occupied zones cover, and its boundary stair-steps.
  - The authored sizes are 12 × 6, the default, 24 × 12 and 36 × 18 (#171),
    each with its own library (52). At 6 cells a tile and 48 world units a
    cell, the live map is 17,280 by 8,640 (14).
  - A room can be created at any authored size as a lobby choice (#184, 14);
    the default and matchmade rooms stay 12 × 6. Per-tick and client cost
    at each size is in 42: 36 × 18 exceeds the tick budget at p95 for a
    single room. The larger sizes are also in generation, the Map Lab, CLI,
    MCP and tests.

### Where placement rules anchor

Fractions are of the map's columns and rows, in tiles, so the regions scale
with zone size. A piece's anchor is its western column; `width` is its extent
in tiles.

| Rule | May anchor |
| --- | --- |
| `start` | touching the western edge |
| `end` | reaching the eastern edge |
| `enormous` | inside the middle half of columns; instance *n* in vertical third *n* mod 3 |
| `medium` | starting in the western third, or reaching into the eastern third |
| `small`, `charger` | anywhere |
| `transit` | one band per instance across the central 76% of columns (12% to 88%), each band inset by a tile on both sides so neighbouring transit regions can't merge |

The order rules place in and how a class's pieces are drawn belong to
placement (51 step 4). Quotas belong to the library (52).
