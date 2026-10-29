# 31. Verification

## Gates

Every gameplay or protocol change should pass the gates relevant to what it
touched; [Choosing checks by changed area](#choosing-checks-by-changed-area) says which
those are. An integration checkpoint runs the ones its area can move, not all of them.

```powershell
npm run check
npm run typecheck
npm run test:all
npm run test:browser
npm run bench
npm run bench:client
```

`npm test` and `npm run test:all` cap file concurrency at four, keeping CPU and memory contention
bounded on the shared machine. Each command runs every case in its selected tier; `test:all` includes the slow tier;
isolated file budgets are unchanged. The dated concurrency incident is retained in [42.3](42.3-generation-and-delegation-evidence.md#verification-cost-checkpoints).
Use the normal scripts for integration; focused `node --test` commands remain
available. The chain sweep's internal worker pool is separate.

The unit suite has two tiers. `npm test` is the fast tier for iterating on a PR:
everything under `tests/*.test.js`. Dated counts and timings are in
[42.3](42.3-generation-and-delegation-evidence.md#verification-cost-checkpoints). `npm run test:all` adds
`tests/slow/`: the 200-map route sweep, the bot-match traces against the frozen
fixture, and bots completing whole matches. Those slow tests sum to about four minutes
by default, plus about half a minute for the builder sweeps below, and their evidence
only moves when generation or simulation moves.
`tests/slow/room-sizes.test.js` and `room-sizes-physics.test.js` run only the 12 × 6 room unless asked
(`ROOM_SIZES=all`, or a list such as `ROOM_SIZES=24x12,36x18`; invalid or empty values fail with
the supported values). CI runs the slow tier after merge, on `main`, so a PR is opened and
merged on the fast tier; `npm run test:slow` runs it locally when a change is likely to move
it, such as generation or simulation work. An integration checkpoint runs the slow files its
area can move, not the whole tier by default ([Choosing checks by changed area](#choosing-checks-by-changed-area)). A test belongs in `tests/slow/` when it costs seconds and sweeps
seeds or plays whole matches. The fast tier keeps a cheap witness of the same
contract where one exists: the fixture's map hashes and scripted trace stay in
`characterization.test.js`.

Large end-to-end builder timing witnesses also belong in the slow tier when
they include decomposition and full child micro-generation. The 200 x 150
macro-block witness is `tests/slow/micro-block-scale.test.js` (#610), following
Corey's 2026-10-27 tier guidance. Its inputs and 5-second limit are unchanged, and
the limit is now opt-in like the other macro-sized ones (`BUILD_BUDGETS`, below);
moving tiers does not establish that the concurrent timing miss is fixed. Smaller block ownership, portal, determinism and physical builder
contracts remain in the fast tier. Run the slow scale file explicitly when
changing that path; `test:micro` does not include it.

Block circulation admission changes (#614) also run the final alley-child reach
witness in `tests/micro-block-circulation.test.js`; final-parent reach alone can
hide child failures through sibling lot interiors. Its geometric admission
checks cover clipped portal approaches and unsafe combined claims.

Corey's exact tier guidance (2026-10-27):

> macro block timings that bring in things like decomposition and microgenerations may no longer be viable for the fast track

Changes under `map/macro/` run its own suite with `npm run test:mapgen` from the repository
root (typecheck plus the unit tests in that directory). Its `tests/slow/` holds the larger authored-size
quota checks and runs in that same default macro suite; the seeds and assertions
are shared with the fast content checks, not reduced to fit the timing budget. The historical macro-suite checkpoint is also retained in 42.3. The Map Lab (`map/tools/lab/`) has its
own browser check, `node map/tools/tests/lab.browser.mts`, which `npm run
test:browser` runs. A change to the chain or its inputs (macro's stages and
library, the game's strategies, the kernel, `shared/`) also runs the chain's
seed sweep from the repository root, `node map/tools/cli.mts sweep --check
map/tools/fixtures/chain-baseline.json` (224 maps, two to three minutes, [42.3](42.3-generation-and-delegation-evidence.md#brief-replay-541-2026-10-27)); `npm test`
pins its quick cases. It must show no drift unless the PR declares a content
change and recaptures last ([53](53-map-artifacts-and-tools.md)). A change to one
region type's builder can iterate on `sweep --check ... --type <type>` first, which
rebuilds that type's cached briefs per region instead of regenerating every map; it
doesn't replace the full sweep ([53](53-map-artifacts-and-tools.md#replaying-one-region-type)).
Do not resize test grids or relax generation to make a check pass.

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
concave seed-1 and gate/crossing regression witnesses.

A builder's portal-promise sweep is the same promise on the same masks and parameters
at every seed, and most of its cost is the reach searches. The fast tier keeps a witness
and the original seeds run in `tests/slow/` (#543, measured in
[42.3](42.3-generation-and-delegation-evidence.md#builder-test-headroom-543-2026-10-27)):
`micro-block-promise` runs the first of four seeds on each mask and
`slow/micro-block-promise` all four; `micro-plant` runs two of eight seeds and
`slow/micro-plant-promise` all eight; `micro-compound` runs one of four seeds of its
portal and roofed-ring checks; `micro-compound-observer` keeps the one-seed
observer witness,
and `slow/micro-compound-sweeps` runs all four. Compound cell-order determinism
keeps a fast seed and all eight original seeds in `slow/micro-compound-determinism`
(#647). Each pair calls one function in
`tests/helpers/` (`block-promise.js`, `plant-promise.js`, `compound-sweeps.js`) with a
different seed list, so the assertions cannot drift apart. `test:micro` runs only the fast
files: a builder change that moves a type's output also runs that type's slow file, for
example `node --test tests/slow/micro-plant-promise.test.js`. Narrow a sweep this way, by
moving its seeds to the slow tier, only where the fast tier keeps a witness of the same
promise; do not narrow it by shrinking a grid or relaxing generation.

An access test routes from the portal stand nearest each target (`standNear` in
`tests/helpers/stands.js`), not from the region's first portal. A search ends at its
target, so the nearest stand costs a fraction of the first, and it proves the same thing:
the portal promise joins every portal's stands, and each builder's own sweep owns that.

Micro-generation changes additionally run `npm run test:micro`: focused contracts
and seeded builder tests plus isolated browser previews. Its unit files run one at a
time so macro-size timing witnesses do not compete with other tests. Contention was
not the sole cause of the timing misses: block's delegation dispatch added about
1.4 s (54%) on the macro-block witness and 2.6% across eight whole maps in the
review comparison ([42.3](42.3-generation-and-delegation-evidence.md#block-delegation-dispatch-cost-604--535-2026-10-26)). The unit tests also run
in `npm test`. The lab browser check verifies region type content, control
variation, result download and movement, and saves `test-results/micro-lab.png`.
It also toggles each building view for `hut`, `compound` and `block`, checks the drawn
counts against the build in memory, and shows unmet guidance as a warning
([56](56-buildings.md) L4, L5).
`node tests/region-explorer.mjs` checks the Region Builder Explorer's full builder
catalogue, shape and size controls against direct builds, core-site output, JSON
download, zoom/pan, walker placement, arrow movement and compact layout. It runs
in `test:micro` and saves `test-results/region-explorer.png`. The focused
`tests/region-examples.test.js` checks preset topology, portal access, bounds and
core requests without changing the production generator or its fixtures.
CLI batch generation/validation and limits are described in [20.5](20.5-tools-and-next-boundaries.md).
Decomposition checks cover immutable contexts and trial claims, graph/topology
analysis, generator contracts, residual tradeoffs, exact ownership and interface
accounting, corrupted artifacts, and CLI round trips. The decomposition browser
lab verifies policy controls, candidate inspection, imports/exports and narrow
viewports. Its diagrams are allocation proposals, not physical traversal tests.
The generation demo checks that its example and a linked map's block show what
`buildRegion` built, their lots and alleys, stages, download and real collision
movement. Exploration tests check exact recursive ownership, depth/search limits,
distinct objective choices and terminal constraints. The browser inspector
exercises tree and branch selection and exports. Brief children are checked by
inference with `validateBriefPartition` (20.7), and portal promises from final
collision geometry with `validatePortalReach`, rather than from recorded routes.
The negotiation, realization and explicit-port access and boundary tests retired
with what they tested (#483).

`tests/micro-builder-contract.test.js` (#540) holds every registered region type to the
promises of a builder (20.9) over chain-like briefs (`tests/helpers/chain-briefs.js`),
which carry what a bare rectangle with portals lacks: cleared strips inside the owned
cells, concave and holed masks, many portals, hints and a playable area larger than the
owned cells (20.6). A builder loop runs only its own type, in seconds:
`node --test --test-name-pattern=plant tests/micro-builder-contract.test.js`.
`BUILDER_SEEDS=<n>` runs seeds 1 to n on each fixture instead of two, for a builder change
that moves a type's output; `BUILDER_SEEDS=20` took 67 to 70 s across all seventeen types.
The default matrix, six fixtures of 224 to 660 cells at two seeds, plus #490's 120 plant
builds, took about 9 s on the shared dev machine (14 s once, while it was busy), against the
fast tier's 15 s; its comment records the sizing.

`npm run check` parses every JavaScript module as Node would load it and confirms
every TypeScript module erases cleanly, which is what Node does instead of parsing
it. It walks `server/`, `shared/`, `map/micro/`, `map/kernel/`, `map/tools/`,
`public/`, `tests/` and `tools/`. `npm run typecheck` is the separate, stronger
pass: `tsc --noEmit` under `strict` over `shared/`, `map/micro/`, `map/kernel/` and
the `map/*.ts` entry modules, then over `map/tools/` (including its `.mts` files,
which the check walk does not strip). Both typecheck passes reject unused locals and
imports (`noUnusedLocals`) but not unused parameters, because some signatures are
kept interchangeable on purpose (`couldSee` in `shared/simulation/visibility.ts`).
`map/macro/` is outside both commands: its own `npm run test:mapgen` typechecks it,
rejecting unused parameters as well, before running its tests. Browser tests drive installed Google Chrome through
Playwright and start an isolated temporary server; screenshots land in
`test-results/`. `tests/browser.mjs` is one long scenario whose sections share
pages and rooms, so it takes minutes; a feature that needs only its own server and
tabs gets its own script, as `tests/dev-view.browser.mjs` (the dev view, 24) does,
so it can be iterated on in seconds. `npm run test:browser` runs them all.

The shipped default is physics content (#523), and `tests/browser.mjs` pins the legacy set and factory it was
written for: its fixtures swap a room's map and place actors by assigning positions on the server's game, which a
physics world does not accept. `tests/default-physics.browser.mjs` is the default room's core client flow (lobby,
start, walking, dropping an item); the `physics-*` scripts cover the physics client's other features. A new browser
check of default behavior goes in one of those, not in `browser.mjs`.

`npm run test:times` times every unit test file alone, slowest first, and marks files over
budget (15 s fast tier, 60 s slow tier) with their slowest tests; `-- --strict` exits 1 on
any, and file paths limit it. With no paths it times every unit file of `npm run test:all`
and `npm run test:mapgen`: `tests/`, `map/macro/tests/` and the `slow/` directory of each,
where a file under `slow/` is slow tier. Browser scripts and opt-in size runs are not in it.
Run it when adding or growing a test file. A file over budget is
optimized (share a generated map across tests, build fewer rooms), split into files
that run in parallel, or has its largest cases gated behind an environment variable as
`room-sizes` does. The room harness shares maps for tests about room policy rather than
maps: `roomHarness({ reuseMaps: true })` gives every room its own copy of a map generated
once per file, as `room-directory` does (#376: about 26 s to 3 s). Files already over budget
when this was added: `room-service`, `room-directory` (since fixed), `server`, `map-generator`
and the slow `map-library`; they are the first candidates, not a precedent.

Shared test helpers live in `tests/helpers/`. Use them rather than copying them:
`cells.js` (`cellsOf`, a rectangle's cells row by row), `chain-briefs.js` (`chainBrief`,
a brief with the margins the chain applies, `chainFixtures`, the masks the builder
contract runs, `reorderedBrief`), `block-masks.js`, `plant-fixtures.js` and
`compound-fixtures.js` (a type's briefs, masks and seeds, which its fast and slow files
share), `stands.js` (`standNear`), `listen.js`, `browser.js`
(`serveWithBrowser`, a server and headless Chrome for the browser scripts), `args.js`
(the bench and demo `--key=value` map), `room-harness.js` (which pins the legacy mover, `content-5` and
the synchronous `createMatch`, because its tests are about room policy and not an engine; a physics room
passes `content: defaultContent, matchFactory: createMatchFor` and awaits `room.ready`), `room-sizes.js`
and `machine-lock.js`. The
maintained command-line tools share `tools/options.mjs`; the one-off audit scripts
under `tools/` are evidence and keep their own parsing.

The timing command exits 1 when any test process fails, cannot launch, or terminates
by signal, even without `--strict`. It prints the failure reason and captured test output.
No gate runs `--strict`: the budgets are wall-clock times on a machine other agents'
worktrees share, and the files listed above are already over them, so a strict gate
would fail on contention or on known debt rather than on the change under review. It is
for checking the files a change adds or grows, run in isolation.

Run timing comparisons sequentially, with no competing tests or benchmarks, and
repeat a suspected regression three times before believing it. Do not claim the
reported slowdown fixed without a captured slow run; see
[42](42-performance-history.md).

The hut's 172 by 172, 228-portal fixture builds its full geometry in the normal suite,
including yard delegation and receiving-cover construction; the measured cost compared
with house-only generation is recorded in [42](42-performance-history.md). The file
remains subject to the strict 15-second isolated budget.

**Build durations are measured on request, not asserted by default** (#548, which
supersedes #567's `CI` skip). The macro-sized cases build one region with hundreds of
portals and check what it holds: the cover, compound, depot, hut and plant cases in
`tests/micro-*.test.js`, and the slow `micro-block-scale`. Those assertions are the
functional witness and stay in the fast tier; each fast-tier case costs 0.3 to 2 s alone
(measurements in [42.3](42.3-generation-and-delegation-evidence.md#build-duration-assertions-made-opt-in-548-2026-10-27)).
How long a build took depends on the machine and what else it runs, so the default run
neither asserts nor prints it. `tests/helpers/budget.js` reads `BUILD_BUDGETS`, and an
unrecognised value fails with the supported ones:

| `BUILD_BUDGETS` | Does |
| --- | --- |
| unset | nothing: the case builds and checks its contents |
| `report` | prints each duration against its limit and never fails; the measuring path |
| `enforce` | fails a case past its limit; the enforcing path |

```powershell
$env:BUILD_BUDGETS = 'report'   # or 'enforce'
node --test --test-concurrency=1 --test-name-pattern=macro-sized tests/micro-cover.test.js tests/micro-compound.test.js tests/micro-depot.test.js tests/micro-plant.test.js tests/micro-hut.test.js tests/slow/micro-block-scale.test.js
Remove-Item Env:BUILD_BUDGETS
```

On a POSIX shell, put `BUILD_BUDGETS=report` before `node`. Add one file to the list to
time just that builder; the pattern selects the macro-sized case alone, which separates
builder cost from the rest of the file and from suite contention. `enforce` is for a quiet
machine and one file at a time, with no other agent's tests or benchmarks running: the
limits (cover 2 s, compound, depot and plant 3 s, block 5 s, hut 8 s) are ceilings that catch a builder
turning quadratic, set above that machine's isolated readings, and are not capacity
promises. They sit 1.4 to 7 times above the readings, the block's 5 s the closest, so a loaded or
slower machine can fail one without a regression; repeat before believing it. CI does not
set the variable. A threshold that should gate every run belongs in a deterministic
count (work, portals visited, pieces placed), not a duration.

Other agents' worktrees share this machine's CPU. `npm run bench` and
`npm run bench:client` therefore take a machine-wide lock and wait for each
other rather than overlap. The lock (`tests/helpers/machine-lock.js`) is a
listening socket on loopback port 47913: the OS admits one holder and frees it
the moment that process exits or is killed, so nothing goes stale. It serializes
benchmarks only: another agent's `npm test` or browser run can still overlap a
timing run. Treat an unexpected regression as possibly contended, and repeat it
before reporting it.

Owner-probe socket resets are ignored: a waiting process may time out its probe
while the holder is CPU-bound, and that diagnostic disconnect must not crash the
holder (#437).

`npm run bench:client` runs a client render and network benchmark in Chrome.
Options include `--seconds=<N>`, `--headed`, `--location=dense|crowded|offscreen`
to arrange entity crowds, and `--spectator` (`node tests/bench-client.mjs --spectator`)
to benchmark rendering the unfogged, whole-arena spectator overview at full zoom-out.
`--viewport=WxH` and `--dpr=N` match a reported device's window, `--software-gl` draws
WebGL on SwiftShader, and `--diagnostics=FILE` saves the player-facing download.
`tests/bench-session.mjs` samples one long match every interval instead, optionally
roaming, at a native device scale, or against another checkout (`--root`); see 42.2 (#549).

`npm run bench:stages` (`tests/bench-stages.mjs`) attributes the server tick by stage: it runs
whole rooms through the server loop body (advance, recording, spectator history, broadcast with
projection, layer encoding and serialization) and keeps every tick of every `sim.*`/`loop.*` timer,
so each tick over 50 ms is classified by stage, keyframe cut and overlapping GC. It drains the recorder between
ticks, outside the measured time, and fails a run whose recorder drops a frame. `--rooms`,
`--clients`, `--spectators` and `--no-record` shape the load; `--tile=CxR` repeats a real map at
the same density for sizes the protocol does not serve. It takes the same lock. Method and the
first results are [42.22](42.22-tick-cost-attribution.md) (#637).

## Choosing checks by changed area

A check is worth running when something the change touched can move what it asserts.
The gates above are the whole set, not a default: `npm run test:all`, the sweep, the
browser scripts and the benchmarks are chosen by the area changed, because a slow file
the change cannot move adds minutes and no evidence (#542). Three tiers:

| Tier | When | Runs |
| --- | --- | --- |
| Inner loop | every edit | The narrowest check that fails when the edit is wrong: a test file, a `--test-name-pattern`, or a replay. Seconds |
| Before the PR | once | What CI's `verify` runs ([below](#continuous-integration)): `npm run check`, `npm run typecheck`, `npm test`, and for a change under `map/macro/` also `npm run test:mapgen`, run from the repository root; plus the area's extras |
| Integration | once per PR, where the area can move it | The sweep, slow files, browser scripts and benchmarks the area calls for |

| Changed area | Inner loop | Before the PR, beyond those gates | Integration |
| --- | --- | --- | --- |
| One region type's builder or strategy | the type's files (`node --test tests/micro-plant*.test.js`); its builder-contract row (`node --test --test-name-pattern=plant tests/micro-builder-contract.test.js`); its replay (`sweep --check FILE --type plant`, 53) | `npm run test:micro`; the type's slow file when the change moved its output | the full chain sweep, no drift unless the PR declares a content change, recaptured last (53); `validate --diagnose true` on the maps it names as drifted |
| Macro stages, the chain's authored library, the kernel | `npm run test:mapgen` | | the full chain sweep, recaptured last for a content change (53); the `map-library` slow files |
| The legacy generator (`shared/map/generate.ts`) | the map hashes in `tests/characterization.test.js` | | `map-sweep`, `bot-objective` |
| Simulation, bots, snapshots and projections | `tests/characterization.test.js`; the unit file for the rule | | `characterization-bots`, `bot-objective`, `live-map`; `test:browser` or `bench` when the change reaches the client or tick cost |
| Rooms, recording and replay | the unit file for the rule | | `room-sizes` |
| Physics | the unit file for the rule | `npm run test:physics` | `physics-navigation`; the physics scripts in `test:browser` |

The replay needs its cache captured before the first edit (53). An area not listed
follows the gates above and the paragraph that describes its suite. Whatever the area,
a fixture is never regenerated to make a check pass (below), and timing comparisons run
sequentially.

A builder or strategy change does not run `test:all`. `characterization-bots`,
`bot-objective` and `map-sweep` never build a chain map. `map-library`, `live-map`,
`physics-navigation` and `room-sizes` build one only to report its defects or play a
match, so all they can see is a defect, a crash or a stalled bot, which the sweep's
`built` and `report` hashes and `diagnoseBuiltMap` show first. The exceptions are the type's own slow files, above, and
`map-library-24` and `map-library-36*`: the sweep's chain cases are 12 × 6 games and
smaller playgrounds (53), so those files alone check the report at the larger authored
sizes. Run them when the change alters what a region holds, such as its loot.

What each `tests/slow/` file runs on, what it asserts, and what can move it:

| File | Runs on | Asserts | Moved by a change to |
| --- | --- | --- | --- |
| `characterization-bots` | arenas stored in `behavior-nav-1.json.gz`, `content-1` | every tick's snapshot and the `c0`, `g0` and spectator projections of four bot matches equal the fixture's digests | simulation, bots, snapshot and projection shapes; not generation, which the stored arenas replace |
| `bot-objective` | the legacy generator, seeds 1, 9, 4217 | combat-neutralized bots complete the objective and fill all three pods | the legacy generator, simulation, bots |
| `map-sweep` | the legacy generator, 200 seeds | a no-key route for both body sizes, loot and charger standing room, route clearance | the legacy generator, movement, the navigation grid |
| `live-map` | the chain through `generateLiveMap`, seeds 1, 9, 4217, and the larger authored size | bots fill all three extraction slots within the match duration; the larger size generates with a matching recipe | simulation, bots, the live adapter (`map/live.ts`); chain output only as a stall or crash |
| `physics-navigation` | the chain through `generateLiveMap`, seed 4217, `content-physics-8` | physical contestants complete the match | physics, navigation; chain output only as a stall or crash |
| `room-sizes` | the chain, one room per authored size (12 × 6 unless `ROOM_SIZES`), on the legacy mover the room harness pins | the room plays to its end, records, and replays | rooms, recording, the replay timeline, size-dependent generation |
| `room-sizes-physics` | the same, on the shipped default `content-6` and the physics engine (#523) | the physics room plays to its end, its recording names `last-exit-0.8-physics-8`, and the map fits the content's ground capacity | rooms, recording, physics, item capacity, size-dependent generation |
| `map-library` | the chain at the game size | 25 maps report no defects; every region of one keeps its portal promise (`diagnoseBuiltMap`) | macro stages, the library, a region type's builder |
| `map-library-24`, `-36`, `-36-tail` | the chain at larger authored sizes, five seeds | `checkMap` finds no defect; set-piece share and loot per tile stay in bounds | macro stages, the library, what a builder puts in a region |
| `micro-block-promise`, `micro-plant-promise`, `micro-compound-sweeps` | each type's synthetic fixtures, every seed | the portal promise (and the compound's ring checks) | that builder |
| `micro-compound-access`, `micro-compound-siting-solution` | compound masks and gate counts; the stored authored quarter | rooms and court reachable through gates; the stored quarter builds a traversable compound | the compound builder and siting |
| `micro-block-scale` | one macro-sized block, hundreds of portals | more than 50 structures and no lots in the manifest; the 5 s limit applies only under `BUILD_BUDGETS=enforce` | the block builder and its delegation |

A new `tests/slow/` file adds its row here in the same change.

## Continuous integration

Forgejo Actions runs `.forgejo/workflows/ci.yml` in fresh `node:24.15.0` containers with
the npm that `packageManager` names, as two jobs on separate runner queues:

- **`verify`** (label `docker`) runs on every pull request and every push to `main`:
  `npm run check`, `npm run typecheck`, `npm test` and `npm run test:mapgen`. It is the
  pull request's check, and takes a few minutes.
- **`slow`** (label `slow`) runs `npm run test:slow` on every push to `main`, after
  merge, so pull requests never wait for it. When it fails,
  `tools/ci/slow-failures.mjs` files one issue per failing test, titled
  "Slow tier fails on main: <test>", or one issue for more than five failures together;
  a repeat failure comments on the open issue instead. Whoever fixes it closes the issue.
  The tests get 35 of the job's 45 minutes: past that they are killed and the filer
  reports "Slow tier times out on main", because at the job's own limit Forgejo
  cancels every step, the filer included.
  To run the slow tier on a branch before merge, start the workflow by hand from the
  Actions tab (`workflow_dispatch`); that run files no issues.

Results show on the pull request or commit and under the repository's Actions tab. A
newer push to the same branch cancels that branch's queued and running runs, so `main`
tests its latest commit: during a burst of merges the slow tier keeps restarting and
finishes in the first quiet spell, and a cancelled run files no issue. Merging or
closing a pull request does not cancel its own runs, so `cancel-closed-pr.yml` does,
through `tools/ci/cancel-pr-runs.mjs`; otherwise they would hold runner slots ahead
of `main`'s run. It skips pull requests from forks, whose token cannot cancel runs;
cancel those by hand from the Actions tab.
While no runner serves a label, its jobs wait rather than fail; who runs runners is in
[34](34-forgejo-workflow.md#hosting).

CI is a floor, not the gate set. It does not run:

- **`npm run test:browser`.** It needs installed Google Chrome, which the
  container lacks. Renderer and client changes still run it locally.
- **`npm run bench` and `npm run bench:client`.** Wall-clock thresholds on a
  shared runner would fail at random, so benchmarks never
  gate CI. Compare them sequentially on a quiet machine, as above.

A green run does not discharge the author's own checks for what the change
touched; a failed `verify` is fixed before the pull request is ready, and a slow-tier issue
is fixed forward. CI uploads no artifacts: recordings,
diagnostics and screenshots stay on the machine that made them.

## P7 ballistic lab

P7's isolated ballistic lab is checked by `tests/physics-ballistics.test.js` and
`node tests/physics-ballistics.browser.mjs` (also in `test:browser`). These cover
analytic height/planar overlap, event ties, mask containment, bounds and retained
state-only playback including actual shadow/sprite pixels and Node/Chrome equality.
`npm run physics:ballistics` writes reproducible JSON and standalone HTML under
`test-results/`; no game server or engine is required to open the HTML. This
lab-only change does not trigger the shared/server/map full-suite or seed-sweep
gate. It does not establish live gameplay or arbitrary authored-map coverage.

## P8 dynamic navigation

P8's focused witnesses are `physics-drop-occupancy`, `physics-dynamic-navigation`
and `physics-navigation-policy` unit files. They cover atomic drop refusal,
mandatory retry, actual solver detours, moving/sleeping props, mixed roles,
queue/resume, teleport invalidation, remembered-door/hidden-geometry equivalence
and bounded crowd queries. `tests/physics-navigation.browser.mjs` compares a
complete autonomous pickup/charge/escape trace in Node and Chrome. The P8
live-chain whole-match witness is `tests/slow/physics-navigation.test.js`.
Review regression files `physics-navigation-following`, `physics-navigation-heading`
and `physics-navigation-cache` cover contact-range following, normal motor crate
pushing, queued heading, shared point sight and collection-scoped query reuse.
The crowd comparison is `node tools/physics/navigation-report.mjs`; run after other
CPU-heavy gates finish. Evidence and limits belong to [42.19](42.19-physics-p8.md).

## P9 integration and playtest

P9's `tests/physics-integration.test.js` exercises an actual experimental room's
creation-pinned mode, withheld distant body, delayed spectator pose, reconnect
body keyframe and disposal. `tests/physics-diagnostics.test.js` verifies detached
world-unit contact/force diagnostics without changing gameplay capture.
`tests/physics-playtest.browser.mjs` covers local A/B/C scenes, real contacts and
hook force, tuning reset, bounded recordings, JSON download and exact action
rerun, diagnostic solid-geometry casts, plus disabled routes. It runs in `test:browser`. Reproduce the sequential
synthetic envelope with `npm run physics:integration`; reproduce the actual
physics client entry workload with `node tests/bench-client.mjs --physics --json`.
These complement the existing privacy, prediction, item conservation, replay and
bot witnesses; their measured scope and outstanding human gates are [42.20](42.20-physics-p9.md).

## The frozen fixture

The current frozen characterization fixture is `behavior-nav-1.json.gz`.
Its complete lineage, capture and introduction commits, digests and reconstruction
instructions belong to [the fixture README](../tests/fixtures/README.md).

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
simulation version `last-exit-0.7`. `content-2` adds the third hunter, and the shipped
default `content-5` plans bots over free-space tiles, each search spread over ticks and nearby changes repaired at once; see [14](14-match-rules.md) for the
roster and [26](26-recording-contract.md) for the version decisions. This checkpoint must not alter any fixture bytes.

What the `generated` hashes cover is the **legacy generator**, `generateMap` in
`shared/map/generate.ts`, not the chain. So changes to the chain's library,
placement or strategies never move this fixture. They move the chain's own seed
sweep, `map/tools/fixtures/chain-baseline.json`, and `REGION_TYPES_VERSION`
([53](53-map-artifacts-and-tools.md)). Only simulation changes (bot behaviour,
or state added to a player and so to snapshots and projections) move the traces.

**Batching baseline-moving work.** The sweep is a drift diagnostic for any change that
touches the chain (two to three minutes; a builder change iterates on the replay
first), but a deliberate content change recaptures it once, last. When several such changes belong together, collect them on one
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

`npm run check` recursively checks every module in the directories listed under
the verification tiers above: JavaScript is parsed as Node would load it, and
TypeScript is verified to erase cleanly, which is what Node does instead of parsing
it. `npm run typecheck` is the separate, stronger pass.

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

Browser coverage includes keyboard and touch input, six slot icons, move/merge, L2 reload controls,
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
bots through all three extraction slots on seeds 1, 9 and 4217, each bounded by
the match duration so a stalled match fails rather than hangs. Transit strategy
and macro library tests check hunter access, standing space, six separate owned
regions and longitudinal distribution. `tests/slow/room-sizes.test.js` runs a bot
match to its end in a room at each authored size (14), the owner disconnected and
an owner spectator keeping it from abandonment, checks each tick reaches the
recorder once and in order, and reads sparse frames back through the replay timeline; it
takes about 11 s, 1 min and 4.5 min at 12 × 6, 24 × 12 and 36 × 18. Only 12 × 6 runs
by default, since the larger sizes rarely find what it misses; set `ROOM_SIZES` when a change
targets size-dependent generation, room limits or recording. These samples do not establish human balance or
exhaustive seed coverage.

The browser suite uses live-chain rooms for normal play, replay, mobile controls
and buildings. Its fixed-coordinate occlusion/projectile fixture explicitly uses
a legacy map. The projectile probe waits for the receive buffer to fill and fires
past its cover so the sampled projectile survives long enough to measure.

`npm run bench` now measures a live-chain match; `--legacy` keeps a comparable
legacy workload available, and `--content=<id>` runs an earlier content set, such as
`content-2`'s grid planner or `content-3`'s whole-tick searches or `content-4`'s sliced searches without repair against the default `content-5` (#424, #470). Like a room, it adopts the tiles a map worker would build, untimed; `--cold` leaves bots to build them on their first plans (42.8). Client crowd fixtures use a central transit site when
there is no street graph, and the dense fixture uses a real building loot site.
