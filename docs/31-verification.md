# 31. Verification

## Gates

Every gameplay or protocol change should pass the gates relevant to what it
touched. An integration checkpoint runs all of them.

```powershell
npm run check
npm run typecheck
npm run test:all
npm run test:browser
npm run bench
npm run bench:client
```

`npm test` and `npm run test:all` cap file concurrency at four, keeping CPU and memory contention
bounded on the shared machine. Every case still runs, including the slow tier;
timing assertions and isolated file budgets are unchanged. Unbounded file
concurrency made the compound's three-second macro fixture fail under competing
whole-match/seed-sweep work despite passing sequential isolated measurements.
Use the normal scripts for integration; focused `node --test` commands remain
available. The chain sweep's internal worker pool is separate.

The unit suite has two tiers. `npm test` is the fast tier for iterating on a PR:
everything under `tests/*.test.js`, about two minutes wall time (measured 2026-10-07: 5.5 minutes
summed, run in parallel across files). `npm run test:all` adds
`tests/slow/`: the 200-map route sweep, the bot-match traces against the frozen
fixture, and bots completing whole matches. Those slow tests sum to about four minutes
by default, and their evidence only moves when generation or simulation moves.
`tests/slow/room-sizes.test.js` runs only the 12 × 6 room unless asked
(`ROOM_SIZES=all`, or a list such as `ROOM_SIZES=24x12,36x18`; invalid or empty values fail with
the supported values). Run `test:all` before opening a PR that touches
`shared/`, `server/` or map generation the game consumes, and at integration
checkpoints. A test belongs in `tests/slow/` when it costs seconds and sweeps
seeds or plays whole matches. The fast tier keeps a cheap witness of the same
contract where one exists: the fixture's map hashes and scripted trace stay in
`characterization.test.js`.

Changes under `map/macro/` run its own suite with `npm run test:mapgen` (typecheck
plus unit tests, in that directory). Its `tests/slow/` holds the larger authored-size
quota checks and runs in that same default macro suite; the seeds and assertions
are shared with the fast content checks, not reduced to fit the timing budget. On 2026-10-03, after the old paths were
deleted (#146), it is green: 100 tests. The Map Lab (`map/tools/lab/`) has its
own browser check, `node map/tools/tests/lab.browser.mts`, which `npm run
test:browser` runs. A change to the chain or its inputs (macro's stages and
library, the game's strategies, the kernel, `shared/`) also runs the chain's
seed sweep from the repository root, `node map/tools/cli.mts sweep --check
map/tools/fixtures/chain-baseline.json` (224 maps, about 25 s); `npm test`
pins its quick cases. It must show no drift unless the PR declares a content
change and recaptures last ([53](53-map-artifacts-and-tools.md)). Do not
resize test grids or relax generation to make a check pass.

The chain's authored library (52) is checked against the actual region strategies.
Macro's `tests/chain-content.test.ts` checks the game quotas in 52, distinct
enormous pieces, and core element regions staying inside their owning instances.
Root `tests/map-library.test.js` checks 8 and 24 contestants, actual huts, cover
and rubble, that each core element is reachable from its region's first portal
(the strategies' own siting rule in 54, not a contract), and the portal promise within
each non-open region. `node --test tests/slow/map-library.test.js` checks the
report on 20 seeds with 8 contestants and 5 with 24; one full diagnostic also
checks the large open regions. These are bounded samples, not a guarantee for
every seed. `tests/map-container.test.js` saves and reloads this library's
game-size map through JSON, BSON and Layout-only regeneration with the real
strategy version (53).

The larger authored-size report samples live in separate slow files
(`map-library-24`, `map-library-36`, and `map-library-36-tail`) to stay under
the 60-second file budget. They retain the original five seeds for each size;
the 36-size sample is split into seeds 1–3 and 4–5 with the same bounds checked
in both batches.

The tools in `map/tools/` are checked by `tests/map-tools.test.js`, which drives
the CLI and MCP as subprocesses, and typechecked by `npm run typecheck` under
their own `map/tools/tsconfig.json`, which checks what they reach in macro as
macro's own config does.

The compound's multi-mask room/court route sweep lives in
`tests/slow/micro-compound-access.test.js`; the fast delegation file keeps the
concave seed-1 and gate/crossing regression witnesses. The fast compound file
shares identical generated inputs across its ring, portal and observer checks
without dropping its original seed/parameter coverage.

Micro-generation changes additionally run `npm run test:micro`: focused contracts
and seeded builder tests plus all three isolated browser previews. The unit tests also run
in `npm test`. The lab browser check verifies actual builder content, control
variation, artifact download and movement, and saves `test-results/micro-lab.png`.
It also toggles each building view for `hut`, `compound` and `block`, checks the drawn
counts against the build in memory, and shows unmet guidance as a warning
([56](56-buildings.md) L4, L5).
CLI batch generation/validation and limits are described in [20.5](20.5-tools-and-next-boundaries.md).
Decomposition checks cover immutable contexts and trial claims, graph/topology
analysis, generator contracts, residual tradeoffs, exact ownership and interface
accounting, corrupted artifacts, and CLI round trips. Negotiation checks cover
contestant-only and unstated-seam policies, rejected disconnected policies and
unfitting runs, whole inherited obligations, and the bridged parent proof, including
its refusal to bridge through a child that failed its own check. The decomposition browser
lab verifies policy controls, candidate inspection, imports/exports and narrow
viewports. Its diagrams are allocation proposals, not physical traversal tests.
The combined demo additionally checks generated child content, stable ownership
across content changes, export, stages, and real collision movement across a join.
Realization unit tests validate paired portals and both body-sized swept routes,
replay those routes with actual movement, preserve holes and reject corrupt output.
Exploration tests check exact recursive ownership, depth/search limits, distinct
objective choices and terminal constraints. The browser inspector exercises tree
and branch selection and exports. Entry-seed and ruin-decay tests compare actual
positions/geometry, and the micro browser verifies decay applies automatically.
Boundary tests cover disconnected interiors behind open mouths, single-port
standing clearance, body-specific passages, freeform routes, inherited and paired
child obligations, and rejection of silently split crossings. Access validation
uses final collision geometry rather than trusting recorded routes.

`npm run check` parses every JavaScript module as Node would load it and confirms
every TypeScript module erases cleanly, which is what Node does instead of parsing
it. `npm run typecheck` is the separate, stronger pass: `tsc --noEmit` over
`shared/` under `strict`. Browser tests drive installed Google Chrome through
Playwright and start an isolated temporary server; screenshots land in
`test-results/`. `tests/browser.mjs` is one long scenario whose sections share
pages and rooms, so it takes minutes; a feature that needs only its own server and
tabs gets its own script, as `tests/dev-view.browser.mjs` (the dev view, 24) does,
so it can be iterated on in seconds. `npm run test:browser` runs them all.

`npm run test:times` times every unit test file alone, slowest first, and marks files over
budget (15 s fast tier, 60 s slow tier) with their slowest tests; `-- --strict` exits 1 on
any, and file paths limit it. Run it when adding or growing a test file. A file over budget is
optimized (share a generated map across tests, build fewer rooms), split into files
that run in parallel, or has its largest cases gated behind an environment variable as
`room-sizes` does. Files already over budget when this was added: `room-service`,
`room-directory`, `server`, `map-generator` and the slow `map-library`; they are the first
candidates, not a precedent.

The timing command exits 1 when any test process fails, cannot launch, or terminates
by signal, even without `--strict`. It prints the failure reason and captured test output.

Run timing comparisons sequentially, with no competing tests or benchmarks, and
repeat a suspected regression three times before believing it. Do not claim the
reported slowdown fixed without a captured slow run; see
[42](42-performance-history.md).

The hut's 172 by 172, 228-portal fixture builds its full geometry and enforces an
8-second wall-clock budget in the normal suite. This includes yard delegation
and receiving-cover construction; the measured cost compared with house-only
generation is recorded in [42](42-performance-history.md). Isolated timing runs use
`node --test --test-name-pattern=macro-sized tests/micro-hut.test.js`; they
separate builder cost from normal suite contention. The file also remains
subject to the strict 15-second isolated budget.

Other agents' worktrees share this machine's CPU. `npm run bench` and
`npm run bench:client` therefore take a machine-wide lock and wait for each
other rather than overlap. The lock (`tests/helpers/machine-lock.js`) is a
listening socket on loopback port 47913: the OS admits one holder and frees it
the moment that process exits or is killed, so nothing goes stale. It serializes
benchmarks only: another agent's `npm test` or browser run can still overlap a
timing run. Treat an unexpected regression as possibly contended, and repeat it
before reporting it.

`npm run bench:client` runs a client render and network benchmark in Chrome.
Options include `--seconds=<N>`, `--headed`, `--location=dense|crowded|offscreen`
to arrange entity crowds, and `--spectator` (`node tests/bench-client.mjs --spectator`)
to benchmark rendering the unfogged, whole-arena spectator overview at full zoom-out.

## The frozen fixture

The current frozen characterization fixture is `behavior-netcode-1.json.gz`, captured at
`95b7f1b`. Its historical chain is `5dd7d61` (fixture captured at `0cd204e`) →
`elements-1` (`9fe2d94`) → stored-arenas split (`aa833a6`) → `netcode-1`.
`elements-1` superseded `5dd7d61` when per-region element catalogues replaced the
single hardcoded building and changed every seeded map. `netcode-1` changed simulation
traces for queued input consumption and bot route straightening while carrying forward
the generated hashes and stored arenas.

The fixture separates what the generator emits from what the simulation does.
Complete ordered map hashes characterize generation. The bot and scripted traces
characterize the simulation, and they run against **arenas stored in the fixture
itself** — `createGame(seed, map)` takes the stored one — rather than against
whatever the generator currently emits. So a deliberate content change re-baselines
four hashes and leaves every trace intact, instead of destroying the evidence that
the simulation is unchanged along with the content it happened to run on. Map
diversity stays covered by those hashes and by `slow/bot-objective.test.js`, which routes
bots to completion over generated maps.

The frozen tests select legacy `content-1` through `contentById` while running under
simulation version `last-exit-0.7`. The shipped default `content-2` adds the third
hunter; see [14](14-match-rules.md) for the roster and [26](26-recording-contract.md)
for the version decision. This checkpoint must not alter any fixture bytes.

What the `generated` hashes cover is the **legacy generator**, `generateMap` in
`shared/map/generate.ts`, not the chain. So changes to the chain's library,
placement or strategies never move this fixture. They move the chain's own seed
sweep, `map/tools/fixtures/chain-baseline.json`, and `REGION_TYPES_VERSION`
([53](53-map-artifacts-and-tools.md)). Only simulation changes (bot behaviour,
or state added to a player and so to snapshots and projections) move the traces.

**Batching baseline-moving work.** The sweep is cheap enough to run on every
change as a drift diagnostic (about 25 s), but a deliberate content change recaptures
it once, last. When several such changes belong together, collect them on one
integration branch, check each with focused tests and the diagnostic, and
recapture once with a single `REGION_TYPES_VERSION` decision, so the first one to
merge does not leave the sweep check failing on `main`. A change that is meant to
be behaviour-preserving never recaptures. The 2026-10 batch is tracked in #295.

Never regenerate a fixture to make a refactor pass: a behaviour-preserving change
must reproduce it exactly. Regenerating is correct only for a deliberate content or
rules change that has been decided, and it restarts the evidence — the current
fixture proves nothing about code predating it. Separate intentional gameplay
changes, and the new expectations and version decision they require, from
behaviour-preserving extraction. `tests/fixtures/README.md` records provenance, how
to regenerate and how to audit.

`npm run check` recursively checks every module in server/shared/public/tests:
JavaScript is parsed as Node would load it, and TypeScript is verified to erase
cleanly, which is what Node does instead of parsing it. `npm run typecheck` is the
separate, stronger pass.

## Coverage

The tests currently cover deterministic seeded simulation, 200 generated maps, shape records and element stamping, continuous movement and physical gaps, gates and extraction, combat and kit progression, transit, stealth, visibility geometry, privacy projections, one input spent per tick, pacing/replay integrity, spectators, desktop controls, touch controls, mouse aim, client-side sight, shaded occlusion, and projectile interpolation. The receive buffer is covered separately and directly, against a clock the test drives rather than against wall time: uneven arrivals, a catch-up batch that skips ticks, starvation, a reordered or duplicated frame, and a discontinuity large enough to cut. Those are the conditions that distinguish a buffer from a smoothing filter, and none of them are reachable through a happy-path integration test.
The input queue is covered the same way, and the assertion that matters is that a client replaying its
unacknowledged inputs through the shared movement code lands on the server's position exactly, rather
than close to it. Around it sit the cases that decide whether that holds under load: acknowledging on
consumption rather than arrival, a queue trimmed when a client outruns the tick, a starved queue that
repeats movement but not one-shot presses, and a silence long enough to stop the player.
Latency measurement is tested for the properties that make it safe to trade on rather than merely
accurate: an invented or superseded token is refused, a token counts once, a stalled echo cannot pull
the reported minimum up on its own, and sustained stalling is clamped instead of believed.
Lag compensation is tested for the property that separates it from simply being generous: a target
that has stepped out of reach is still hit, and a target that has only just stepped into reach is
not. Around that sit cover at the rewound position, the bound on how far back it will reach, the
absence of compensation for travel-time projectiles, and the history staying out of recordings.
Content pinning is tested for what pinning is *for* rather than for the plumbing: a match given a
harder-hitting pistol hits harder, which only holds if the read goes through the match and not the
module the defaults live in. Alongside it, two matches hold independent copies, a match cannot edit
the balance it runs under, a kit is validated against the match's own table, and the content stays
out of every frame while the recording header names it.

Unit and server coverage includes 200-seed path clearance, 50-seed
placement/spawn/maze checks, ammo exhaustion and refill, sixth-slot selection,
move/merge validation, retained drops, doors and windows, hunter respawning, bot
retreat, abandoned-room archival and immutable replay commands. Objective-route runs
neutralize combat damage so PvP deaths do not invalidate navigation assertions.

Browser coverage includes keyboard and touch input, six slot icons, move/merge,
drops, charging and extraction, opening and walking through a real door, roof
transitions, occlusion, replay and spectators, and diagnostic download. Diagnostic reports are covered by `tests/room-service.test.js` (validation, clamping, limits, never a command) and `tests/diagnostics-episodes.test.js` (episode coalescing). A
deliberately injected 120 ms browser stall verifies diagnostics preserve long
frames rather than smoothing them away. The visibility polygon's culling is checked
against a brute-force implementation of the same rays over sixteen hundred cases,
including origins placed exactly on obstacle corners and edges, and must match it
vertex for vertex.

`tests/overhead.browser.mjs` uses a small controlled map with real Phaser textures
to check that a crown occludes an actor beyond the trunk, intermediate group alpha
changes pixels without rasterising or replacing textures, and camera culling and
map replacement release overhead textures. It runs in `test:browser`.

Boundary tests enforce ownership, not just behavior: server application code may
not use the diagnostic `room.game` escape hatch, transport may not reach the
simulation, and rooms may not reach gzip or filesystem details. Tests and
benchmarks may use `room.game` to arrange scenarios.

Human multiplayer balance is unverified by any of this. Passing local tests alone
establishes nothing about the reported slowdown.

## Live-chain checkpoint coverage

`tests/live-map.test.js` checks the runtime adapter, authored core sites, starter
loot, region/tier ownership, determinism and JSON prediction agreement. The
boundary tests cover concave edges, holes and whole-body clearance while pinning
legacy diamond movement. `tests/slow/live-map.test.js` plays combat-neutralized
bots through all three extraction slots on seeds 1, 9 and 4217. Transit strategy
and macro library tests check hunter access, standing space, six separate owned
regions and longitudinal distribution. `tests/slow/room-sizes.test.js` runs a bot
match to its end in a room at each authored size (14), checks every tick was
recorded in order, and reads sparse frames back through the replay timeline; it
takes about 11 s, 1 min and 4.5 min at 12 × 6, 24 × 12 and 36 × 18. Only 12 × 6 runs
by default, since the larger sizes rarely find what it misses; set `ROOM_SIZES` when a change
targets size-dependent generation, room limits or recording. These samples do not establish human balance or
exhaustive seed coverage.

The browser suite uses live-chain rooms for normal play, replay, mobile controls
and buildings. Its fixed-coordinate occlusion/projectile fixture explicitly uses
a legacy map. The projectile probe waits for the receive buffer to fill and fires
past its cover so the sampled projectile survives long enough to measure.

`npm run bench` now measures a live-chain match; `--legacy` keeps a comparable
legacy workload available. Client crowd fixtures use a central transit site when
there is no street graph, and the dense fixture uses a real building loot site.
