# 50. Map generation

Status: accepted direction, 2026-09-29. Updated: 2026-10-03.

The 5x files are map generation. 50 is the overview and who owns what. 51 is
the generation chain, 52 the primitives and the library, 53 artifacts,
determinism and tools, 54 the region type catalogue, 55 zone plans, and 56
buildings. Micro generation was documented before this area
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
| The live game's current map | `map/live.ts` consumes the authored generation chain; `shared/map/generate.ts` remains the legacy generator | 22 |

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

<a id="one-pipeline"></a>

## One generation chain

The **generation chain** is the full map-generation pipeline defined in
[51.1](51.1-principles-and-names.md), spanning both macro and micro. The
**chain of inference** is its layered reachability argument, also defined in
51.1. The diagram below shows the pipeline stages; the proof stage contributes
macro's link to that argument.

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

The migration distinguished shared machinery from work tailored to each level.
Corey, 2026-09-29:

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

The completed migration ledger is retained in
[51.14.5](51.14.5-switch-over.md#historical-duplication-ledger). Use the
[ownership table](#ownership) and the reading guide below for current boundaries.

## Where the code is today

- **The game:** live rooms run the generation chain: macro placement, then each
  region type's strategy from `map/micro/` (`map/live.ts`;
  [22.2](22.2-map-generation.md#live-map-assembly), [51.14.5](51.14.5-switch-over.md)).
  The interim street maze in `shared/map/` is no longer live; it remains
  `createGame`'s default for explicit legacy callers and the frozen fixture (31).
  Recursive execution of explored decomposition trees, and moving decomposition's
  walled ports to portals, are still pending
  ([20.5](20.5-tools-and-next-boundaries.md#next-boundaries)).
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
- **Serving:** the game server (`server/index.js`) hosts all of the Map Labs and developer tools directly under the `/dev/` route hierarchy, serving map generator code via ES modules (53).
- *Assumption:* the name `kernel` (17 M1's open part).

## Reading guide

| Task | Read |
| --- | --- |
| Anything in map generation | 50, then the design notes (`map/macro/design_notes.txt`), the original statement of intent. Corey's later answers in 17 and the accepted model in 51 govern where they differ |
| A chain stage or its interfaces | [51](51-generation-chain.md) routes to the stage; read [51.1](51.1-principles-and-names.md) for shared invariants and only the needed stage in 51.2–51.10 |
| Tiles, set pieces, cell classes, prescriptions | 52 |
| The map's macro shape: the diamond, zones, zone sizes, where placement rules anchor | 55 |
| Artifacts, saving, determinism, the sweep, the Map Lab, CLI and MCP | 53 |
| A building: its design, spaces, walls and openings | [56](56-buildings.md), then 54 for the type that builds it |
| A region type, a builder, a decomposer, the SDK | 54 (the catalogue, a working draft), 19 (design), then the relevant part of [20](20-micro-generation.md); [22.2](22.2-map-generation.md) for map ownership |
| Macro/micro briefs and passability | [51.7](51.7-briefs.md), [20.1](20.1-region-contract.md), and [17.2.4](17.2.4-contract-questions.md) for M1–M5 |
| Open questions, and your verbatim answers | [17.2](17.2-map-questions.md) routes by topic and M-number; [17.2.7](17.2.7-zone-plans.md) holds the zone-plan answers |
| Generation measurements and chain captures | [42.3](42.3-generation-and-delegation-evidence.md) and [42.4](42.4-chain-checkpoint-history.md); current compatibility and tools remain in [53](53-map-artifacts-and-tools.md) |
| Chain implementation history | [51.14](51.14-build-order.md), then the relevant track; not required for a stage-only task |
| What's next | 41, and the Forgejo tracker it names |
