# Planned generation

A second generator, built beside the legacy one rather than replacing it. `core.generateMap` is untouched and still works; `plan/compose.generatePlannedMap` is the new path. Naming is fixed by [Vocabulary and layering](VOCABULARY.md).

## Why a second path

The legacy generator composes authored tiles, discovers regions from the cell classes that fall out, and only then finds out what it built. Nothing knows whether the map is walkable until the whole thing exists.

That is survivable until micro generation gets the ability to state geometry — and then it is not. A builder sees one region and nothing else, so it cannot be told to keep a route that crosses four other regions; it does not have the information to be careful with. The legacy answer is `planStreets`: reserve a proven route network through the finished geometry before any builder runs, hold that ground back from every builder, and drop props that reach into it.

It works. It also costs about a third of the map in reserved ground, needs a repair pass, and exists entirely because **macro has no way to say what it needs**. Everything it does is a workaround for a missing sentence.

## The inversion

Macro says what it needs. That is the whole design.

```
plan:     partition the map into regions
          -> state a perimeter contract on every boundary
          -> prove reachability on the region graph, from the floors alone

compose:  lay the contract down as geometry
          -> run one builder per region
          -> hold each builder to the contract it was given
```

A **`PerimeterPort`** is a run of contiguous boundary segments a region shares with one neighbour, carrying two numbers rather than one:

- **`required`** is a floor. When micro is done, something of at least this size must be able to cross. This is what macro's proof is computed from.
- **`allowed`** is a ceiling. `"contestant"` keeps a port a squeeze no hunter may use however open a builder would rather leave it; `"none"` seals it.

`required: "none"`, `allowed: "hunter"` is a boundary micro may do whatever it likes with, which is the ordinary case away from the routes macro actually depends on.

Reachability is then a walk over a region graph of a few hundred nodes, using floors only. **It is a statement about a graph, and it is sound only because `micro/conform.ts` separately holds every builder to those floors.** Neither claim is a geometric proof on its own; together they are the guarantee. AGENTS.md is explicit about not confusing the two, and the distinction is the reason this works.

The consequences are the point:

- No reserved corridor network, so no ground held back from builders.
- No repair pass, because nothing needs repairing.
- Macro never learns what a region built inside itself.
- A builder never learns what the map looks like outside its own area.

## Loot

Macro decides **how much and of what tier**; the region decides **where**. Progression is a property of position on the map, so it belongs to macro; where a spawn sits depends on what the region just built, which only the region knows.

`LootCriteria` carries a `budget` (a count, and a hard cap), the `tier` in force, and a `density` for a builder that would rather scatter than count. `micro/loot.ts` does the placing under one rule: **a cell carries at most one loot spawn**. It prefers the spaced lattice, only falls back to denser cells when the budget cannot be met, never takes a cell another pass owns or the builder has claimed, and reports a shortfall rather than pretending the budget was met.

## What is measured rather than planned

Two things, on purpose.

**Tile anchors.** An anchor is a fact about composed geometry, so it is found after the builders finish, from ground that is actually clear. The legacy path plans anchors and then has to defend them from every builder, which is where its "anchor is inside geometry" failures come from. Planning a point only creates something to protect.

**The artifact's regions.** A second search of the finished grid, so they describe what was built rather than what was planned. A builder that stated a wall genuinely split its area in two, and `validateMap` requires a region's class to agree with its own cells.

## Module map

| module                  | owns                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `src/plan/types.ts`     | `RegionPlan`, `MapPlan`, the passage ordering                 |
| `src/plan/partition.ts` | cutting the map into typed, contiguous, tile-aligned regions  |
| `src/plan/ports.ts`     | boundaries, the passage bands on them, the reachability proof |
| `src/plan/loot.ts`      | how much loot a region owes                                   |
| `src/plan/compose.ts`   | plan to artifact: geometry, builders, anchors, validation     |
| `src/micro/conform.ts`  | holding a builder to its perimeter contract                   |
| `src/micro/loot.ts`     | where a region's loot actually goes                           |

`PerimeterPort` and `LootCriteria` live in `src/micro/types.ts`, not in `src/plan/`, because they are what micro is _told_ — that keeps the dependency pointing one way, plan to micro, with no cycle.

## What the two paths share

Everything below the contract. Both run the same six builders out of the same catalogue, through the same canvas and the same containment rules, using the same mask, rng, scale and placement helpers. `context.ports` and `context.loot` are optional: absent on the legacy path, where there is no plan to honour, and `conformRegionEdit` is then a clean no-op. That is what lets one set of builders serve both.

## Measured

20 seeds at default size (936 tiles, 33,696 cells), against the legacy generator's
own 150-seed sweep. min / median / max, and all 20 valid.

| metric           | legacy (150 seeds)    | planned (20 seeds) |
| ---------------- | --------------------- | ------------------ |
| valid            | 150 / 150             | 20 / 20            |
| `microSegments`  | 79 / 196 / 313        | 5373 / 6067 / 6320 |
| `microCells`     | 0 / 12 / 40           | 320 / 464 / 584    |
| `obstacleCount`  | 144 / 225 / 303       | 1265 / 1682 / 2222 |
| `squeezes`       | 0 / 1 / 3             | 59 / 79 / 99       |
| `detourRatio`    | 1.051 / 1.051 / 1.051 | 1.75 (median)      |
| `lootCount`      | 1044 / 1151 / 1263    | 737 / 836 / 907    |
| `portsCorrected` | --                    | 0 / 1 / 2          |
| reserved ground  | ~33% of the map       | none               |

The numbers that matter are the last three rows plus `microSegments`.

**Builders actually build.** Thirty times the stated geometry of the legacy path,
because nothing is held back from them. On the legacy path streets and anchor
standing room took a third of the map before any builder saw it, and what was
left was too fragmented for the builders that make buildings.

**The map is no longer a straight shot.** A detour ratio of 1.05 means the route
to an exit is the direct line; 1.75 means getting there is a journey. That was
the original complaint about the generated map and it is the clearest single
number here.

**The asymmetry is real and planned.** Seventy-nine contestant-only seams a map,
against one, and they exist because `planPorts` decided them rather than because
geometry happened to leave a gap of the right size.

**`portsCorrected` is the honest one.** It counts ports that finished outside
their band and had to be rewritten by `enforcePorts`. A median of one, out of
about 900, is the contract essentially holding on its own -- and it is not zero,
which is why the pass exists: a port is shared, each side's builder runs
separately, and the later write wins. Each side was conformant when it was
checked and the pair was not.

`lootCount` falling is a policy change, not a regression: macro now sets an
explicit budget per region instead of rolling a per-cell chance. Whether ~840 is
the right number is a content question nobody has answered.

### What is not yet trustworthy

`detourRatio`, `contestantDistance` and `deadEnds` come from the anchor-to-anchor
tile graph, which NEXT_TASKS item 2 already records as conservative and
tile-grained. On two of eight sampled seeds it reports no contestant route at all
while `validateMap`'s lattice flood -- which is the authority, and which checks
geometry -- passes. The metric is understating, not the map failing. Replacing it
with geometry-level analysis is that item's job.

Nothing here is tuned. `DEFAULT_TYPE_TABLE`, the port chances, the loot policy
and `tilesPerRegion` were all set to something reasonable and left alone.

## Status

The planned path is new and is not yet the default. `generateMap` remains the generator the GUI, CLI and MCP use. Nothing here is integrated with the game at the repository root, and is not meant to be yet.
