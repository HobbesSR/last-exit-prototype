# 50. Map generation

Status: accepted direction, 2026-09-29. Updated: 2026-10-03.

The 5x files are map generation. 50 is the overview and who owns what. 51 is
the generation chain, 52 the primitives and the library, 53 artifacts,
determinism and tools, and 54 the region type catalogue. Micro generation was documented before this area
existed, so its files keep their numbers: 19 (decomposition design) and 20
(bounded micro generation).

## Two projects, one problem

The game at the repository root and the map generator in `map/macro/` were built
separately and ended up solving the same middle of the problem: regions, their
boundaries, and whether everything can be reached.

- **The game built downward from regions.** F-01 micro generation (since
  2026-09-19) produced `map/micro/`: an SDK of reusable machinery,
  example builders, and the decomposition design in 19.
- **mapgen built upward from tiles.** It was the separate `last_exit_map`
  repository until 2026-09-26. Along the way it grew its own region builders,
  its own boundary contract, and a second generator (the "planned path").

Corey, 2026-09-29, on how to tell them apart:

> mapgen evolved towards owning bottom of macro up, and the original game engine owned building aggregate regions down. And that helps generally decide whose work is relevant versus deprecated, but it might take some searching to truly understand.

And on the documentation:

> mapgen's docs I think have been part of the bane. I think we need to integrate and normalize the documentation and I'm not sure we could have done it without going through the pains we went through to get to where we are now.

mapgen's former docs are archived in `map/macro/docs/archive/pre-integration/`.
They describe the code deleted at the chain's switch-over (51 step 10, #146),
and are history.

## Ownership

| Concern | Owner | Where |
| --- | --- | --- |
| The tile library, placement, resolution, layout regions, the reachability proof, region briefs, and whole-map measurement | mapgen: macro, bottom up | 51, 52 |
| Region type strategies: each type's decomposer and builders | the game: regions, top down | `map/micro/`, 19, 20 |
| Elective validation utilities for builders, composing built regions, and adapting them to the live game's geometry | the game | 20 |
| Machinery builders share: masks, shapes, swept routes, spacing, interface runs, access validation | the SDK, `map/micro/sdk.ts`. Macro calls it where a mechanism fits both scopes | 20, 22 |
| What macro and micro must share: the contract between them (a region brief and its result), body scale and passage widths, and the definition of a run | the **shared map space**, which neither level owns (Corey, 2026-09-29, M1). It is the kernel, `map/kernel/` (51 C0): `contract.ts`, `scale.ts`, `cell.ts` and `run.ts` | 51, 52 |
| The Map Lab, CLI and MCP, which show both halves | neither: the tools, `map/tools/`, using the shared map-level assembly (Corey, 2026-10-02, 17 "Where the tools live") | 53 |
| The live game's current map | `map/live.ts` consumes the authored chain; `shared/map/generate.ts` remains the legacy generator | 22 |

## The SDK is a library

Corey, 2026-09-29:

> I thought the idea of the generation SDK is more about providing a library of reusable functionality likely to be used across builders.

This matches 19: "The individual region type owns the strategy. The SDK
supplies the machinery." So:
- Each region type gets bespoke builder and decomposer code.
- Builders don't reimplement SDK machinery.
- Macro may call the SDK where a mechanism genuinely fits both scopes.

This replaces the archived mapgen statement that the SDK is "where interiors
are generated for real" and that mapgen's builders are a mock.

## One pipeline

```
seed, params, library
  │  mapgen (51)
  ▼
Layout ─► resolved layout ─► layout regions ─► proof ─► region briefs
                                                         │  the contract (types.ts)
                                                         ▼
                            the game (19, 20): one region type strategy per brief
                            (decomposer + builders, on the SDK) ─► built regions
                                                         │
                                                         ▼
                            composition ─► built map ─► measurement (51 stage 8)
```

## Duplication ledger

Each concern below exists on both sides today, but not every overlap is a
duplicate. Corey, 2026-09-29:

> keep in mind I think we have duplicate things in some cases because they are tailored for the level they are engineered for. Macro and Micro have to solve similar problems but within the boundaries of their scope.

So the test is:
- **Same level:** the same problem solved twice at the same level is a
  duplicate. It gets one owner, and the other copy retires. mapgen's micro
  layer was micro work done inside the macro project, so its pieces fall
  here.
- **Tailored per level:** a similar problem at different levels is solved at
  each level, fitted to its scope. Macro works across the whole map, on
  layout regions and guarantees, before anything is built. Micro works inside
  one region, on its children and its geometry.
- **Where the levels must agree,** they share one definition and a test pins
  the agreement. Examples are body scale, and the runs a brief hands from
  macro to micro.

| Concern | Game (`map/micro/`) | mapgen | Kind | Disposition |
| --- | --- | --- | --- | --- |
| Region builders | `builders.ts`: open, depot, courtyard, ruins, entry (examples) | `src/micro/builders/`: open-field, scatter, pillar-hall, compound, rubble, courtyard | same level | New builders per region type, written on the SDK in `map/micro/` (51 track B). mapgen's were deleted at the switch-over (#146); either side's may be mined for ideas, from git history for mapgen's. |
| Builder toolbox | the SDK: mask, geometry, placement, `spreadPoints` | `src/micro/`: mask, edit, placement, rng, scale, clearance | same level | The SDK. mapgen's was deleted (#146). |
| Boundary contract | `RegionPort` with a floor and a ceiling; `access.ts`, `boundary.ts` | the planned path's `PerimeterPort` and `micro/conform.ts`; the V2 passable labels (PR #78, closed) | the hand-off between levels | One contract, in the shared map space, with passability obligations only (M4). What a portal asks of geometry is 17 M3. mapgen's were deleted (#146). |
| Boundary runs and portals | `buildInterfaces`: straight runs between a region's children, with portal candidates | `plan/ports.ts` `findBoundaries`; #73's `passableRuns`: straight runs between layout regions across the whole map | runs shared, portals tailored per level | One finder, the kernel's: both levels call `boundaryRuns` in `map/kernel/run.ts`, because a macro boundary becomes a region's external run in its brief. Macro calls it directly over layout regions (51 stage 3; it fits the whole map's scale, measured in step 5) and lays guarantees over its runs; `buildInterfaces` builds portal candidates on it. Its cases (`RUN_CASES`) pin any other finder. `findBoundaries` and `passableRuns` were deleted with the old paths (#146). |
| Connectivity over regions | the component grouping in `negotiatePortals`: are a region's children joined by its portal policy | `plan/ports.ts` `proveReachability`: are layout regions joined by guarantees | tailored per level | Each level keeps its own. The macro proof is 51 stage 4, and `proveReachability` is material for it. |
| Decomposition | the SDK's decomposition (19) | the "decomposition belongs to the region type" direction (#76), and streets and blocks | same level: streets and blocks were macro cutting regions | The SDK. Streets and blocks were deleted (#146). |
| Checking built geometry | the SDK's access and boundary validators: `shape.ts` swept discs, in world units | `nav.ts`: a half-cell lattice, in cells | tailored per level | Reachability is a chain of inference (Corey, 2026-09-29, M6): macro's proof over guarantees, plus each builder keeping its promise, all the way down (51 principles 8 and 9). Nothing enforces the promises: the SDK validators are elective utilities, and a builder that breaks its promise is defective. mapgen's lattice was deleted with the old paths (#146); the Map Lab's diagnostic is the game's `diagnoseBuiltMap` (53). |
| Loot | loot budget and candidates | `micro/loot.ts`, `plan/loot.ts` | split by level: macro says how much, the region says where | The SDK. Macro loot planning isn't wanted now: Corey, 2026-09-28, "I don't care about loot prescriptions, that can be added in later". |
| Macro partition | none, apart from the interim maze | V2 (tiles and WFC), and the planned path's partition | macro only | The chain (51), from tiles. The planned path was deleted (#146). |
| Body scale | the `cell` profile: diameters 1.25 and 1.75, door 2, squeeze 1.5; `live`: 12 and 23 world units | radii 0.55 and 0.90 cells, until C0 | must agree | One source of truth (M5): stated once in 52, "Units and scale", and held once in code in `map/kernel/scale.ts`. mapgen and the SDK both read from it (51 C0). |
| Development tools | micro lab, decomposition lab, generation demo | the Map Lab, CLI, MCP | tailored per level | Keep both, under the shared navigation bar (20). The whole-map tools moved to `map/tools/` at the switch-over (51 step 10). |
| Questions and backlog | 17, 41 | `QUESTIONS.md`, `NEXT_TASKS.md` | same level | 17 and 41 (folded 2026-09-29). Work in progress lives on Forgejo (34). |
| Artifacts | `micro-1`, `region-2` (a brief's result, 51 stage 6), `decomposition-1`, `realized-decomposition-1` | wire version 7, JSON and BSON (53); version 4, the old generators', is refused by name | tailored per level | The macro layout keeps mapgen's wire form, as wire version 7. Region results are stored as the game's own `region-2` data, less their briefs (51 step 9, 53). |

## Where the code is today

- **The game:** the interim street maze is live. The micro SDK, the example
  builders, the decomposition machinery and three development labs exist but
  aren't called by the live map (20).
- **mapgen:** the generation chain's macro stages (51), in
  `map/macro/src/chain/`. Its two old generators, `generateMap` and
  `generatePlannedMap`, were deleted at the switch-over (#146).
- **Layout:** map generation is the top-level `map/` (#105):
  - `map/macro/` is mapgen.
  - `map/micro/` is the micro SDK, its builders and its labs' modules.
  - `map/kernel/` is the shared map space.
  - `map/tools/` holds the tools that show both halves: the Map Lab, CLI and
    MCP (#144, #145).
- **Imports:**
  - Macro and micro don't import each other, except that macro may call the
    SDK. Both import the kernel (M1). They meet in `map/chain.ts` and `map/engines.ts`; the tools reuse that assembly.
    A test keeps each half from importing the other outside the SDK exception.
  - The kernel imports nothing outside itself, and a test holds it to that.
  - `map/` builds on the game's portable core in `shared/` (geometry, element
    vocabulary, and micro's live-game adapters). `shared/` never imports
    `map/`, and a test holds that too.
  - mapgen doesn't import the SDK's builders or strategies; `map/engines.ts` lends
    them to it as `MapEngines`. The server invokes `map/live.ts` before creating a match.
- **Serving:** the Map Lab's server (`map/tools/server.mts`) serves macro,
  micro, the kernel and `shared/` at their repository paths, and the game's
  server serves `/map/micro/` and `/map/kernel/` for the micro labs (53).
- *Assumption:* the name `kernel` (17 M1's open part).

## Reading guide

| Task | Read |
| --- | --- |
| Anything in map generation | 50, then the design notes (`map/macro/design_notes.txt`), the original statement of intent. Corey's later answers in 17 and the accepted model in 51 govern where they differ |
| A chain stage or its interfaces | [51](51-generation-chain.md) routes to the stage; read [51.1](51.1-principles-and-names.md) for shared invariants and only the needed stage in 51.2–51.10 |
| Tiles, set pieces, cell classes, prescriptions | 52 |
| The map's macro shape: the diamond, zones, zone sizes, where placement rules anchor | 55 |
| Artifacts, saving, determinism, the sweep, the Map Lab, CLI and MCP | 53 |
| A region type, a builder, a decomposer, the SDK | 54 (the catalogue, a working draft), 19 (design), then the relevant part of [20](20-micro-generation.md); [22.2](22.2-map-generation.md) for map ownership |
| Macro/micro briefs and passability | [51.7](51.7-briefs.md), [20.1](20.1-region-contract.md), and [17.2.4](17.2.4-contract-questions.md) for M1–M5 |
| Open questions, and your verbatim answers | [17.2](17.2-map-questions.md) routes by topic and M-number; [17.2.7](17.2.7-zone-plans.md) holds the zone-plan answers |
| Chain implementation history | [51.14](51.14-build-order.md), then the relevant track; not required for a stage-only task |
| What's next | 41, and the Forgejo tracker it names |
