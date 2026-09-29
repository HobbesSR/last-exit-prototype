# 50. Map generation

Status: accepted direction, 2026-09-29. Updated: 2026-09-29.

The 5x files are map generation. 50 is the overview and who owns what. 51 is
the generation chain, 52 the primitives and the library, and 53 artifacts,
determinism and tools. Micro generation was documented before this area
existed, so its files keep their numbers: 19 (decomposition design) and 20
(bounded micro generation).

## Two projects, one problem

The game at the repository root and the map generator in `mapgen/` were built
separately and ended up solving the same middle of the problem: regions, their
boundaries, and whether everything can be reached.

- **The game built downward from regions.** F-01 micro generation (since
  2026-09-19) produced `shared/map/micro/`: an SDK of reusable machinery,
  example builders, and the decomposition design in 19.
- **mapgen built upward from tiles.** It was the separate `last_exit_map`
  repository until 2026-09-26. Along the way it grew its own region builders,
  its own boundary contract, and a second generator (the "planned path").

Corey, 2026-09-29, on how to tell them apart:

> mapgen evolved towards owning bottom of macro up, and the original game engine owned building aggregate regions down. And that helps generally decide whose work is relevant versus deprecated, but it might take some searching to truly understand.

And on the documentation:

> mapgen's docs I think have been part of the bane. I think we need to integrate and normalize the documentation and I'm not sure we could have done it without going through the pains we went through to get to where we are now.

mapgen's former docs are archived in `mapgen/docs/archive/pre-integration/`.
They still describe the code that retires at the chain's switch-over (51).

## Ownership

| Concern | Owner | Where |
| --- | --- | --- |
| The tile library, placement, resolution, layout regions, the reachability proof, region briefs, and whole-map measurement | mapgen: macro, bottom up | 51, 52 |
| Region type strategies: each type's decomposer and builders | the game: regions, top down | `shared/map/micro/`, 19, 20 |
| Validating a built region, composing built regions, and adapting them to the live game's geometry | the game | 20 |
| Machinery builders share: masks, shapes, swept routes, spacing, interface runs, access validation | the SDK, `shared/map/micro/sdk.ts`. Macro calls it where a mechanism fits both scopes | 20, 22 |
| The contract between macro and micro | `shared/map/micro/types.ts`, which 22 already names the macro/micro contract. A region brief (51) is expressed in it | 51 |
| The live game's current map | the interim street maze, `shared/map/generate.ts`, unchanged until the integration checkpoint | 22 |

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

| Concern | Game (`shared/map/micro/`) | mapgen | Kind | Disposition |
| --- | --- | --- | --- | --- |
| Region builders | `builders.ts`: open, depot, courtyard, ruins, entry (examples) | `src/micro/builders/`: open-field, scatter, pillar-hall, compound, rubble, courtyard | same level | New builders per region type, written on the SDK in `shared/map/micro/` (51 track B). mapgen's retire at the switch-over, and either side's may be mined for ideas. |
| Builder toolbox | the SDK: mask, geometry, placement, `spreadPoints` | `src/micro/`: mask, edit, placement, rng, scale, clearance | same level | The SDK. mapgen's retires. |
| Boundary contract | `RegionPort` with a floor and a ceiling; `access.ts`, `boundary.ts` | the planned path's `PerimeterPort` and `micro/conform.ts`; the V2 passable labels (PR #78, closed) | the hand-off between levels | One contract in `types.ts`, evolved as 51 says. The port semantics are open (17, "Map generation" item M3). mapgen's retire. |
| Boundary runs | `buildInterfaces`: straight runs between a region's children, with portal candidates | `plan/ports.ts` `findBoundaries`; #73's `passableRuns`: straight runs between layout regions across the whole map | tailored per level | Each level keeps its own. Macro's boundary runs are 51 stage 3, and step 5 reuses `buildInterfaces` only if it fits the whole map's scale. The two share one definition of a run, because a macro boundary becomes a region's external run in its brief. |
| Connectivity over regions | the component grouping in `negotiatePortals`: are a region's children joined by its portal policy | `plan/ports.ts` `proveReachability`: are layout regions joined by guarantees | tailored per level | Each level keeps its own. The macro proof is 51 stage 4, and `proveReachability` is material for it. |
| Decomposition | the SDK's decomposition (19) | the "decomposition belongs to the region type" direction (#76), and streets and blocks | same level: streets and blocks were macro cutting regions | The SDK. Streets and blocks retire. |
| Checking built geometry | the SDK's access and boundary validators: `shape.ts` swept discs, in world units | `nav.ts`: a half-cell lattice, in cells | tailored per level | Region level: the SDK. Whole map (spawn to exit is a macro duty, 20): measured on the game's geometry at integration. mapgen's lattice serves the Map Lab and the old paths meanwhile (17 M6). |
| Loot | loot budget and candidates | `micro/loot.ts`, `plan/loot.ts` | split by level: macro says how much, the region says where | The SDK. Macro loot planning isn't wanted now: Corey, 2026-09-28, "I don't care about loot prescriptions, that can be added in later". |
| Macro partition | none, apart from the interim maze | V2 (tiles and WFC), and the planned path's partition | macro only | The chain (51), from tiles. The planned path retires. |
| Body scale | the `cell` profile: diameters 1.25 and 1.75, door 2, squeeze 1.5; `live`: 12 and 23 world units | radii 0.55 and 0.90 cells | must agree | One band, from Corey's September 22 answer in 17. Which point in it is 17 M5. |
| Development tools | micro lab, decomposition lab, generation demo | the Map Lab, CLI, MCP | tailored per level | Keep both, under the shared navigation bar (20). |
| Questions and backlog | 17, 41 | `QUESTIONS.md`, `NEXT_TASKS.md` | same level | 17 and 41 (folded 2026-09-29). Work in progress lives on Forgejo (34). |
| Artifacts | `micro-1`, `decomposition-1`, `realized-decomposition-1` | wire version 4, JSON and BSON (53) | tailored per level | The macro layout keeps mapgen's wire form. How built regions are stored is decided at 51 step 9. |

## Where the code is today

- **The game:** the interim street maze is live. The micro SDK, the example
  builders, the decomposition machinery and three development labs exist but
  aren't called by the live map (20).
- **mapgen:** two generators, `generateMap` (tiles, WFC and streets) and
  `generatePlannedMap`, which both retire when the chain lands (51).
- **Imports:** neither side imports the other. The chain needs one direction,
  and the assumption is that mapgen imports the contract and SDK from
  `shared/map/micro/` (17 M1).

## Reading guide

| Task | Read |
| --- | --- |
| Anything in map generation | 50, then the design notes (`mapgen/design_notes.txt`), which are authoritative for intent |
| A chain stage or its interfaces | 51 |
| Tiles, set pieces, cell classes, prescriptions, zones | 52 |
| Artifacts, saving, determinism, the sweep, the Map Lab, CLI and MCP | 53 |
| A region type, a builder, a decomposer, the SDK | 19, 20, 22 |
| Open questions, and your verbatim answers | 17, "Map generation" |
| What's next | 41, and the Forgejo tracker it names |
