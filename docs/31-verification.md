# 31. Verification

| Child | Load for |
| --- | --- |
| [31.1](31.1-test-catalogue.md) | What each test file and set checks: map generation and builder checks, shared helpers, integration checks per set, physics stage witnesses, coverage |
| [31.2](31.2-benchmarks-and-timing-tools.md) | The benchmark lock and the benchmark, profiling and comparison tools |

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
fixture, bots completing whole matches, and the builder sweeps ([31.1](31.1-test-catalogue.md)).
Their evidence only moves when generation or simulation moves; each set's share is in
[Integration checks per set](31.1-test-catalogue.md#integration-checks-per-set).
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

What the map generation and builder test files check, the promise sweeps' fast and slow split, and the builder contract are in [31.1](31.1-test-catalogue.md#map-generation-and-builder-checks). Narrow a sweep only by moving seeds to the slow tier where the fast tier keeps a witness of the same promise, never by shrinking a grid or relaxing generation.

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
engine pins a map when its match is built. `tests/default-room.browser.mjs` is the default room's core client
flow (lobby, start, walking, dropping an item); the `physics-*` scripts cover the physics client's other features. `tests/hearing.browser.mjs` runs a `content-8` room and draws an arranged heard-gunfire cue (#684). `tests/transit.browser.mjs` runs a `content-10` room, places the player's gladiator at a station and transits by clicking a minimap ring (#692).

`npm run test:times` times every unit test file alone, slowest first, and marks files over
budget (15 s fast tier, 60 s slow tier) with their slowest tests; `-- --strict` exits 1 on
any, and file paths limit it. With no paths it times every unit file of `npm run test:all`
and `npm run test:mapgen`: `tests/`, `map/macro/tests/` and the `slow/` directory of each,
where a file under `slow/` is slow tier. Browser scripts and opt-in size runs are not in it.
Run it when adding or growing a test file.

The slow tier as a whole has a budget as well: its `tests/slow/` files, each timed alone on the
development machine, total at most 900 s (Corey, 2026-11-05, #800 S5;
`npm run test:times -- tests/slow/*.test.js`). The total is a duration, measured with nothing else
heavy running (#815); dated totals are in
[42.3](42.3-generation-and-delegation-evidence.md#verification-cost-checkpoints). A change that would take the total past it
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

Shared test helpers live in `tests/helpers/`; use them rather than copying them. They are listed in [31.1](31.1-test-catalogue.md#shared-test-helpers). The maintained command-line tools share `tools/options.mjs`; the one-off audit scripts under `tools/` are evidence and keep their own parsing.

The timing command exits 1 when any test process fails, cannot launch, or terminates
by signal, even without `--strict`. It prints the failure reason and captured test output.
No gate runs `--strict`: the budgets are wall-clock times on a machine other agents'
worktrees share, so a strict gate would fail on contention rather than on the change
under review. It is
for checking the files a change adds or grows, run in isolation.

Run timing comparisons sequentially, with no competing tests or benchmarks (enforced
for cooperating runs by the shared/exclusive machine lock in
[31.2](31.2-benchmarks-and-timing-tools.md)), and
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

The benchmark lock and the benchmark, profiling and comparison tools (`npm run bench`, `bench:client`, `bench:stages`, `tools/perf/`, `measure-changes`) are described in [31.2](31.2-benchmarks-and-timing-tools.md). Benchmarks take a machine-wide lock, which serializes benchmarks only; treat an unexpected regression as possibly contended and repeat it before reporting it.

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
| `tooling` | the test and CI tooling, the `tools/` scripts, documentation and licence checks |
| `geometry` | shapes, clipping, math and free-space meshes every system shares |
| `client` | what the browser draws, and how it presents and buffers frames |
| `simulation` | game rules, items, bots, navigation, sight and projections |
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
recorded, so their times are in [Integration checks per set](31.1-test-catalogue.md#integration-checks-per-set).

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
| Integration | once per PR, where the area can move it | The members of [Integration checks per set](31.1-test-catalogue.md#integration-checks-per-set) the change can move, and no others |

| Changed area | Inner loop | Integration | Alone, 2026-11-05 |
| --- | --- | --- | --- |
| One region type's builder, behaviour-preserving | the type's files (`npm run brief -- test:set micro:plant`); its builder-contract row (`node --test --test-name-pattern=plant tests/micro-builder-contract*.test.js`) | the type's slow files; the full chain sweep once, no drift. While iterating, `sweep --check FILE --type <type>` (adding `block` for a type block delegates to) is the inner loop (below) | the sweep 159 s, plus the type's own: hut 18 s (`micro-hut-sweeps` 5 s, replays of hut and block 13 s); plant 22 s; depot 34 s; park 70 s |
| One region type's builder, content change | the same | the type's slow files; the type's replay to see what moved; then the full chain sweep, recaptured last (53), and `validate --diagnose true` on the maps it names; `micro-large-briefs` | about 3 min: the sweep 159 s and `micro-large-briefs` 25 s, plus the type's own |
| Builder machinery shared by several types (`scatter`, cover execution, the live cord, `map/kernel/`) | the builder contract (`test:set micro:builder-contract`) | every builder's slow files the change reaches; the full chain sweep, no drift unless declared | sweep 159 s; the micro slow files together 128 s |
| A micro lab page (`public/micro-lab*`, `decomposition-*`, `generation-demo*`), `region-examples`, `brief-link`, building drawing | the page's browser script | `npm run brief -- test:set micro --browser` (or `npm run test:micro`) | browser 41 s |
| Macro stages, the chain's authored library | `npm run test:mapgen` | the full chain sweep, which holds the larger sizes' macro too and refuses a defective map; `slow/map-library`'s diagnosis; for a content change the recapture, and `node tools/large-briefs.mjs --check`, recapturing with `--out` when it reports the stored briefs behind (tests/fixtures README). A behaviour-preserving change leaves `slow/map-library` to the slow tier on `main` (below) | 170 s, plus 90 s for the brief check; the sweep alone behaviour-preserving |
| Map tools (`map/tools/`), the Map Lab, the saved map format | `tests/map-tools.test.js`, `map-container` | the full chain sweep when the change reaches what it hashes (`mapViews`, the saved format); the Map Lab script for the lab or the format | lab script at least 131 s |
| Simulation rules, bots, snapshots and projections | `characterization-physics.test.js`; the unit file for the rule | `characterization-physics-bots` (31 s), `live-map`; the browser script of a feature whose presentation the change reaches (`hearing`, `transit`) | 31 s, plus `live-map` |
| Physics (`shared/physics/`) and the physics labs | `npm run test:physics` | `npm run brief -- test:set physics --slow --browser`; the frozen physics baselines, `npm run brief -- test:set simulation:characterization-physics --slow` (`shared/physics/` is a `simulation` source too, so `changed` names both sets) | 56 s beyond the fast set, plus 33 s |
| Rooms, recording and replay (`server/`) | the unit file for the rule; `test:set rooms` | `room-sizes`; `live-map` for the live adapter (`map/live*.ts`); `tests/browser.mjs` when the protocol or what a client is sent changes | 17 s, plus 20 s and 90 s |
| The client (`public/`) | the unit file; `test:set client` | `npm run brief -- test:set client --browser`; and the browser scripts of the flows the change reaches: `browser.mjs` (lobby, play, touch, replays, diagnostics), `default-room`, `hearing`, `transit`, `physics-playback` and `physics-geometry` (physics drawing), `physics-prediction` | client set 56 s; all 22 scripts 378 s |
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

Each set's slow and browser members, what each catches that its fast files cannot and which changes move it: [31.1](31.1-test-catalogue.md#integration-checks-per-set).

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
  `generatedMap(9)` in `tests/helpers/room-harness.js` reads it, so `reuseMaps` rooms and `createMatch(9, …,
  generatedMap(9))` cost no generation. `tests/slow/room-arena.test.js` fails when it is no longer seed 9's map;
  recapture it in the change that moved the map.

`tests/helpers/arena.js` is the one builder for hand-made arenas. `arena()` returns a valid `GameMap` from
parameters: size and cell size; a playable area covering the whole map, because a map without one is rejected (#985); an optional corridor of regions with one gap per wall and its portal graph;
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

Physics stage witnesses (P7 ballistics, P8 dynamic navigation, P9 integration and playtest) are listed in [31.1](31.1-test-catalogue.md#physics-stage-witnesses).

## The frozen fixture

The frozen characterization fixture is `behavior-physics-1.v8.gz` (#920 stage 1). It freezes what
`content-7` physics matches do on two stored chain arenas, read by
`characterization-physics.test.js` (a scripted trace, fast tier) and
`slow/characterization-physics-bots.test.js` (two whole bot matches). Its complete lineage, capture
commit, digests and reconstruction instructions belong to [the fixture README](../tests/fixtures/README.md).
It replaced `behavior-seat-1.json.gz`, which froze the legacy mover, when #920 retired that engine.

The traces run against **arenas stored in the fixture itself** (`createGame(seed, map)` takes
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

**Recaptures batch too.** A recapture restarts the evidence, so decided changes that would move this
fixture wait and land together, as content changes do (below). They collect in one open issue
titled "Physics recapture batch". It lists each change, its issue and whether it is decided. The
first agent with such a change opens it if none is open, and later ones add to it. Corey says when
to cut the batch. One PR then lands the changes, makes any version decisions they need (26) and
recaptures once, last. A change that cannot wait goes in alone, with its own recapture, and its PR
says why.

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
