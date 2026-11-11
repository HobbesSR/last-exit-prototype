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
isolated file budgets are unchanged. CI uses the same four; it does not size concurrency to its
runner (Corey, 2026-11-05, #800 S5), so per-file times stay comparable across machines. The dated concurrency incident is retained in [42.3](42.3-generation-and-delegation-evidence.md#verification-cost-checkpoints).
Use the normal scripts for integration; focused `node --test` commands remain
available. The chain sweep's internal worker pool is separate.

Agents run test scripts through `npm run brief -- <script>` (for example `npm run brief -- test`
or `npm run brief -- test:slow`), because every line of test output they read is paid for in
context, and in each agent that reads it. `tests/brief.mjs` runs the script with
`tests/brief-reporter.mjs`, which writes one line per test file (its name, how many tests
passed and its wall time), the name, location and error of each failure, any diagnostic node scopes to a file (such
as an error from asynchronous activity after a test ended), the crash output of a file that fails
outside any test, and a closing count; a failing TODO counts as TODO, as in node. The exit status
is the script's. The wrapper replaces any reporter already set in `NODE_OPTIONS`, and
`test:times` drops the inherited one because it parses spec output. Agents start long runs in
the background and wait for the exit notification instead of polling the output. `--test-reporter`
cannot simply be appended (`npm test -- --test-reporter=...`): node ignores it after the file globs.

<a id="recorded-test-times"></a>

**Recorded test times** (#800). Every run through `brief` records each file's wall time and each
top-level test's duration in `test-results/test-times/<script>.json` (ignored by git), keeping the
last ten runs, with the run's wall time, CPU count and how busy the machine was (this run's own
tests included). The file is replaced whole, so a reader never sees part of one; two runs of the
same script finishing at the same moment can keep only one of them. The output pays two lines at most for it: `slowest:` names the five slowest
files, and `slower:` names, on one line, up to five files at least twice their median over three
or more recorded runs and three seconds more, and how many more there are. A `slower:` line is a prompt to look, not a verdict: the busy share says how
loaded the machine was, and a regression is believed only after the repeats this section asks
for. Read the record for a file's history or its slowest tests rather than re-running it with the
spec reporter; `test:times` stays the isolated per-file measurement against the budgets.

The unit suite has two tiers. `npm test` is the fast tier for iterating on a PR:
everything under `tests/*.test.js`. Dated counts and timings are in
[42.3](42.3-generation-and-delegation-evidence.md#verification-cost-checkpoints). `npm run test:all` adds
`tests/slow/`: the bot-match traces against the frozen
fixture, bots completing whole matches, and the builder sweeps below. Its 19 files took
235 s timed one at a time on 2026-11-06, after #822 fitted each to its claim (26 files and 871 s on
2026-11-05, #808; each set's share is in
[Integration checks per set](#integration-checks-per-set)), and their evidence only moves when
generation or simulation moves.
`tests/slow/room-sizes.test.js` runs only the 12 × 6 room unless asked
(`ROOM_SIZES=all`, or a list such as `ROOM_SIZES=24x12,36x18`; invalid or empty values fail with
the supported values). CI runs the slow tier after merge, on `main`, so a PR is opened and
merged on the fast tier; `npm run test:slow` runs it locally when a change is likely to move
it, such as generation or simulation work. An integration checkpoint runs the slow files its
area can move, not the whole tier by default ([Choosing checks by changed area](#choosing-checks-by-changed-area)). A test belongs in `tests/slow/` when it costs seconds and sweeps
seeds or plays whole matches. The fast tier keeps a cheap witness of the same
contract where one exists: the frozen fixture's scripted trace stays in
`characterization-physics.test.js`.

**A test that generates a map down to building is slow-tier work** (Corey, 2026-11-07, on review 672
of #853). Under the matched libraries a 12 × 6 game map takes about 10 s to build (42.37), so the fast
tier keeps macro, brief and synthetic-brief tests, and building ones move to `tests/slow/`, whole
files or the tests that build. A test that needs a map only as a place to play uses an arena sized
to the task ([Test arenas](#test-arenas)): room and networking tests read the pregenerated room
arena. The playground quick cases stay pinned in the fast `map-sweep`; the game quick case is in
`slow/map-chain-sweep`.

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
map/tools/fixtures/chain-baseline.json` (224 whole maps, plus macro alone on two seeds at each larger authored size, about ten minutes since the matched libraries (595 s, 42.37), [42.3](42.3-generation-and-delegation-evidence.md#brief-replay-541-2026-10-27)); `npm test`
pins its quick cases. It must show no drift unless the PR declares a content
change and recaptures last ([53](53-map-artifacts-and-tools.md)). A change to one
region type's builder iterates on `sweep --check ... --type <type>`, which rebuilds that
type's cached briefs per region rather than regenerating every map
([53](53-map-artifacts-and-tools.md#replaying-one-region-type)), and still runs the full sweep
once before its PR ([The replay or the full sweep](#the-replay-or-the-full-sweep)).
Do not resize test grids or relax generation to make a check pass.

The chain's authored library (52) is checked against the actual region strategies.
Macro's `tests/chain-content.test.ts` checks the game quotas in 52, distinct
enormous pieces, and core element regions staying inside their owning instances.
Root `tests/map-library.test.js` checks one map with 24 contestants: its core element
counts, actual huts, cover and rubble, that each core element is reachable from its
region's first portal (the strategies' own siting rule in 54, not a contract), and the
portal promise within each non-open region under the thorough search. That map holds
more region types than the default count's, and fails if the count is ignored. The
default count's fast witness is the default game map `map-tools` already generates: the
same checks but the portal search, about 10 ms. `slow/map-library` runs the same checks with 8
contestants on the one map it diagnoses in full, the large open regions too.
`tests/helpers/map-library-game.js` holds the checks they all share. A slow report batch of
25 library seeds (20 with 8 contestants, 5 with 24, 111 s) retired in #822: the chain sweep
refuses any map whose report has defects, over its 161 game-size maps (53). The batch's 24-contestant
maps kept the default 2 exits and 3 hunters; the sweep's `game-crowded` has 24 at 3 exits and 6 hunters,
a different shape, so that combination went from five slow seeds and the fast `library-4` to
`library-4` alone. Until
#807 the fast file checked both counts with the portal search on each map (the search,
not generation, was most of its 21.8 s isolated), and one slow file ran the whole batch
(110 s).
These are bounded samples, not a guarantee for every seed. `tests/map-container.test.js`
saves and reloads this library's game-size map through JSON, BSON and Layout-only
regeneration with the real strategy version (53).

The larger authored sizes (24 × 12 and 36 × 18) are checked a layer at a time, never as whole
maps (Corey, 2026-11-05, #821). Macro's stages, layout through briefs, are pinned by the chain
sweep's `macro-24x12` and `macro-36x18` cases (two seeds each, nothing built), which
`tests/slow/map-macro-sizes.test.js` also runs on `main`'s slow tier; macro's own
`tests/slow/chain-content.test.ts` checks their quotas, proof and set-piece share. What builders
make of those sizes' briefs is `tests/slow/micro-large-briefs.test.js`: for each type whose larger-size briefs exceed the full
sweep's 12 × 6 maximum (13 of 17), the stored brief with the most portals or cells
(`tools/large-briefs.mjs`, tests/fixtures README), each built and checked for the claims the
maps' reports made of a region (it builds, stays in its fill and counts every cell; none of these
briefs asks for a core element, as the core element types are no larger there), not the thorough portal search, which costs up to 80 s on one of them. Composing
and reporting are size-generic, so they run only at 12 × 6. The `map-library-24`, `-36` and
`-36-tail` files this replaces built five whole maps a size, 353 s, about 85% of it builds.

The tools in `map/tools/` are checked by `tests/map-tools.test.js`, which drives
the CLI and MCP as subprocesses, and typechecked by `npm run typecheck` under
their own `map/tools/tsconfig.json`, which checks what they reach in macro as
macro's own config does. It reads a Layout alone through `readMap` on a small
playground map; a game map's Layout-only rebuild is `map-container`'s (#807).

`tests/map-sweep-replay.test.js` captures the quick cases once, for a game map's
markets. Its drift, throw and reach-mode cases tamper with huts: they test the replay,
not a type, and a hut's thorough portal check costs about 0.05 s a region against a market's 0.7 s.
`tests/appearance-descriptor.test.js` reads one live chain map for its depot, market
and round-trip cases, and samples hut seeds only until every decay tier and two
distinct scorch and drain placements have appeared (#807).

The compound's multi-mask room/court routes run in `tests/slow/micro-compound-sweeps.test.js`
on each mask's one-gate case, to open points rather than loot sites (#820, #822); the fast
delegation file keeps the concave seed-1 and gate/crossing regression witnesses.

A builder's portal-promise sweep is the same promise on the same masks and parameters
at every seed, and most of its cost is the reach searches. The fast tier keeps a witness
and the original seeds run in `tests/slow/` (#543, measured in
[42.3](42.3-generation-and-delegation-evidence.md#builder-test-headroom-543-2026-10-27)):
`micro-block-promise` runs the first of four seeds on each mask and
`slow/micro-block-promise` all four; `micro-plant` runs two of eight seeds of its promise
and spacing sweeps and `slow/micro-plant-promise` all eight, with #490's plant strips at
three of forty seeds fast (in the builder contract) and all forty slow; `micro-park` runs its
promise on every mask under every parameter set and its cell-size sweep at the first seed, and its
clump-spacing and kind sweeps at two, and `slow/micro-park-promise` runs each mask under each
parameter set once more, the seed rotating over 2 to 5, and each cell size at seeds 2 to 6, with the
promise, spacing and kind checks reading the same sixteen builds (`SLOW_CASES`, #822; nine of them
place trees, and the dense ones, one seed per mask, carry most of the spacing check), and the 36-portal park
(#759, #760: cord-routed builders and park's hedge fronts cost several times more; #807); `micro-hut` runs one of
sixteen seeds of its small-house sweep and `slow/micro-hut-sweeps` all sixteen; `micro-compound` runs its
portal, roofed-ring and observer checks on seven cases at the first seed (each mask at the
default two gates, one and three gates on the small yard, and four on the ell, where the
concave corner leaves no fourth gate stand until the ring steps down from 18×22 to 16×20, #807), and
`slow/micro-compound-sweeps` runs every mask at every gate count once more, the seed rotating
over 2 to 4 so each mask and each gate count meets all three (`SLOW_CASES`, #822). It builds each
case once with the observer on; whether observing changes the build is checked on the fast cases.
Compound cell order has a fast witness in `micro-compound-exterior` (elements and loot) and
`micro-compound-delegation` (the whole delegation tree, the only one that sees the root brief's
canonical order). An eight-seed slow file retired: with the root sort and the region mask's sort
removed it still passed every seed (#822). Each pair calls one function in
`tests/helpers/` (`block-promise.js`, `plant-promise.js`, `park-fixtures.js`,
`builder-contract.js`, `compound-sweeps.js`, `hut-fixtures.js`) with different inputs (a seed list, or for
compound a case list: `FAST_CASES` fast, `SLOW_CASES` slow), so the assertions cannot drift apart. `test:micro` runs only the fast
files and the micro labs: a builder change that moves a type's output also runs that type's slow file, for
example `node --test tests/slow/micro-plant-promise.test.js`. Narrow a sweep this way, by
moving its seeds to the slow tier, only where the fast tier keeps a witness of the same
promise; do not narrow it by shrinking a grid or relaxing generation.

An access test routes from the portal stand nearest each target (`standNear` in
`tests/helpers/stands.js`), not from the region's first portal. A search ends at its
target, so the nearest stand costs a fraction of the first, and it proves the same thing:
the portal promise joins every portal's stands, and each builder's own sweep owns that.

`npm run test:micro` is the `micro` set with its browser members: the focused contracts and
seeded builder tests, four files at a time, then the four micro lab scripts. The unit files
also run in `npm test`. Until #808 the unit files ran one at a time, so that macro-size timing
witnesses did not compete; those durations are opt-in now (`BUILD_BUDGETS`, below) and the
depot's are counts. Four at a time took 57 s against 194 s one at a time, and the whole script
about 98 s against 235 s (2026-11-05). Contention was not the sole cause of the old timing misses: block's
delegation dispatch added about 1.4 s (54%) on the macro-block witness and 2.6% across eight
whole maps in the review comparison ([42.3](42.3-generation-and-delegation-evidence.md#block-delegation-dispatch-cost-604--535-2026-10-26)).
The labs are for a change to a lab, not to a builder
([Integration checks per set](#integration-checks-per-set)). `tests/micro-lab.browser.mjs` verifies region type content, control
variation, result download and movement, and saves `test-results/micro-lab.png`.
It also toggles each building view for `hut`, `compound` and `block`, checks the drawn
counts against the build in memory, and shows unmet guidance as a warning
([56](56-buildings.md) L4, L5).
`node tests/region-explorer.browser.mjs` checks the Region Builder Explorer's full builder
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

The builder contract (#540, `tests/helpers/builder-contract.js`) holds every registered region type to the
promises of a builder (20.9) over chain-like briefs (`tests/helpers/chain-briefs.js`),
which carry what a bare rectangle with portals lacks: cleared strips inside the owned
cells, concave and holed masks, many portals, hints and a playable area larger than the
owned cells (20.6). It runs from two fast files, split for the budget when rubble and plant
moved to a live cord (#759): `micro-builder-contract-cord` for rubble, park and plant, and
`micro-builder-contract` for every other type. A builder loop runs only its own type, in seconds:
`node --test --test-name-pattern=plant tests/micro-builder-contract*.test.js`.
`BUILDER_SEEDS=<n>` runs seeds 1 to n on each fixture instead of one, for a builder change
that moves a type's output; `BUILDER_SEEDS=20` took 67 to 70 s across all seventeen types.
The fast files run six fixtures of 224 to 660 cells at seed 1, plus nine of #490's plant
strip builds; `slow/micro-builder-contract-sweeps` runs every type at seed 2 (#807). Every
promise is checked per build, so the second seed repeats the same claims, and one seed keeps
the cell-order witness: with `createRegionMask`'s sort removed, eight types' contracts, depot and
park among them, fail on all six fixtures at seed 1. At two seeds the files had grown to 16.6 s and 10.6 s isolated; at one
they took 8.3 s and 5.6 s, and the slow file 14.4 s.

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
so it can be iterated on in seconds. `npm run test:browser` runs them all, one at a time,
and reports each with its time; a failure does not stop the scripts after it. It is the
union of the sets' browser members ([Test sets](#test-sets)).

`tests/browser.mjs` is the client's long regression, over the shipped content on its physics engine (#920). Its
fixtures place actors by assigning positions on the server's game, which the engine takes as a teleport between
ticks; checks that need fixed geometry stand on hand-built scene maps, served for their own seeds, because the
engine pins a map when its match is built. `tests/default-physics.browser.mjs` is the default room's core client
flow (lobby, start, walking, dropping an item); the `physics-*` scripts cover the physics client's other features. `tests/hearing.browser.mjs` runs a `content-8` room and draws an arranged heard-gunfire cue (#684). `tests/transit.browser.mjs` runs a `content-10` room, places the player's gladiator at a station and transits by clicking a minimap ring (#692).

`npm run test:times` times every unit test file alone, slowest first, and marks files over
budget (15 s fast tier, 60 s slow tier) with their slowest tests; `-- --strict` exits 1 on
any, and file paths limit it. With no paths it times every unit file of `npm run test:all`
and `npm run test:mapgen`: `tests/`, `map/macro/tests/` and the `slow/` directory of each,
where a file under `slow/` is slow tier. Browser scripts and opt-in size runs are not in it.
Run it when adding or growing a test file.

The slow tier as a whole has a budget as well: its `tests/slow/` files, each timed alone on the
development machine, total at most 900 s (Corey, 2026-11-05, #800 S5;
`npm run test:times -- tests/slow/*.test.js`). #821 took 353 s of larger-size map builds out and put 42 s of layered checks in,
and #822 narrowed each remaining file to the cheapest witness of its claims: re-measured as a whole on a quiet machine
on 2026-11-06, the 19 files total 235 s, the largest `micro-large-briefs` at 25 s. It was 871 s on 2026-11-05, and 870 s re-measured
that evening on a quiet machine. A run alongside other work read 990 s, with the larger
`map-library` files 10 to 15% slower (review 641 on #819), so the total is a duration and is
measured with nothing else heavy running (#815). At 870 s it was about 4 to 5 minutes of wall time at four
files at a time here, and 10 to 20 in CI at the 2.5 to 4 times above, inside the slow job's
35 minutes ([below](#continuous-integration)). A change that would take the total past it
cuts as much elsewhere or raises it with Corey. Splitting a file moves its time, not the total.
The fast tier has no whole-tier budget; its per-file budget and the cost statement below govern it.

A file over budget is
optimized (share a generated map across tests, build fewer rooms), split into files
that run in parallel, or has its largest cases gated behind an environment variable as
`room-sizes` does. The room harness shares maps for tests about room policy rather than
maps: `roomHarness({ reuseMaps: true })` gives every room its own copy of a map generated
once per file, with its own copy of the portal graph its bots plan by, as `room-directory`
does (#376: about 26 s to 3 s), and `h.room(seed)` opens one without starting it. A server
test whose seeds are only labels passes `generateMap: reusedMap`, which answers every seed,
random ones too, with seed 9's map (#806: the `rooms` set's files, timed alone, from 202 s
to 98 s). Files already over budget when this was added: `room-service`, `room-directory`,
`server`, `map-generator` and the slow `map-library` (all since fixed, the last by #807); they were the first
candidates, not a precedent.

<a id="test-cost"></a>

### A test's cost is part of the change

Every author waits on the fast tier, on every PR, and a decomposed task waits on it at every stage.
So adding a test, growing one or turning one on (removing a skip, changing a gate's default) brings
an obligation: show that you know what it costs that workflow (Corey, 2026-11-04, #795). The PR
body states, for each test file added or grown:

- **Its isolated time**, from `npm run test:times -- <file>`, and the new or grown cases' own times.
- **Its tier**, and what it adds there. The fast tier runs four files at a time, so a single file
  longer than about a quarter of the tier's wall time becomes its critical path whatever the total.
  CI's runner is slower than the development machine, about 2.5 to 4 times on 2026-11-04
  ([42.3](42.3-generation-and-delegation-evidence.md#verification-cost-checkpoints)): a minute
  here is several minutes on every PR's `verify`.
- **Why that scope.** Name the claim and why the scene it builds is the cheapest that shows it
  ([Test arenas](#test-arenas)). A rule about rooms, protocol or one builder does not generate a
  whole chain map unless that is the claim; it shares one (`reuseMaps`), uses an arena or a stored
  map. Sweeps over seeds and whole matches go to `tests/slow/` with a fast witness (above).

A reviewer treats a missing or implausible statement as a finding. The same obligation covers a
change that makes existing tests slower, such as a builder whose cost rises: the PR says which
test files moved and by how much, from `test:times` before and after.

A case that exists to catch a cost regression must fail when cost regresses, in the runs people
actually make. A duration that nobody prints is not a witness: the macro-sized depot case went
from about 2 s to about 460 s alone (about 20 minutes in CI) with #787's live cord, and the run
passed for two and a half days because its limit is opt-in (below). A new cost witness asserts a
deterministic count of work, as the paragraph after the table below says, rather than leaning on
`BUILD_BUDGETS`.

Notice bloat rather than add to it. When a run you are making is slower than the numbers here or in
42.3, or a file you touch is over budget, say so in the PR or file an issue; do not add cases to a
file already over budget without bringing it back under.

Placeholder values are not claims. Loot's spawn chance, tier gradient, density, supply and kind
weights are stand-ins (Corey, 2026-11-05,
[17.2.11](17.2.11-navigation-structure-direction.md#loot-placement-is-a-placeholder)): a test
may assert that some loot spawns where its mechanic needs a pickup, never a value or a band.
The loot-per-tile band the larger-size `map-library` files asserted predated this and retired with
them (#821).

Shared test helpers live in `tests/helpers/`. Use them rather than copying them:
`cells.js` (`cellsOf`, a rectangle's cells row by row), `chain-briefs.js` (`chainBrief`,
a brief with the margins the chain applies, `chainFixtures`, the masks the builder
contract runs, `reorderedBrief`), `block-masks.js`, the per-type `plant-fixtures.js`,
`depot-fixtures.js` and `compound-fixtures.js` (a type's briefs, masks and seeds, which its fast and
slow files share), `map-library-game.js` (the game-size library map's checks, which the `map-library`
files and `map-tools` share), `stands.js` (`standNear`), `listen.js`, `browser.js`
(`serveWithBrowser`, a server and headless Chrome for the browser scripts), `args.js`
(the bench and demo `--key=value` map), `room-harness.js` (rooms on the shipped content and its
physics engine; a match is built asynchronously, so `room()`, `live()` and `created()` wait for
`room.ready`, and a test that drives the directory itself awaits it, #920), `room-sizes.js`
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
repeat a suspected regression three times before believing it. Other agents share this
machine and their load comes and goes, so compare two versions in alternated pairs (A, B, A,
B…) rather than in blocks, and judge the change by each pair's ratio. Report process CPU time
(`process.cpuUsage()`) beside wall time where a tool can. Neither is steady here alone: on
#868, three runs of the same 36-wide `generate` read 152 to 217 s of CPU and 122 to 177 s of
wall time, while each pair's ratio stayed within 0.69 to 0.80. CPU time also counts V8's
helper threads and any worker, so it measures a worker benchmark's total work, not its
latency. Latency claims, such as a player's wait or a tick budget, stay on wall time, on a
quiet machine. Do not claim the
reported slowdown fixed without a captured slow run; see
[42](42-performance-history.md).

The hut's 172 by 172, 228-portal fixture builds its full geometry in the normal suite,
including yard delegation and receiving-cover construction; the measured cost compared
with house-only generation is recorded in [42](42-performance-history.md). The file
remains subject to the strict 15-second isolated budget.

**Build durations are measured on request, not asserted by default** (#548, which
supersedes #567's `CI` skip). The macro-sized cases build one region with hundreds of
portals and check what it holds: the cover, compound, hut and plant cases in
`tests/micro-*.test.js`, and the slow `micro-block-scale` and `micro-depot-scale`. Those assertions are the
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
node --test --test-concurrency=1 --test-name-pattern=macro-sized tests/micro-cover.test.js tests/micro-compound.test.js tests/micro-plant.test.js tests/micro-hut.test.js tests/slow/micro-block-scale.test.js tests/slow/micro-depot-scale.test.js
Remove-Item Env:BUILD_BUDGETS
```

On a POSIX shell, put `BUILD_BUDGETS=report` before `node`. Add one file to the list to
time just that builder; the pattern selects the macro-sized case alone, which separates
builder cost from the rest of the file and from suite contention. `enforce` is for a quiet
machine and one file at a time, with no other agent's tests or benchmarks running: the
limits (cover 2 s, compound and plant 3 s, block 5 s, hut 8 s, depot 12 s) are ceilings that catch a builder
turning quadratic, set above that machine's isolated readings, and are not capacity
promises. They sit 1.4 to 7 times above the readings, the block's 5 s the closest, so a loaded or
slower machine can fail one without a regression; repeat before believing it. CI does not
set the variable. A threshold that should gate every run belongs in a deterministic
count (work, portals visited, pieces placed), not a duration.

The opt-in duration hid a regression: after #787's live cord the depot's macro case (170
portals) took about 460 s alone and 20 minutes in CI, against 2 s before, and no run reported
it (#790). Its witness had outgrown fixed point limits, so every later commit failed as
`budget` and split into more whole-region proofs (#801). Now every run bounds the cord searches
and meshes of a 125 × 94 depot with 104 portals through `cordWork`, a process-wide count in
`map/micro/cord-witness.ts` (4 each; 98 meshes under the old limit, so the fast tier fails if a
limit is set too low again), and the slow `micro-depot-scale` bounds the same for the macro case
(4 each, about 6 s). That is the pattern for the other macro cases: a count every
run catches what a duration nobody prints does not.

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
the same density for sizes the protocol does not serve. It takes the same lock.
`--maps-cache=<file>` reuses the production-worker geometry/navigation cache from
`room-startup.mjs` for sequential comparisons (use a fresh cache after generation/content changes).
The result's `run` records wall and process CPU milliseconds over the loop and inter-tick drains,
including worker CPU; per-tick timings still exclude those drains. Method and the
first results are [42.22](42.22-tick-cost-attribution.md) (#637). `--heap-profile=<file>` samples
allocations over the measured ticks (`--heap-interval=<bytes>`, default 32768), including objects already
collected, and writes a `.heapprofile` that DevTools opens. It also prints the top allocators, by function and by
the nearest frame in the repository's own code. A profiled run's times are slower and are not comparable with an
unprofiled run's (#727).

`node tools/perf/recording-compare.mjs --baseline=<archived-writer-module>
--maps-cache=<file> --out=<json>` compares a whole match's complete gzip archive
and metadata between an archived writer and the current writer (#728). It also
checks the retained-frame digest against ordinary JSON serialization and refuses
any omitted frame. It takes the lock, drains both writers between frames and
shares one authoritative simulation; it is byte-compatibility evidence, not a
timing comparison. Preserve the baseline revision and cache provenance with its
report. Simulation/view equality is separately checked by `frame-hashes.mjs`.

`node tools/perf/recording-payload.mjs --maps-cache=<file> --tile=2x2
--ticks=1200 --out=<json>` is a recording-only scaling probe when tiled geometry
exceeds physics admission limits. It records stable tiled item/gate lists and a
changing tick, without advancing a tiled simulation. `--baseline=<archived-writer-module>`
selects a comparison writer. It takes the lock and reports append latency and
run wall/CPU time, including draining, separately. Its results are not server
tick or capacity measurements.

`node tools/perf/room-startup.mjs --size=12x6 --out=test-results/startup.json`
is the short startup diagnostic for #842 (also accepts `--size=36x18` and
`--seed`). It takes the benchmark lock, prepares two maps through the production
map worker before timing, and runs the real room service and scheduler with one
dev viewer per room and replay compression to a discard stream. After a cold
room's first tick, that room runs for one second before a second room is
constructed and started; both run for another 1.5 seconds. Construction/readiness,
start, the cold first tick, timer delays, delivery gaps and host wake work are
reported separately. Raw wakes and profiler stages accompany `--out`.
Recorder drops or lifecycle errors fail the diagnostic. The default uses direct
fake-peer delivery callbacks. Add `--sockets --viewers=9` for real loopback
WebSocket delivery and nine dev viewers per room, joined sequentially. Socket
clients parse their welcomes and frames on a separate worker, and the delivery
series then measures the first active viewer's parsed state receipt times.
Joins wait for the welcome, and starts wait for the initial state; server phases
and host wake measurements remain separate from these end-to-end waits. The
result includes lifecycle wall and process CPU time through replay drain and
transport teardown, excluding map preparation and transport setup. Process CPU
includes recorder workers and, in socket mode, the client worker.

`--root=PATH` selects an archived source tree's server modules plus its matching
navigation-cache and profiler instances. The harness and cached source maps stay
common, so alternate revisions adopt identical prebuilt navigation rather than
accidentally rebuilding it in only one version. Archive `server/`, `shared/`,
`map/` and `package.json` beneath the worktree (for dependency resolution).
No production disk throughput, remote network or worker map delivery/adoption
while live rooms run is measured. The short sample's
p99.9 is effectively its maximum; delivery gaps over 50 ms include normal cadence
jitter. This locates blocking work, not capacity or closure evidence for #635.
`--maps-cache=FILE` saves the two worker-prepared maps with their navigation and
tile data, or restores them on another run. Use a fresh path after generator or
content changes; the cache checks seed, size and content id, not source hashes.
`--profile=PREFIX` writes separate CPU profiles for the concurrent preparation,
join and start phases after map generation. Inspector start/stop and profile
writing also block the event loop, so profiled timings and delivery gaps are
diagnostic only and must not be compared with unprofiled runs.
`tools/perf/frame-hashes.mjs` also accepts this cache, for example
`--size=36x18 --contents=content-6 --seeds=4217 --views --maps-cache=FILE`.
It restores the worker's navigation data, then hashes a whole match and every
player/spectator projection as usual. Cache seed, size and content must match.
`--payloads` additionally exercises recording/live/delayed map payload queries
and hashes their JSON at tick 0, 600, 1200 and the end. It requests the recording
map before the first snapshot, as startup does. `--root=PATH` selects the archived
match and matching navigation-cache modules for exact before/after comparisons.

`node tests/measure-changes.mjs` (`--size`, `--content`, `--seed`, `--ticks`, `--out`) counts how much
of each published frame differs from the previous tick's, per collection and by entity id. It times
nothing, so it needs no lock and runs in parallel. Results are in
[42.22](42.22-tick-cost-attribution.md#change-fraction-per-tick-655) (#655).

<a id="test-sets"></a>

## Test sets

Every test file belongs to exactly one set, named for what it validates (#800). `tests/sets.mjs`
holds the catalog: each set's fast, slow and browser members, and the source paths whose change
should prompt it. `tests/sets.test.js` fails when a file is in no set or two, or when a member
names no file, so a new test file names its set in the same change. A browser script is found by
its name (`*.browser.mjs` or `.mts` in `tests/` or `map/tools/tests/`, and `tests/browser.mjs`), so a
new one there cannot escape the catalog either; a browser script in another directory needs
that directory added to `BROWSER_DIRS`.

| Set | Validates |
| --- | --- |
| `tooling` | the test and CI tooling, documentation and licence checks |
| `geometry` | shapes, clipping, math and free-space meshes every system shares |
| `client` | what the browser draws, and how it presents and buffers frames |
| `simulation` | game rules, items, bots, navigation, sight and projections, the legacy generator |
| `physics` | the Rapier engine, its items, hook, ballistics and physical navigation |
| `rooms` | the server: rooms, matchmaking, recording and replay, the map pool, live-map wiring |
| `macro` | macro generation, the chain and its library, map tools and the Map Lab |
| `micro` | region builders and their machinery, and the micro labs |

```powershell
npm run brief -- test:set physics            # the set's fast files
npm run brief -- test:set micro:depot        # the micro files whose name holds "depot"
npm run brief -- test:set rooms --slow       # fast and slow files
npm run brief -- test:set physics --browser  # then its browser scripts, one at a time
node tests/sets.mjs browser micro           # browser scripts alone: these sets' (or set:word), or every set's with none named
node tests/sets.mjs list                     # sets, member counts and recorded time
node tests/sets.mjs changed                  # the sets whose sources this branch touched
```

A set is the inner loop's unit when no single file is narrow enough, and `changed` suggests which
sets a branch reaches. Sources overlap where code is shared (`map/kernel/` prompts `macro` and
`micro`), and a set's sources are where its own code lives, not everything it imports: through the
shared registries almost every file imports almost everything (a change under `shared/physics`
reaches 221 of the 246 fast files' imports on 2026-11-04), so selection by import graph would select the whole tier.
`npm test` stays the gate before a PR; sets make iterating cheaper, not the gate smaller.
`npm run test:physics` is the `physics` set, `npm run test:micro` the `micro` set with its browser
members, and `npm run test:browser` every set's browser members (`node tests/sets.mjs browser`).
Browser scripts run one at a time, each reported `ok` or `FAIL` with its time, and a failure stops
none of the rest; the run closes with the count and the failed scripts. Each selection's unit tests
keep their own timing record (`test-results/test-times/set-<names>.json`); browser scripts are not
recorded, so their times are in [Integration checks per set](#integration-checks-per-set).

## Choosing checks by changed area

A check is worth running when something the change touched can move what it asserts.
The gates above are the whole set, not a default: `npm run test:all`, the sweep, the
browser scripts and the benchmarks are chosen by the area changed, because a slow file
the change cannot move adds minutes and no evidence (#542). "The map was touched" or
"it shows in the browser" is not a reason by itself (Corey, 2026-11-04, #808). Three tiers:

| Tier | When | Runs |
| --- | --- | --- |
| Inner loop | every edit | The narrowest check that fails when the edit is wrong: a test file, a `--test-name-pattern`, a set or `set:word` ([Test sets](#test-sets)), or a replay. Seconds |
| Before the PR | once | What CI's `verify` runs ([below](#continuous-integration)): `npm run check`, `npm run typecheck`, `npm test`, and for a change under `map/macro/` also `npm run test:mapgen`, run from the repository root; plus the area's extras |
| Integration | once per PR, where the area can move it | The members of [Integration checks per set](#integration-checks-per-set) the change can move, and no others |

| Changed area | Inner loop | Integration | Alone, 2026-11-05 |
| --- | --- | --- | --- |
| One region type's builder, behaviour-preserving | the type's files (`npm run brief -- test:set micro:plant`); its builder-contract row (`node --test --test-name-pattern=plant tests/micro-builder-contract*.test.js`) | the type's slow files; the full chain sweep once, no drift. While iterating, `sweep --check FILE --type <type>` (adding `block` for a type block delegates to) is the inner loop (below) | the sweep 159 s, plus the type's own: hut 18 s (`micro-hut-sweeps` 5 s, replays of hut and block 13 s); plant 22 s; depot 34 s; park 70 s |
| One region type's builder, content change | the same | the type's slow files; the type's replay to see what moved; then the full chain sweep, recaptured last (53), and `validate --diagnose true` on the maps it names; `micro-large-briefs` | about 3 min: the sweep 159 s and `micro-large-briefs` 25 s, plus the type's own |
| Builder machinery shared by several types (`scatter`, cover execution, the live cord, `map/kernel/`) | the builder contract (`test:set micro:builder-contract`) | every builder's slow files the change reaches; the full chain sweep, no drift unless declared | sweep 159 s; the micro slow files together 128 s |
| A micro lab page (`public/micro-lab*`, `decomposition-*`, `generation-demo*`), `region-examples`, `brief-link`, building drawing | the page's browser script | `npm run brief -- test:set micro --browser` (or `npm run test:micro`) | browser 41 s |
| Macro stages, the chain's authored library | `npm run test:mapgen` | the full chain sweep, which holds the larger sizes' macro too and refuses a defective map; `slow/map-library`'s diagnosis; for a content change the recapture, and `node tools/large-briefs.mjs --check`, recapturing with `--out` when it reports the stored briefs behind (tests/fixtures README). A behaviour-preserving change leaves `slow/map-library` to the slow tier on `main` (below) | 170 s, plus 90 s for the brief check; the sweep alone behaviour-preserving |
| Map tools (`map/tools/`), the Map Lab, the saved map format | `tests/map-tools.test.js`, `map-container` | the full chain sweep when the change reaches what it hashes (`mapViews`, the saved format); the Map Lab script for the lab or the format | lab script at least 131 s |
| The legacy generator (`shared/map/generate.ts`), which nothing live runs and #920 retires | the unit file | none since its sweep and map hashes went with the legacy mover (#920) | |
| Simulation rules, bots, snapshots and projections | `characterization-physics.test.js`; the unit file for the rule | `characterization-physics-bots` (31 s), `live-map`; the browser script of a feature whose presentation the change reaches (`hearing`, `transit`) | 31 s, plus `live-map` |
| Physics (`shared/physics/`) and the physics labs | `npm run test:physics` | `npm run brief -- test:set physics --slow --browser`; the frozen physics baselines, `npm run brief -- test:set simulation:characterization-physics --slow` (`shared/physics/` is a `simulation` source too, so `changed` names both sets) | 56 s beyond the fast set, plus 33 s |
| Rooms, recording and replay (`server/`) | the unit file for the rule; `test:set rooms` | `room-sizes`; `live-map` for the live adapter (`map/live*.ts`); `tests/browser.mjs` when the protocol or what a client is sent changes | 17 s, plus 20 s and 90 s |
| The client (`public/`) | the unit file; `test:set client` | `npm run brief -- test:set client --browser`; and the browser scripts of the flows the change reaches: `browser.mjs` (lobby, play, touch, replays, diagnostics), `default-physics`, `hearing`, `transit`, `physics-playback` and `physics-geometry` (physics drawing), `physics-prediction` | client set 56 s; all 22 scripts 378 s |
| Shared geometry and math (`test:set geometry`) | the unit file | the full chain sweep (shapes reach every builder); the physics Node/Chrome equality scripts (`physics-world`, `-hook`, `-hook-live`, `-navigation`, 8 s), since simulation math must be bit-equal in Chrome | 167 s |
| Tooling and docs | the unit file; `test:set tooling` | none; `npm run test:browser` when the browser runner changes | |

The replay needs its cache captured before the first edit (53). Whatever the area, a fixture is
never regenerated to make a check pass (below), and timing comparisons run sequentially.
`npm test`, the gate, is not repeated by a set; the before-the-PR gates stay as above.

<a id="the-replay-or-the-full-sweep"></a>

**The replay or the full sweep.** The replay is the inner loop and the full sweep is the
integration check: a builder change replays while it iterates and runs the full sweep once before
its PR (Corey, 2026-11-05, #800 S5). `sweep --check FILE --type <types>` rebuilds every cached
brief of those types with the current builders and compares each result's hash (53). A replay
with no drift means those types' regions are byte-identical on every sweep map, so the full sweep
should show no drift either; the once-per-PR sweep confirms it. The replay sees a change only
when its list holds every type whose builder reaches the change:

- a type's own builder: that type, plus `block` when block delegates to it (`cover`, `ruins`,
  `depot`, `compound`, `hut`). The block replay rebuilds its lots with the current builders:
  with depot's default density broken, `--type depot` drifted 363 of 366 regions and
  `--type block` 45 of 95 (2026-11-05). On today's corpus block plans 120 cover, 181 ruins,
  72 depot, 27 compound and 1 hut lot, so a hut change shows in block on at most one region;
- code several types share: every type that calls it. Replaying all seventeen types took 133 s
  against the full sweep's 159 s, so iterate on the full sweep instead: it also hashes macro's
  stages and the report.

The replay cannot see anything upstream of the briefs (macro, the library, a strategy's brief
making, the kernel, `shared/`), so those changes iterate on the full sweep too, and only the full
sweep recaptures for a content change. A replay that drifts on a change meant to preserve behaviour is a
stop-and-escalate, as a full sweep's drift is (53); on a declared content change the full sweep
is the check from then on. A hut break (`BOX` 4 to 5) drifted 1609 of 1833 hut regions in the replay and 222
of 224 maps in the full sweep; both caught it, and the replay named the regions.

<a id="integration-checks-per-set"></a>

### Integration checks per set

Each [test set](#test-sets)'s slow and browser members, what each catches that the set's fast
files can't, and which changes move it. Times are each member alone on the development machine,
one at a time with nothing else running (2026-11-05, #808); CI's runner is several times slower.
A member listed here is run when a change can move it, not because its set was touched.

**`tooling`, `geometry`**: no slow or browser members. Geometry's integration reach is through
the sweep and the physics equality scripts (the table above).

**`client`** (browser 56 s). The fast files test presentation state in Node; only these draw.

| Member | Alone | Catches that the fast tier can't | Moved by |
| --- | --- | --- | --- |
| `art-witness` | 8.1 s | the real arena renderer's pixels over six palettes, fog, roofs and LOD cutoffs; glass alpha; withheld entities stay undrawn | the renderer, appearance, palette, art assets |
| `overhead` | 25.0 s (its seam pixel check fails in some worktrees, #818) | real Phaser textures for overhead art: crown occlusion, group alpha without re-rasterising, texture release on cull and map swap | the renderer's overhead layer |
| `dev-view` | 23.0 s | a player tab, the dev tab it opens and what the dev tab does to the room | the dev view (client and server), room dev tools |

**`simulation`** (slow 52 s, browser 17 s)

| Member | Alone | Catches that the fast tier can't | Moved by |
| --- | --- | --- | --- |
| `characterization-physics-bots` | 31.2 s (2026-11-10) | the same for two whole `content-7` physics matches on the physics fixture's stored chain arenas, the private engine state included (#920); the fast tier has its scripted trace | physics rules, bots, the engine, snapshot and projection shapes; not generation |
| `view-live-map` | 20.8 s | roof, gate and item ids stay pinned on live maps 1 and 2, and their roofs are distinct and conceal (#343); moved from `view` (#849) | the live adapter, builders' element order, roofs |
| `hearing` (browser) | 10.1 s | a heard-gunfire cue reaches the player's frame and is drawn as a ring, an edge arrow and on the minimap | hearing, its projection, the HUD and minimap |
| `transit` (browser) | 6.6 s | a gladiator at a station sees its rings on the minimap and a click transits | transit, its projection, minimap input |

**`physics`** (slow 13 s, browser 43 s). Most browser members prove Chrome runs what Node runs.

| Member | Alone | Catches that the fast tier can't | Moved by |
| --- | --- | --- | --- |
| `physics-navigation` (slow) | 13.1 s | physical contestants complete a live-chain match, seed 4217 | physics, physical navigation, bots on physics; chain output only as a stall |
| `default-physics` (browser) | 7.0 s | the shipped default room's lobby, start, walking and item drop in Chrome | the client, physics content, room start |
| `physics-world`, `-hook`, `-hook-live`, `-navigation` | 2.0 to 2.2 s each | the production Rapier WASM bootstrap in Chrome, and Node and Chrome producing identical world, authoritative and projected frames | `shared/physics/`, the Rapier version, simulation math |
| `physics-prediction` | 4.2 s | the production prediction module replays pending input after a delayed correction | `public/physics-prediction*`, the motor |
| `physics-playback`, `physics-geometry` | 1.6 s, 12.2 s | physics drawn from a retained frame without an engine; display circles only in an authorized dev view | the renderer's physics drawing, the projection |
| `physics-ballistics`, `-jelly`, `-playtest` | 1.3 s, 2.2 s, 5.9 s | the physics labs replay their stored recordings and lay out without overflow | the labs (`public/dev/physics-lab*`), their report recordings |

**`rooms`** (slow 37 s, browser 90 s)

| Member | Alone | Catches that the fast tier can't | Moved by |
| --- | --- | --- | --- |
| `live-map` (slow) | 19.9 s | bots on the shipped content and its engine fill all three extraction slots on two live chain maps; at the larger authored size macro states a room's recipe and the frame its briefs give is the room's size (the regions are not built, so no per-run test converts a composed 24 × 12 map; `micro-large-briefs` builds each type's extreme stored brief at that size, not these, #822) | the live adapter (`map/live.ts`), bots, simulation; chain output only as a stall or crash |
| `live-map-adapter` (slow) | 29.9 s | a room's match map is seed 1's chain map, the adapter is deterministic, and a content's roster sizes its sites (#849) | the live adapter, generation |
| `live-recipe` (slow) | 29.7 s | the Map Lab's live-recipe check: only a seed's own map is a room's, refusing an edited layout or result (#822, #849) | `map/live.ts`, generation |
| `map-generator` (slow) | 18.9 s | the map worker's answer is exactly the inline map, graph and packed tiles included, and each request gets its own seed's (#849) | the worker, the live adapter |
| `room-arena` (slow) | 8.9 s | the pregenerated room arena is still seed 9's live map and graph (#849) | anything that moves seed 9's live map: then recapture it |
| `room-sizes` (slow) | 21 s | a whole room on the shipped content through the server loop: every tick recorded once in order, the sparse replay timeline, the recording's physics version and the map within ground capacity | rooms, recording, the replay timeline, item capacity; size-dependent generation under `ROOM_SIZES` |
| `browser` (browser) | 90.2 s | the client's long regression over shipped rooms: lobby, joining, play, touch controls, the minimap, spectating, replays and diagnostics downloads, its sections sharing pages and rooms | the client, the protocol, the room service |

**`macro`** (slow 33 s, browser at least 131 s; and the chain sweep, 159 s)

| Member | Alone | Catches that the fast tier can't | Moved by |
| --- | --- | --- | --- |
| chain sweep (`sweep --check`) | 159 s | any moved hash over 224 maps and the larger sizes' 4 macro layers, naming the stage, and any map whose report has defects (refused when checking or capturing, #822); `npm test` pins only the playground quick cases (`slow/map-chain-sweep` the game one) | anything upstream of the built map: macro, the library, strategies, builders, the kernel, `shared/` |
| `map-library` | 11.3 s | one 8-contestant map's full diagnosis: every region's portal promise under the thorough search, open ones too | macro, the library, builders: as a defect |
| `map-chain-sweep` | 18.6 s | the game quick case's hashes, and its macro views from `generateMacro`; the fast `map-sweep` pins the playground cases (#849) | as the sweep |
| `map-container` | 24.7 s | a game map round-trips whole and from its Layout alone with the game's engines, and reports clean (#849) | macro, builders, saving |
| `map-sweep-replay` | 20.2 s | the brief replay's machinery on the quick cases: capture, drift, throws and refusals (#541, #849) | `sweep-briefs.mts`, builders |
| `map-lab-routes` | 22.4 s | both bodies' routes on a game map, and a built map's collision bounded by its regions' cells (#849) | `map/tools/routes.ts`, builders |
| `map-tools` | 10.2 s | the tools' default game map with the game's registry, its library witness and saves (#849) | `map/tools/`, builders |
| `portal-graph` (slow) | 22.6 s | on a live map every promised pair connects over the mesh, and the graph travels beside the map (#849) | the portal graph, the live adapter, builders |
| `map-macro-sizes` | 21.3 s (three runs, 21.0 to 21.6 s, 2026-11-06; 16.9 s when #826 added it) | the sweep's `macro-24x12` and `macro-36x18` cases on `main`, layout through briefs | macro, the library |
| `lab` (browser) | at least 131 s | the Map Lab in Chrome: its saves equal the core's, a save reads back the same map, drills rebuild equal | `map/tools/`, the lab, the saved format, and builder output it pins by name |

**`micro`** (slow 128 s, browser 41 s; and the replay, 3.5 to 35 s a type)

| Member | Alone | Catches that the fast tier can't | Moved by |
| --- | --- | --- | --- |
| `sweep --check --type` | 3.5 s (block) to 35 s (park); all types 133 s | each cached region of the type rebuilt and compared, with its portal check where it drifted | that type's builder and the builders it delegates to |
| `micro-builder-contract-sweeps` | 14.0 s | every type's builder contract at seed 2 | any builder |
| `micro-block-promise`, `micro-block-scale` | 13.6 s, 4.3 s | the block's promise on every seed; a macro-sized block's structure counts | the block builder and its delegation |
| `micro-compound-sweeps`, `-siting-solution` | 11.4, 9.1 s | compound's promise, ring and observer checks at every gate count on every mask at rotating seeds; rooms and court reachable by bodies; the stored authored quarter sites, builds and is reachable to its rooms, court and gate yards (its whole portal promise is not checked per run, as no 36 × 18 region's is since #821; `tools/compound-siting-solution-audit.mjs --after-brief=tests/fixtures/compound-340-inward-brief.json.gz` runs it on purpose, #822) | the compound builder and siting |
| `micro-depot-sweeps`, `micro-depot-scale` | 13.9 s, 6.0 s | depot's promise and aisle access over its seeds; the stored witnesses' reach; the macro case's cord counts | the depot builder, the live cord |
| `micro-large-briefs`, `-park` | 24.2 s, 39.2 s | the larger sizes' extreme briefs, for the 12 types they exceed 12 × 6 in (up to 87 portals, 11,484 cells), build and stay in their fill; park's brief alone takes about 40 s since #849, so it has its own file | any builder; macro only through a recapture |
| `micro-hut-sweeps` | 4.9 s | small houses at sixteen seeds | the hut builder |
| `micro-park-promise`, `micro-plant-promise` | 12.5 s, 15.3 s | park's promise, spacing and kinds on every mask and parameter set at rotating seeds, and its 36-portal case; plant's promise, spacing and kinds at every seed, and its forty #490 strips | that builder |
| `micro-lab`, `region-explorer`, `decomposition-lab`, `generation-demo` (browser) | 18.0, 8.0, 5.8, 8.7 s | the micro labs in Chrome: controls, imports, downloads, walking, building views | the lab pages, `region-examples`, `brief-link`, building drawing; not builder output (below) |

The micro labs compare what they show with a build in Node made by the same code, so a builder's
output is not what they check: with hut's box changed from 4 to 5, `micro-hut` failed and
`micro-lab`, `region-explorer` and `generation-demo` passed (2026-11-05). The Map Lab script, by
contrast, pins some builder output by name, so a content change can fail it (#816).
`npm run test:micro` is the `micro` set's fast files, four at a time, then these four scripts.

A builder or strategy change does not run `test:all`. `characterization-physics-bots`
never builds a chain map: its arenas are stored. `map-library`, `live-map`, `physics-navigation` and
`room-sizes` build one only to report its defects or play a match, so all they can see is a
defect, a crash or a stalled bot, which the sweep's `built` and `report` hashes and
`diagnoseBuiltMap` show first. The exceptions are the type's own slow files and `micro-large-briefs`:
the sweep builds only 12 × 6 games and smaller playgrounds (53), so that file alone builds what
the larger authored sizes hand a builder. It replaced `map-library-24` and `-36*`, which built
whole maps at 102 to 148 s each (#821).

**`slow/map-library` on a behaviour-preserving macro change** (Corey, 2026-11-05, #800 S5, for
the batch it held then). The author does not run it before the PR: with no drift the sweep shows
its 161 game-size maps byte-identical, report included. The slow tier runs it on `main` after
merge, and a failure there files an issue and is fixed forward. A content change, or any change
that drifts, still runs it. S5 was decided for the 25-map report batch, which was retired in
#822, an agent's call that Corey left to judgement: its seeds were not the sweep's, but the sweep
now refuses a defective map itself, and none of its 224 maps reported one.

A new slow or browser member adds its row to its set's table here in the same change, and a
member whose value is unclear is raised with Corey rather than dropped.

<a id="test-arenas"></a>

## Test arenas

A behaviour question is answered in the smallest scene that still shows it (#697). Choose, per test:

- **A hand-made arena** when the rule is about geometry, or behaviour in isolation: open ground, a corridor of
  regions, a scatter of crates.
- **A generated region** (a real region type in a small frame) when the test depends on what generation produces.
- **A whole live match** only when nothing smaller shows it. Live matches stay the integration check, for example
  `tools/navigation/hunter-report.mjs`; arenas do not replace them.
- **The pregenerated room arena** when a test needs a real live map but not a particular one: seed 9's live map
  and portal graph at 12 × 6, stored in `tests/fixtures/room-arena-9.v8.gz` by `tools/room-arena.mjs` (#849).
  `generatedMap(9)` in `tests/helpers/room-harness.js` reads it, so `reuseMaps` rooms and `createPhysicsMatch(9, …,
  generatedMap(9))` cost no generation. `tests/slow/room-arena.test.js` fails when it is no longer seed 9's map;
  recapture it in the change that moved the map.

`tests/helpers/arena.js` is the one builder for hand-made arenas. `arena()` returns a valid `GameMap` from
parameters: size and cell size; a playable area covering the whole map, because a map without one is a diamond
and points off its midline get pushed; an optional corridor of regions with one gap per wall and its portal graph;
crates scattered from a seed alone; and obstacles, gates, buildings, items, stations, chargers, entry and exit as
given. Presets such as `openField` are parameter sets of it. A new arena is a parameter set of the builder unless it
needs something the builder can't express, and its PR says what. Per-file scenes are folded into the builder rather
than kept alongside it. A generated-region option is not built yet: no first user needed one, so it waits for a
test that does.

`tests/helpers/scenario.js` stages a game on an arena: `stagePhysics` (the shipped content unless given)
places exactly the actors asked for, each a bot or scripted. `know` sets what a contestant knows,
`run` steps with events scripted per tick (a shot every N ticks, a door changing) and returns the tick a condition
first held, and `gunfight` is the first preset scenario. Reports import the same helpers
(`tools/navigation/gunfight-arena.mjs`).

No arena is selectable from the main interface: not in the lobby, the room protocol or the `?room=` flow. A lab
may adapt one where it helps (the Map Lab, the physics lab, micro-lab), opt-in and per lab. Arena tests keep the
per-file limits above; a cue cell's centre may be inside an obstacle, so check `canOccupy` where a test needs an
open point.

## Continuous integration

Forgejo Actions runs `.forgejo/workflows/ci.yml` in fresh `node:24.15.0` containers with
the npm that `packageManager` names, as two jobs on separate runner queues:

- **`verify`** (label `docker`) runs on every pull request and every push to `main`:
  `npm run check`, `npm run typecheck`, `npm test` (through `brief`, so the log gives each
  file's wall time and the slowest files) and `npm run test:mapgen`. It runs the whole fast
  tier on every pull request, not only the sets a branch reaches (Corey, 2026-11-05, #800 S5);
  a slow `verify` is answered by cutting the slowest fast-tier files' cost, not by narrowing it. It is the pull request's
  check. The runner is several times slower than the development machine (42.3, 2026-11-04).
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

The frozen characterization fixture is `behavior-physics-1.v8.gz` (#920 stage 1). It freezes what
`content-7` physics matches do on two stored chain arenas, read by
`characterization-physics.test.js` (a scripted trace, fast tier) and
`slow/characterization-physics-bots.test.js` (two whole bot matches). Its complete lineage, capture
commit, digests and reconstruction instructions belong to [the fixture README](../tests/fixtures/README.md).
It replaced `behavior-seat-1.json.gz`, which froze the legacy mover, when #920 retired that engine.

The traces run against **arenas stored in the fixture itself** (`createPhysicsGame(seed, map)` takes
the stored one) rather than against whatever generation currently emits. So a change to the chain's
library, placement or strategies never moves this fixture: those move the chain's own seed sweep,
`map/tools/fixtures/chain-baseline.json`, and `REGION_TYPES_VERSION`
([53](53-map-artifacts-and-tools.md)). Only simulation and projection changes (bot behaviour, state
added to a player, or a field added to a live projection) and a physics rules version move the traces.
Map diversity stays covered by `slow/live-map.test.js`, which routes bots to completion over generated
chain maps. The fixture records its content and rules version, and the fast test checks both first;
see [14](14-match-rules.md) for the content and [26](26-recording-contract.md) for the version decisions.

**Batching baseline-moving work.** The sweep is a drift diagnostic for any change that
touches the chain (about ten minutes, 42.37; a builder change iterates on the replay
first). A deliberate content change recaptures it once, last, and content changes land in
batches with one version bump each: see [Content changes](#content-changes-one-bump-per-batch)
below. A change that is meant to be behaviour-preserving never recaptures.

Never regenerate a fixture to make a refactor pass: a behaviour-preserving change
must reproduce it exactly. Regenerating is correct only for a deliberate content,
rules, recorded-state or wire-contract change that has been decided, and it restarts the evidence — the current
fixture proves nothing about code predating it. Separate intentional gameplay
changes, and the new expectations and version decision they require, from
behaviour-preserving extraction. `tests/fixtures/README.md` records provenance, how
to regenerate and how to audit.

`npm run check` recursively checks every module in the directories listed under
the verification tiers above: JavaScript is parsed as Node would load it, and
TypeScript is verified to erase cleanly, which is what Node does instead of parsing
it. `npm run typecheck` is the separate, stronger pass.

## Content changes: one bump per batch

Corey's rule (2026-11-01, #760), replacing the earlier integration-branch practice (#295). A
**content change** is one meant to change what the map chain generates by default, for any seed,
parameter or branch, whether or not the chain sweep (`map/tools/fixtures/chain-baseline.json`, 53)
covers the case it changes. It needs a `REGION_TYPES_VERSION` bump. Each bump
and recapture makes saved maps and pinned ids stale, so content changes collect into batches that
bump once. Content work happens on `main`, not on a standing branch.

**1. An experiment lands switched off.** New content goes behind a brief parameter (or a
strategy option) whose default leaves the output exactly as it is.
- The PR says "content experiment, off by default" and names the switch, as #649 did with park's
  `hedgeFronts`.
- `sweep --check` must show no drift. There is no version bump and no recapture.
- Measure it with the switch on (an audit tool and a 42.x record), and document the parameter
  as experimental in the type's 54.x entry.
- Add it to the open batch issue (step 4).

**2. One adoption PR per batch.** When Corey decides which experiments to adopt, one PR:
- turns each chosen switch on by default and deletes the path it replaces;
- updates the pins and tests that move with the new output;
- bumps `REGION_TYPES_VERSION` once, recaptures the sweep last (53, "Proving a change") and
  updates 53's version row and baseline provenance;
- records the result in the experiments' 42.x documents;
- **corridor re-check rule (#865):** when region content becomes more obstructive (an adoption batch that adds detours or dead ends), re-run `tools/navigation/corridor-report.mjs` and compare against [42.22](42.22-tick-cost-attribution.md)'s figures (median 1.002–1.015, worst 1.081). If the worst ratio grows materially, the upgrade path is lazily learned crossing lengths.
An experiment Corey doesn't adopt stays switched off, or is removed in its own PR, which needs
no bump.

**3. A change that can't be switched off joins a batch.** Some changes move output by their
nature: shared machinery, a builder's guarantee or a bug fix whose output change is
unavoidable (#759 moved rubble and plant off frozen routes this way). Don't merge one on its own.
- Prefer to fold it into the next adoption PR, as #765 did with #759.
- If it needs its own review first, stack it: open it as a review PR on a short-lived branch,
  and base the adoption PR on that branch. Bring newer `main` into a stacked branch by merging
  it in, not by rebasing, since the remote refuses force pushes. Only the adoption PR bumps and
  recaptures, and the review PR is never merged on its own. To land the stack:
  1. When the adoption PR is complete, retarget it to `main` (the agent in Forgejo, or Corey).
     It then holds the whole stack: the review PR's commits, the bump and the recapture.
  2. Its checks run against `main`; fix any failure there.
  3. Corey merges the adoption PR, and closes the review PR, whose commits are now on `main`.
  No commit that moves output without its bump reaches `main` on its own.
- A bug fix that can't wait goes in alone with its own bump; say why in the PR.

**4. A batch is one issue.** It lists each experiment or unavoidable change, its switch, its
measurement document and its status (measured, awaiting decision, adopted). The first agent
with something for a batch opens it if none is open; later ones add to it. Agents propose what
to adopt; Corey decides and says when to cut the batch.

**Checking which kind of change you have:** classify a change by what it is meant to do to the
default output, not by the sweep alone. The sweep covers a fixed corpus of seeds and parameters
(53), and the per-type replay only the briefs it caches, so a change to a seed, parameter or rare
branch outside them can pass both and still change how saved maps regenerate.
- A change meant to preserve behaviour, or an experiment switched off, needs a clean
  `sweep --check` before its PR. That is evidence for the covered corpus, not proof for every map;
  where a change could reach an uncovered case, add a focused test for that case too. A replay
  is the inner loop and does not stand in for it
  ([The replay or the full sweep](#the-replay-or-the-full-sweep)).
- A change that alters default output anywhere is a content change, even if the sweep shows no
  drift: it joins a batch (step 3).
- Drift in a change meant to preserve behaviour is a stop-and-escalate (53).

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
map replacement release overhead textures. `tests/art-witness.browser.mjs` drives
the arena renderer over a controlled map and frozen presentation state across all
six palettes, fog on/off, exterior/interior roof views, LOD cutoffs and a short
motion pass, checking WebGL glass alpha, rendered edges and withheld-entity privacy
and writing paired captures and a contact sheet under `test-results/art-witness/`
([41.2](41.2-art-direction-plan.md) step 1, #587). Both run in `test:browser`.

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
bots through all three extraction slots on seeds 1 and 9 on the shipped content and its engine (#822, #920; `physics-navigation` plays 4217's map), each bounded by
the match duration so a stalled match fails rather than hangs. Transit strategy
and macro library tests check hunter access, standing space, six separate owned
regions and longitudinal distribution. `tests/slow/room-sizes.test.js` runs a bot
match to its end in a room at each authored size (14), the owner disconnected and
an owner spectator keeping it from abandonment, checks each tick reaches the
recorder once and in order, and reads sparse frames back through the replay timeline; it
takes about 21 s at 12 × 6 (the larger sizes, last timed on the legacy mover, took about 1 min and
4.5 min at 24 × 12 and 36 × 18). Only 12 × 6 runs
by default, since the larger sizes rarely find what it misses; set `ROOM_SIZES` when a change
targets size-dependent generation, room limits or recording. These samples do not establish human balance or
exhaustive seed coverage.

The browser suite uses live-chain rooms for normal play, replay, mobile controls
and buildings. Its fixed-coordinate occlusion and projectile probes stand on a
small authored scene (#944). The projectile probe waits for the receive buffer to fill and fires
past its cover so the sampled projectile survives long enough to measure.

`npm run bench` measures a live-chain match on the physics engine, and `--content=<id>` runs another
shipped content set. Like a room, it adopts the tiles a map worker would build, untimed; `--cold` leaves bots to build them on their first plans (42.8). Client crowd fixtures use a central transit site when
there is no street graph, and the dense fixture uses a real building loot site.
