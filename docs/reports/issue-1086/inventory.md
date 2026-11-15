# #1086 first-use inventory

This is the one-off source inventory and baseline stage screen for #1086. Inputs are the `inventory-12x6` and `inventory-36x18` reports retained in `summary.json.gz`: seed 4217, Node v24.15.0, one direct fake-peer viewer, recording enabled with output discarded, maps already built. These are baseline artifacts, not measurements of the warming implementation.

The early maximum is max(tick 1, ticks 2 through 200); the comparison maximum covers ticks 201 through 400. These are the first 200 simulated ticks and later 200 simulated ticks. The harness advances 50 simulated milliseconds per call and yields with sleep(0), rather than pacing each window for ten actual seconds (`tools/perf/room-startup.mjs:193`). Missing stages count as zero. Every ms stage exceeding its comparison maximum in either size appears below; the table retains both sizes even where the second size does not exceed. Selection uses unrounded values; displayed values are milliseconds rounded to four decimals.

## Stages whose early maximum is larger

| Stage | 12x6 early max | 12x6 later max | 36x18 early max | 36x18 later max | Owner and interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| loop.tick | 59.0781 | 8.1561 | 159.8291 | 12.4248 | server/room-service.js:370; aggregate |
| sim.step | 56.5519 | 7.4013 | 150.1534 | 9.4336 | shared/simulation/tick.ts:34; aggregate |
| sim.solve | 42.6107 | 0.9495 | 97.7885 | 1.7454 | shared/simulation/tick.ts:87; physics (#1087) |
| sim.pickups | 5.4429 | 0.1846 | 23.1421 | 0.2153 | shared/simulation/tick.ts:112; cache + gameplay |
| sim.bots | 27.3129 | 5.8103 | 40.9260 | 6.6949 | shared/simulation/tick.ts:61; aggregate |
| sim.itemSync | 2.4645 | 0.1210 | 4.2753 | 0.2145 | shared/simulation/game.ts:178; body ownership |
| sim.bots.plan | 27.0824 | 5.5775 | 40.5081 | 6.3652 | shared/simulation/bots.ts:297; geometry + stateful search |
| sim.sync | 1.4077 | 0.2294 | 3.5315 | 0.3835 | shared/simulation/tick.ts:48; body/lifecycle state |
| loop.broadcast | 1.1448 | 0.4861 | 4.7063 | 4.2860 | server/room-service.js:416; view/serialization aggregate |
| sim.poses | 0.7405 | 0.0689 | 1.0884 | 0.1320 | shared/simulation/tick.ts:91; physical poses |
| loop.encode | 0.6487 | 0.2752 | 2.8762 | 2.9426 | server/room-views.js:45; view encoders |
| loop.record | 4.1275 | 0.4421 | 4.5843 | 0.6018 | server/room-service.js:410; recorder (#1088) |
| sim.bots.items | 0.6284 | 0.0722 | 0.8401 | 0.2247 | shared/simulation/bots.ts:238; memory/selection |
| sim.snapshot | 0.5813 | 0.4425 | 2.4113 | 0.9094 | shared/simulation/visibility.ts:109; capture aggregate |
| sim.bots.dynamic | 1.2923 | 0.3131 | 1.3076 | 0.7350 | shared/simulation/bots.ts:329; dynamic observations/detours |
| sim.snapshot.presentation | 0.3804 | 0.1707 | 1.7691 | 0.2638 | shared/simulation/visibility.ts:116; capture + item lookups |
| sim.actions | 0.3505 | 0.1683 | 0.5783 | 0.1298 | shared/simulation/tick.ts:67; gameplay |
| sim.playerView | 0.3405 | 0.2437 | 2.2370 | 1.6352 | shared/simulation/visibility.ts:76; projection |
| sim.projectiles | 0.3385 | 0.0117 | 0.4526 | 0.0159 | shared/simulation/tick.ts:101; gameplay + sweep indexes |
| sim.bots.steer | 0.3207 | 0.0264 | 0.3290 | 0.1200 | shared/simulation/bots.ts:310; route progress |
| sim.environment | 0.2787 | 0.0047 | 0.2855 | 0.0172 | shared/simulation/tick.ts:124; environment/traps |
| sim.bots.sight | 0.2413 | 0.1111 | 0.2691 | 0.1508 | shared/simulation/bots.ts:212; visibility queries |
| sim.snapshot.clone | 0.3342 | 0.2329 | 0.9035 | 0.6572 | shared/simulation/visibility.ts:130; structured clone |
| sim.bots.observe | 0.2787 | 0.1463 | 0.2138 | 0.1911 | shared/simulation/dynamic-navigation.ts:81; current observations |
| loop.serialize | 0.4105 | 0.0565 | 0.2476 | 0.1259 | server/room-views.js:69; JSON serialization |
| sim.bots.collect | 0.1096 | 0.0269 | 0.1141 | 0.0340 | shared/simulation/tick.ts:62; collection snapshot |
| sim.snapshot.world | 0.0781 | 0.0486 | 0.1297 | 0.0949 | shared/simulation/visibility.ts:113; physical capture |
| sim.rewind | 0.0544 | 0.0050 | 0.0658 | 0.0304 | shared/simulation/tick.ts:138; stateful history |
| sim.discovery | 4.9529 | 2.2617 | 4.8949 | 4.7336 | shared/simulation/tick-rules.ts:24; knowledge sampling |
| sim.tickPacing | 59.6984 | 19.9461 | 161.7373 | 25.1090 | server/room-service.js:403; event interval, not CPU stage |
| sim.bots.explore | 0.3279 | 0.0000 | 0.3345 | 0.0878 | shared/simulation/bots.ts:259; exploration state |
| sim.repath | 26.8732 | 5.2828 | 4.9262 | 3.2355 | shared/simulation/bot-routes.ts:248; stateful sliced search/repair |

There are 32 selected stages. Parent and child timings overlap, so rows must not be added. `sim.tickPacing` is an observed interval between advances, not execution duration; the harness's unpaced calls make it unsuitable for judging production tick pacing. `loop.encode` exceeds only at 12x6.

This screen establishes an early/later difference, not its cause. No function-level runtime/JIT breakdown was recorded. A stage can include initialization, changing gameplay workload, allocation/GC, compilation, serialization and scheduling effects. In particular, the entire `sim.pickups` or `sim.bots.plan` duration cannot be attributed to cache construction. Stateful planning and runtime effects remain possible contributors; these baseline stage timings do not distinguish them.

Line references below reflect the inventory checkpoint `8fe69fd`; the navigation
preparation helper was subsequently removed in `bfa638a` and deferred to #1105.

## Pure derived cache candidates and reachability

All candidates below are RNG-free and allocate no gameplay serial or spawn IDs. They prepare derived data; they do not perform pickups, decide targets, advance searches, step physics or sample new discovery. Exact object identity matters: preparing clones does not warm the live owner's WeakMap.

| Cache / exact owner | Builds and exact key | Available before start? RNG / spawn / state constraints |
| --- | --- | --- |
| Ground spatial grid, `shared/simulation/ground-items.ts:105`; preparation `:124` | Two cell grids (64/256), record entries and list-order numbers; exact `game.map.items` array | Yes, after normal item publication freezes records. Mutable records remain loose and later migrate. Helper list copies carry/update the cache. No pickup or ID allocation. First pickup query is `shared/simulation/loot.ts:115`. |
| Ground ID lookups, `ground-items.ts:250`, `:272` | ID-to-position and ID-to-record maps; exact items array | Yes. May already be built by initial body ownership or first snapshot. Preserve list replacement/invalidation rules; no admission performed by building lookup. |
| Bot gate indexes, `shared/simulation/bot-routes.ts:112`; preparation `:131` | ID and building lookups; exact live gates array plus length | Yes. Records are retained live; open/locked state remains read at query time. No door observation or planner action. |
| Free-space buckets and tiles, `shared/free-space.ts:329`, `:379` | Exact match map, obstacle-array identity/length; tiles keyed by box coordinates/dimensions and clearance (14 contestant, 25 gladiator) | Yes. Geometry includes ground, obstacles, gate footprints/IDs; open/locked state is an edge condition, not tile geometry. Building tiles does not reveal them to contestant knowledge. Full-map contestant preparation adds clipping/memory for cells that gameplay might never reach. |
| Packed gate JSON, `free-space.ts:448` | Parses packed gate sets once per exact attached `PackedTiles` object; tile unpacking creates buffer views | Yes, when worker data is attached. Worker-packed gladiator geometry still has this first-use decode and wrapper work. Local maps may have no packed tiles. |
| Tile side index, `shared/navigation/knowledge.ts:366`; preparation `:123` | Four boundary-edge lists per exact `FreeTile` object | Yes, once the tile exists. Ordinary tile access alone leaves this index lazy. Pure geometry; does not run a route search. |
| Knowledge planner, `bot-routes.ts:98` | Lightweight closures cached by exact map and role | Yes. Creating a separate planner does not populate this private planner cache, though tile geometry is shared through the map cache. Its searches and per-tick budgets must remain untouched. |
| Portal planner, `bot-routes.ts:354`, `:364` | Exact attached portal graph; production uses straight reach | Yes if attached. Constructor is small and does not build region distance tables in the production straight mode. Target-dependent route searches are excluded. |
| Movement geometry/gates/rows, `shared/movement.ts:45`, `:115`, `:46` | Obstacles-array identity/length; gates-array identity/length with per-gate edge slots; exact playable-area object | Yes. Obstacle geometry already has cooperative preparation (`:90`); placement/discovery may already warm other indexes. Gate queries read current open state. |
| Swept geometry/gates, `shared/simulation/swept.ts:23`, `:28`; preparation `:79`, `:116` | Exact match map for static shot/solid indexes; exact live gates array plus length for closed shapes | Yes. Static indexes were already prepared. Gate shapes retain source ordering and open state remains live. No projectile spawn or physical step. |
| Published frame/JSON caches, `shared/simulation/frame-gates.ts:32`, `:53`; `ground-items.ts:317`, `:333` | Live gate record/list identity to frozen copies; published items list and immutable record identity to JSON | Reachable, but item publication freezes records, so it belongs at the existing server publication boundary. First ready/payload/snapshot may already pay it. Serialization of changing envelopes remains runtime work. |

`shared/simulation/state.ts:20` retains the supplied map as `s.map`; `shared/simulation/game.ts:23` prepares that same object. Server `createMatch` is the cooperative caller (`server/match.js:86`). Shared/browser callers without the yield callback retain their lazy path and mutable setup contract. Server-only ground preparation follows ordinary publication rather than running automatic pickups.

## Stateful work and exclusions

- Bot intent collection, target choice, pursuit/hunting/lead memory and exploration are runtime behavior (`shared/simulation/bots.ts:188`). `repathTiles`, searches, route repair, corridors and the shared tick allowance change planner state (`shared/simulation/bot-routes.ts:210`, `:248`, `:354`). Their work cannot be moved before start by pretending a plan has occurred.
- Dynamic observations/local maps depend on current player/prop transforms, discovery and observed doors (`shared/simulation/dynamic-navigation.ts:25`, `:55`). Their keys can change after queued lobby commands. `rememberedItems`/`seenCells` replace player-memory representations (`shared/simulation/bot-memory.ts:173`, `:184`), rather than initialize immutable map geometry.
- Body synchronization/admission (`shared/simulation/world-physics.ts:60`), physical poses, actions, interactions, pickups/charging, environment/traps, discovery, finish and rewind are gameplay/capture work coordinated by `shared/simulation/tick.ts:39`. Rewind explicitly appends history (`shared/simulation/rewind.ts:37`). No synthetic first tick or speculative spawn is part of cache warming.
- Snapshot cloning, physics/presentation capture, player projection, view encoding and final JSON assembly have current-frame or viewer inputs (`shared/simulation/visibility.ts:76`, `:109`; `server/room-views.js:45`, `:69`). Immutable subrecord caches are separable candidates; whole-stage serialization or runtime/JIT warming is not established by these measurements.
- Recording startup/new-room recorder work is tracked by #1088. Rapier first-step work is #1087. Room isolation is #1089. Their stage rows remain visible for an honest inventory, but this cache change does not claim to solve those issues. Recording was enabled in the baseline, so aggregate loop times include recorder work.

No timing run or test suite was executed while writing this inventory; the tables were calculated from the two existing JSON artifacts. This report does not establish multi-room capacity or a function-level causal breakdown.
