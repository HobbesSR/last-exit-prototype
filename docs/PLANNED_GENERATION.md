# Planned generation

A second generator, built beside the legacy one rather than replacing it. `core.generateMap` is untouched and still works; `plan/compose.generatePlannedMap` is the new path. Naming is fixed by [Vocabulary and layering](VOCABULARY.md).

## Why a second path

The legacy generator composes authored tiles, discovers regions from the cell classes that fall out, and only then finds out what it built. Nothing knows whether the map is walkable until the whole thing exists.

That is survivable until micro generation gets the ability to state geometry — and then it is not. A builder sees one region and nothing else, so it cannot be told to keep a route that crosses four other regions; it does not have the information to be careful with. The legacy answer is `planStreets`: reserve a proven route network through the finished geometry before any builder runs, hold that ground back from every builder, drop props that reach into it, and repair the anchors that break anyway.

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

## Status

The planned path is new and is not yet the default. `generateMap` remains the generator the GUI, CLI and MCP use. Nothing here is integrated with the sibling game, and is not meant to be yet.
