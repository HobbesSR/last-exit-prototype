# 42. Performance history

Durable findings from completed verification passes. The narrative of each pass
lives in its commits; only results that still constrain a decision are kept here.

Every number below was measured on one Windows machine with Node 24.15.0 and
installed headless Chrome, running benchmarks sequentially with no competing test
or benchmark process. They are not capacity promises, and browser, GPU and
operating-system scheduling effects sit outside these JavaScript phase timings.

## Completed checkpoints

| Checkpoint | What it established |
| --- | --- |
| `5dd7d61` | Historical pre-extraction gameplay checkpoint; its fixture was captured at `0cd204e` |
| `0cd204e` | Historical frozen `5dd7d61` fixture capture |
| `9fe2d94` | Historical `elements-1` map/content checkpoint |
| `aa833a6` | Historical split of generator hashes from stored simulation arenas |
| `95b7f1b` | Current `netcode-1` fixture checkpoint; see [31](31-verification.md) |
| `6f141d4`, `c2d35c0` | Simulation systems and ordered map generation extracted |
| `fa1e1b9` | Input and HUD controllers extracted |
| `93bc904`, `236f8a6` | Replay writer/archive, then match API, rooms, transport and timers |
| `1b9af8d` | Shutdown awaits outstanding archive finalization; close is idempotent |
| `039a4b6` | Explicit outbound field contracts |
| `5ff90bc` | Crowd benchmarks with AI/idle controls |
| `cd4e46c` | Inventory drag/drop (F-13) |
| `cacd6cb` | Recording failure isolation; see [26](26-recording-contract.md) |
| `c8eb85e` | `shared/` converted to TypeScript with no build step |

## Baselines

### Three-hunter content checkpoint (2026-09-18)

On the same Windows machine with Node 24.15.0, three sequential alternating
`content-1`/`content-2` runs used the current code and the `tests/bench.mjs`
workload: seed 4217, one room, one viewer, full bot match. The benchmark source
was evaluated with explicit `contentById` selection in `createGame`; no generator
or fixture was changed. Median tick mean/p95 was 1.082/3.282 ms with two hunters
and 1.172/3.362 ms with three. All six runs had zero ticks over 50 ms. The roughly
8.3% mean increase includes the added actor and changed match trajectory
(4,312 versus 4,232 ticks), so this is a content-workload comparison, not an
algorithm-only regression measurement.

The standard three-hunter `npm run bench` passed at 1.248 ms mean, 3.679 ms p95,
and zero over-budget ticks. `npm run bench:client`, measured separately in installed
headless Chrome at 1440 x 1000 while holding D from entry for 12 seconds, produced
59.9 fps, raw frame mean/p95 16.70/17.60 ms and mean state gap 50.0 ms. This entry
workload does not establish a fix for the reported crowded-scene slowdown or verify
three-hunter human balance.

### Historical extraction comparison

Default workload: seed 4217, one room, one viewer, a full bot match; client holds D
from entry for 12 seconds after warm-up at 1440 × 1000.

| Measure | Before extraction | After |
| --- | ---: | ---: |
| Server tick mean / p95 | 0.906 / 2.506 ms | 0.903 / 2.533 ms |
| Server tick mean / p95, three isolated repeats | 0.882 / 2.455 ms | 0.873 / 2.438 ms |
| Raw client frame mean / p95 | 16.667 / 17.600 ms | 16.667 / 17.400 ms |
| Authoritative packet gap mean | 50.006 ms | 50.003 ms |

No reproducible degradation across three alternating original/final pairs. Client
throughput stayed near 60 fps with zero server ticks over the 50 ms budget. The
residual JavaScript timing differences are inside run-to-run variation.

## The measured cost of explicit field privacy

Ten player views per tick, three alternating runs, medians:

| Ten-view workload | Baseline | With field contracts |
| --- | ---: | ---: |
| Complete tick mean | 1.064 ms | 1.183 ms |
| Combined projection mean | 0.145 ms | 0.255 ms |

About 0.11 ms of extra projection work from copying permitted nested fields, which
accounts for the 0.118 ms increase in tick mean: roughly 11% of this small workload,
or 0.24% of the 50 ms tick budget. This is an accepted cost for explicit privacy,
not an optimization claim. No snapshot cache was introduced to hide it, because
existing diagnostic callers can mutate frames.

## Crowd diagnostics

```powershell
node tests/bench-client.mjs --json --server-profile --location=crowded --actors=ai
node tests/bench-client.mjs --json --server-profile --location=crowded --actors=idle
node tests/bench-client.mjs --json --server-profile --location=offscreen --actors=ai
node tests/bench-client.mjs --json --server-profile --location=offscreen --actors=idle
```

| Workload, median of three runs | Simulation per tick | Raw client mean / p95 |
| --- | ---: | ---: |
| Nearby, AI | 7.051 ms | 16.667 / 17.600 ms |
| Nearby, idle | 0.170 ms | 16.667 / 17.500 ms |
| Initially off-screen, AI | 6.010 ms | 16.667 / 17.500 ms |
| Off-screen, idle | 0.193 ms | 16.667 / 17.500 ms |

AI decisions dominate measured server work — roughly 6–7 ms per tick against 0.2 ms
idle — and ray-edge test counts are substantial, while local client actor drawing is
small. That makes bot sight and geometry candidate filtering the next profiling
target, with focused profiles before optimizing.

Read the limitations before citing this table. These are benchmark-only
arrangements: a stationary observer at a central street node with nine other actors
nearby or 1200 units to the right, large shields preventing deaths, autonomous traps
removed. AI actors move away after placement, so this is not a fixed crowd or a
representative combat scenario. Server profiles accumulate per scheduler wake,
including idle wakes; the per-tick estimate divides `sim.step.mean` by
`sim.step.calls` over the same rolling window, and wake p95 is not tick p95. Timing
series retain at most 600 samples.

## The measured cost of route straightening

Straightening a grid route before a bot walks it (see [22](22-ownership.md)) costs
differently in different workloads, and the two point opposite ways. Both were measured
three times, sequentially, with `calls.canOccupy` as the primary figure: it is
deterministic for a fixed seed, while `sim.step` wall time bounced between 0.24 and
0.61 ms for identical work on this machine and would have supported either conclusion.

| Workload | `canOccupy` per tick | `sim.step` mean | `sim.step` p95 |
| --- | ---: | ---: | ---: |
| Full match, seed 4217, before | 225 | 0.28 ms | 1.10 ms |
| Full match, seed 4217, after | 454 | 0.37 ms | 1.42 ms |
| Nearby crowd, AI, before | 788 | 5.17 ms | 9.66 ms |
| Nearby crowd, AI, after | 699 | 4.91 ms | 7.89 ms |

In an ordinary match it roughly doubles collision queries: bots path across open terrain
over long distances, so each repath has real work to do and the routes are long. In the
crowd arrangement it is *cheaper* — eleven percent fewer collision queries and a clearly
better p95 — because a straightened route carries far fewer waypoints, and the
per-waypoint work downstream of it falls faster than the straightening costs.

The crowd figure is the one that speaks to the open report below, and it moves the right
way. That is not evidence the report is resolved: this is the same synthetic arrangement
that never reproduced it, with the same limitations recorded under Crowd diagnostics.

## Live chain-map checkpoint (2026-10-03)

Measured sequentially on Node 24.15.0 at `33618bd`, with no concurrent test or
benchmark work in this session. `node tests/bench.mjs --json` now generates the
live map; `--legacy --json` preserves the old generator for comparison. Both use
seed 4217, one room and one viewer, with normal combat, ending when the match ends.
Map generation is outside the timed tick loop. Three runs per map:

| Map | Ticks per run | Tick mean, median | Tick p95, median | Worst tick range | Ticks over 50 ms per run |
| --- | ---: | ---: | ---: | ---: | --- |
| Live chain | 2,440 | 3.229 ms | 9.812 ms | 50.003-51.100 ms | 2, 2, 1 |
| Legacy street | 4,232 | 1.121 ms | 3.286 ms | 27.359-30.622 ms | 0, 0, 0 |

The live content costs about 2.9 times as much per tick in this sample and has
occasional ticks just over budget. Different maps produce different paths,
encounters and match lengths, so this is a workload comparison, not an isolated
measurement of mask collision overhead. The median mean still uses about 6.5%
of the 50 ms budget; that does not guarantee acceptable cost with multiple rooms.

Client checks used headless Chrome at 1440 by 1000 for 12 seconds each. One run
per location; these are observations, not before/after regressions or a GPU claim.
The profiler retains at most 600 samples per series.

| Location | Rendered frames | Raw frame mean / p95 | Render JS mean / p95 | State gap mean / p95 |
| --- | ---: | ---: | ---: | ---: |
| Entry | 719 | 16.78 / 17.70 ms | 0.46 / 0.60 ms | 50.08 / 70.90 ms |
| Building interior (`--location=dense`) | 621 | 19.46 / 21.20 ms | 0.36 / 0.50 ms | 50.20 / 76.30 ms |
| Transit crowd, AI (`--location=crowded --actors=ai --server-profile`) | 700 | 16.91 / 18.70 ms | 0.30 / 0.40 ms | 49.99 / 67.00 ms |

The crowd fixture now anchors on a central authored transit site when no street
graph exists. AI actors move away; only one actor remained visible in the final
sample. This does not reproduce the user's sustained crowded-scene slowdown.
Local raw results are under `test-results/bench-{live,legacy}-{1,2,3}.json` and
`test-results/bench-client-{live,dense-live,crowd-live}.json`.

## Client draw cost on a real GPU (2026-10-04)

Measured in **headed** Chrome on this machine's GPU, at the viewport from the user's Sep 13
diagnostics capture (1996 by 969, device pixel ratio 1.925). Seed 4217, entry location, a bot
match with the player walking. Three 30-second runs per side, alternated and sequential. The
before side is `forgejo/main` at `4542b1b`; the after side rasterises static geometry into
cached tiles ([29](29-geometry-and-drawing.md)).

| Side | Frame interval mean / p95 | fps | Phaser render step mean | Our `update()` mean |
| --- | ---: | ---: | ---: | ---: |
| Before | 48.2–48.9 / 66.7 ms | 20.5–20.7 | 46.1–46.8 ms | 1.11–1.12 ms |
| After | 16.7 / 16.8 ms | 60.0 (vsync) | 3.86–3.95 ms | 1.44–1.47 ms |

Before the change, Phaser's step was nearly the whole frame, and a CPU profile put most of it in
Earcut and `batchFillPath`. Hiding layers one at a time at 1440 by 1000 confirmed the source:
roofs, shade and floor changed nothing, and hiding the static chunks took the step from 21 ms to
0.8 ms. The 5 visible chunks held 15,863 commands. The JavaScript profile had shown 0.45 ms
because `render.frame` stops before Phaser renders. That is why #180 read the cost as GPU raster;
`render.draw` now times that pass. After the change, `update()` grows by about 0.4 ms,
because tiles are rasterised inside it as they come into view; its worst frame was 12 ms. No
frame exceeded 17 ms on the after side.

The same probe, in a 40-second crowded AI arrangement and in a normal 40-second match, recorded no
frame over 100 ms on either side. A server tick bench across six seeds (4217, 1, 2, 3, 77, 1234)
had worst ticks of 45–82 ms, with `sim.repath` at most 8 ms. Neither reproduces the reported
freezes of one to several seconds. Diagnostics downloads now keep every frame over 250 ms for the
whole session (`timings.hitches`), so the next capture includes a freeze even if it happened
minutes before the download.

## Map generation at each authored size (2026-10-04)

Measured on Node 24.15.0 on `claude/s6-larger-libraries` (from `602de89`), with
the bundled library for each size (52, #171): 20 game seeds per size, run one
size after another with no concurrent test or benchmark work. Generation is
placement through region building, without the report.

| Zone size | Tiles | Set piece share, median (range) | Loot sites, median | Loot per tile, median | Generation, median (max) | WFC nodes, max / cap |
| --- | ---: | --- | ---: | ---: | --- | --- |
| 12 × 6 | 936 | 54.8% (53.1–57.5%) | 974 | 1.04 | 253 ms (444) | 424 / 10,000 |
| 24 × 12 | 3,744 | 52.1% (50.1–53.5%) | 3,987 | 1.07 | 1,314 ms (2,672) | 1,798 / 37,440 |
| 36 × 18 | 8,424 | 53.6% (52.3–54.9%) | 9,764 | 1.16 | 4,455 ms (5,669) | 3,760 / 84,240 |

Every map placed on its first attempt with no defects. The search cap is now
10 nodes a cell and never under 10,000 (`wfcIterationCap`), so 12 × 6 keeps
its 10,000. Before set pieces covered half the map, a 36 × 18 fill took about
6,800 nodes, near the old fixed cap.

The WFC solver used to keep a compatibility table per option. Every
pre-assigned set piece slot is its own option, so the tables grew with the
square of set piece slots, and a 36 × 18 placement ran out of a 4 GB heap.
Options of one kind now share an id and a table. The sweep baseline is
unchanged over 224 maps. The median 12 × 6 generation over the same 20 seeds
fell from 488 and 503 ms to 265 and 257 ms, two runs each. Live per-tick cost at the larger sizes is measured
below.

## Live matches at each authored size (2026-10-05)

Measured on Node 24.15.0 on `claude/lobby-params` (from `2a971cb`) once rooms
could be created at each authored size (#184, 14). Seed 4217, the default roster,
one room and one viewer; each size three times, one run after another with no
concurrent work. `npm run bench -- --size=24x12` and `npm run bench:client --
--size=24x12` take the size; the client benchmark now pins `seed=4217` because the
deploy dialog otherwise picks a random seed (#234).

Server, a bot-only match run to its end (`npm run bench`):

| Zone size | Ticks to the end | Mean tick | p95 tick (runs) | Over budget | Rooms inside 50 ms at p95 |
| --- | ---: | ---: | --- | ---: | ---: |
| 12 × 6 | 2,334 | 3.6–3.8 ms | 12.9–13.3 ms | 3–5 of 2,334 | 3 |
| 24 × 12 | 4,287 | 7.8–8.4 ms | 18.1–20.0 ms | 1 of 4,287 | 2 |
| 36 × 18 | 6,313 | 22.8–23.8 ms | 52.1–54.2 ms | 349–388 of 6,313 | 0 |

A 36 × 18 room alone exceeds the 50 ms tick budget at p95 and overruns on about
6% of ticks, so the server can't sustain 20 Hz there on this machine, and a
second room would compound it. A 24 × 12 room costs about twice a 12 × 6 one.
Matches also run longer (1.8 and 2.7 times the ticks of a 12 × 6 match), which
17.2.7 predicted for counts that don't grow with the map.

Client, in installed headless Chrome with the player walking right for 12 s
(`npm run bench:client`; render figures are means over the three runs):

| Zone size | Frame time p95 | `render.frame` | `render.draw` | State gap p95 | State size per frame |
| --- | --- | --- | --- | --- | ---: |
| 12 × 6 | 17.5 ms | 0.89 ms | 2.5 ms | 70–73 ms | 15 KiB |
| 24 × 12 | 17.5–17.6 ms | 1.98 ms | 1.4 ms | 66–74 ms | 47 KiB |
| 36 × 18 | 17.5–17.6 ms | 1.07 ms | 0.82 ms | 138–154 ms | 77 KiB |

Rendering holds 60 fps at every size; the minimap and camera cost is under
0.04 ms. What degrades is delivery: the state size grows about fivefold with
loot and the 36 × 18 state gap p95 reaches about three server ticks, which is
the server running behind, not the client. The draw figures vary by run position and were not isolated. One 36 × 18 client run in the first,
unseeded set exited with an uncaught exception that was not captured and did not
recur in five further runs; treat as unexplained.

Room creation blocked the server's main thread for the generation time (about 2 s
at 24 × 12 and 6 s at 36 × 18, #184). Since #253 the server generates on a worker
thread. Measured 2026-10-06 on the development machine, creating seed 77 rooms
through `POST /api/rooms` on an otherwise idle server: the event loop's longest
delay during the request was 21–33 ms at 36 × 18 and 16 ms at 12 × 6, where it had
been the whole generation. Generation itself is no faster: seed 77 at 36 × 18 took
about 28 s both on the worker and inline, far over the 6 s above, so generation
time varies widely by seed and that figure is not a bound. One worker serves the
process, so two large rooms created together wait in turn. Since #258 the request
answers at once and players wait in the room's lobby instead; driving seed 77 at
36 × 18 in a browser, the POST answered in 28 ms, the lobby was open under 1 s
later, and the match went live about 32 s after the request. The tick cost of a
36 × 18 room above is unchanged.

Since #266 the server keeps two maps ready per size on a second worker (17.4 #10).
Measured 2026-10-06 on the development machine, starting a server with the pool on:
it filled one map of each size first (12 × 6 at 0.7 s, 24 × 12 at 5.8 s, 36 × 18 at
17.3 s) and both of each at 37.6 s. A 36 × 18 room created after that answered in
15 ms with its match already built, and the pool began refilling that size. The
whole process heap was 36 MB with six maps held; a map's JSON is about 0.23 MB at
12 × 6, 0.79 MB at 24 × 12 and 1.96 MB at 36 × 18 (seed 12345).

## Retained overhead textures (#290)

Measured 2026-10-08 on Corey's Windows development machine in installed Chrome,
1440 by 1000 viewport, seed 4217, default entry workload walking right for 12 s.
Runs were sequential with no competing tests or benchmarks. Before and after each
used one headless run (`npm run bench:client`) and one headed run
(`node tests/bench-client.mjs --headed`).

| Mode | `render.draw` mean before / after | p95 before / after |
| --- | --- | --- |
| Headless | 2.245 / 0.438 ms | 2.700 / 0.700 ms |
| Headed | 2.526 / 0.498 ms | 3.800 / 0.900 ms |

Both versions held about 60 fps. Afterward, `render.tiles` mean was 0.105–0.108 ms;
its largest frame was 9.1–13.9 ms while building newly needed tiles. Roof art now
uses cached textured quads and tree crowns share cached overhead tiles; alpha
changes do not rasterise. These are short entry-path samples, not whole-map or
crowd measurements. `render.draw` times Phaser's CPU render pass, not GPU execution;
headless Chrome may use software GL. This does not resolve the reported slowdown.

## Hut yard-to-cover pilot (#330, 2026-10-10)

The before side loads `map/micro/strategies/hut.ts` from `3b54da0`, with unchanged
supporting builder modules from the checkout; the after side is the completed
`types-24` working tree. The reproducible audit command is
`node tools/hut-delegation-audit.mjs --seeds=20 --maps --diagnose --out=test-results/330-audit.json`.
It measures five direct hut shapes over the same 20 seeds per shape and generates
one full map per authored size. Direct build-time figures below are medians in
milliseconds; occupied cells and cover elements are means across their 20 seeds.
Offer counts are totals over those seeds.

| Direct hut shape | Build median before / after (ms) | Occupied cells mean before / after | Cover elements mean before / after | Offers / accepted / rejected |
| --- | ---: | ---: | ---: | ---: |
| Small 6 × 6 | 1.758 / 2.745 | 15 / 15 | 0 / 0 | 0 / 0 / 0 |
| Rectangle 24 × 18 | 5.075 / 16.464 | 23.55 / 29.05 | 0 / 3.8 | 21 / 21 / 0 |
| Concave yard 28 × 12 | 4.586 / 12.269 | 26 / 27.7 | 0 / 1.25 | 29 / 13 / 16 |
| L shape 12 × 12 | 5.348 / 6.425 | 20.7 / 20.7 | 0 / 0 | 0 / 0 / 0 |
| Ring 14 × 14 | 12.228 / 15.538 | 20 / 20.3 | 0 / 0.15 | 34 / 3 / 31 |

These cases show the intended fill gain in broad yards and little or no gain in
the small, L-shaped and ring samples. More offers do not ensure usable cover:
cover placement rejected most ring proposals and just over half the concave-yard
proposals. No depth or whole-region fallback occurred in these audit samples;
focused tests exercise both terminal outcomes. An independent uncached preparation
replay had medians of 6.634 ms for the rectangle, 4.522 ms for the concave yard,
and 3.627 ms for the ring. Its decisions matched production, but those times are
not the production cache's attributable cost.

Full-map generation was run once before and once after per size with the exact
seed shown. The after map was then diagnosed; diagnosis time is separate from
generation. Those single timings are descriptive samples, not evidence of a
speed improvement or regression.

| Size | Seed | Generation before / after (ms, one run each) | After diagnosis (s) | Valid; defects; broken promises | Hut offers / accepted / rejected |
| --- | --- | ---: | ---: | --- | ---: |
| 12 × 6 | `issue330-before-12x6` | 928.889 / 896.753 | 10.794 | yes; 0; 0 | 3 / 0 / 3 |
| 24 × 12 | `issue330-before-24x12` | 4,247.877 / 4,007.633 | 31.098 | yes; 0; 0 | 30 / 1 / 29 |
| 36 × 18 | `issue330-before-36x18` | 11,586.425 / 10,640.293 | 163.948 | yes; 0; 0 | 104 / 5 / 99 |

Across these maps, 6 of 137 offers were accepted, and most rejected offers had
no usable cover placement. No nested hut lots occurred in the three maps; a
focused nested test and standalone no-cover lots cover those cases, but this
map sample does not measure nested adoption. Preparation receiver checks were
invoked 3, 30 and 113 times at the three sizes, respectively. The 24 × 18
rectangular `hut` fill diagnostic used matching IDs `hut-1` through `hut-20`,
tier 1, loot chance 0.3 and portals at row 8. Both sides built all 20 and failed
none. Free-cell share changed from 0.936 to 0.924; free gaps per region from
3.35 to 5.4; the share of cells inside those gaps from 0.889 to 0.828; and the
largest gap from 312 to 288 cells. The direct CLI command was
`node tools/builder-fill.mjs --types=hut --seeds=20 --width=24 --height=18 --min=3 --json=1`.

Focused verification passed: 325 micro tests and three micro browser checks.
Strict isolated file timings were 7.4 seconds for `tests/micro-hut.test.js`,
3.0 for `tests/micro-hut-delegation.test.js`, 0.2 for
`tests/micro-analysis.test.js`, 0.9 for
`tests/micro-decomposition-tooling.test.js`, 0.5 for
`tests/micro-delegation.test.js`, 0.3 for `tests/micro-delegation-execute.test.js`,
and 0.6 for `tests/micro-delegation-snapshot.test.js`. The macro-sized hut case
in `tests/micro-hut.test.js`, isolated with its strict 2-second timing assertion,
completed in 1.658, 1.645 and 1.622 seconds across three final passes. The captured
Micro Lab view `test-results/micro-lab-hut-delegation.png` was visually inspected
and shows the realized house and delegated cover.

The unchanged 5-second macro-block assertion also passed three isolated runs
at 1.128, 1.125 and 1.055 seconds. It failed at 5.614 seconds when the whole
suite shared the machine with a sweep, so the final suite was run on its own.
That final run passed all 642 tests. Check, typecheck, the complete browser gate,
and both sequential default benchmarks passed. The default server benchmark's
tick p95 was 5.223 ms; the client entry run averaged 60 fps. These are current
samples, not paired performance comparisons. The recaptured 224-case baseline
has zero drift (53).

The baseline measurements are retained in `test-results/330-before.md`; full
audit detail is in `test-results/330-audit.json`, with the paired fill summaries
in `test-results/330-direct-final.json`. These focused shapes and three
diagnosed maps establish behavior and illustrate where cover is usable. They do
not prove a general speedup, nested uptake, or resolution of the reported
slowdown.


### PR #336 review response: macro-hut cost (2026-10-11)

The original PR omitted a real regression. The reviewer measured the unchanged
172 by 172 hut fixture at 280, 276 and 284 ms on house-only `3b54da0`, versus
1,620, 1,604 and 1,618 ms on `e6d0449`: a 5.8 times median increase. Gating the
existing 2-second assertion did not address that cost.

`node tools/hut-delegation-timing.mjs` now reproduces the exact fixture and
alternates three sequential house-only / reviewed / revised runs on Node
24.15.0, without other local test or benchmark work. The review cleanup removes
an already-protected receiver's duplicate copies, copies offer metadata without
recopying the cells it replaces, avoids copying the private retained brief
before margin inheritance copies it, and skips full-region set construction for
partial offers. It preserves eager independent public dispatch views. All three
reviewed/revised outputs deep-matched.

| Revision | Three build times (ms) | Median (ms) |
| --- | --- | ---: |
| House-only `3b54da0` | 459.876, 363.284, 316.084 | 363.284 |
| Reviewed `e6d0449` | 2,534.612, 2,375.509, 2,342.202 | 2,375.509 |
| Review cleanup | 2,120.356, 2,052.006, 2,461.893 | 2,120.356 |

The revised median is about 11% lower than the reviewed implementation in this
sample, but remains 5.8 times the house-only median. This is the measured cost of
the current full-yard pilot, not a claim that the regression has disappeared. The
fixture owns 29,584 cells and has 228 portals; it offers two lobes of 25 and
27,969 cells, accepting one. The near-whole-field child requires preparation,
margin and partition checks, receiving-cover evaluation, and isolated execution
records that the house-only builder never produced. Its aggressive yard
selection remains a product-review concern (20.7, 54).

The wall-clock assertion is now unconditional in the normal suite, with an
8-second budget for this larger workload. The normal parallel micro suite
measured 4.279 seconds; the full fast-plus-slow suite measured 6.726 seconds
and failed the first proposed 5-second budget. Eight seconds leaves roughly
1.3 seconds of scheduling headroom over that observed full-suite run.
This budget admits the measured pilot cost while continuing to detect growth
past it; it is not a capacity promise. The table preserves the timing evidence
in the PR; full output is retained locally in the gitignored
`test-results/336-hut-timing.json`. The frozen netcode fixture and deliberate
`types-24` chain baseline are not regenerated for these behavior-preserving
review fixes.


Review-response validation passed: check, typecheck, all 642 fast-plus-slow
tests with no skips, and the 325-test micro suite with all three browser
previews. The final full-suite macro-hut case took 6.622 seconds. Strict
isolated file timings were 7.2 seconds for `micro-hut`, 0.5 for delegation
preparation and 0.3 for execution, all below the 15-second file budget. The
existing 224-case `types-24` baseline check returned zero drift; it and the
frozen netcode fixture remain unchanged.

## Spectator and replay level of detail (#272, 2026-10-13)

Measured 2026-10-13 on Corey's Windows development machine in headless Chrome,
seed 4217, 3-second run framing the entire arena overview. Runs were sequential
with no competing tests or benchmarks. The reproducible audit command is
`node tests/bench-client.mjs --spectator --seconds=3`.

The before side loads `public/arena-scene.js` from `6737eed` (pre-LOD main); the after
side is this branch. Before level-of-detail and camera-centered viewport culling,
unfogged spectator and replay views rendered hundreds of static fixtures, doors,
energy gates, sensors, spider web spokes/legs, and item drop shadows/sinusoidal bobbing
across the entire map every frame, causing severe frame drops in headless Chrome.

| Metric | Before LOD (`6737eed`) | After LOD |
| --- | ---: | ---: |
| Frame rate | 5.7 fps (18 frames in 3.13 s) | 59.9 fps (181 frames in 3.02 s) |
| Frame time mean / p50 / p95 / max | 174.46 / 174.10 / 190.00 / 190.00 ms | 16.67 / 16.70 / 16.80 / 16.90 ms |
| `render.draw` mean / p50 / p95 / max | 168.841 / 168.200 / 184.400 / 184.400 ms | 0.871 / 0.800 / 1.400 / 2.200 ms |
| `render.frame` mean / p50 / p95 / max | 4.356 / 4.600 / 5.600 / 5.600 ms | 1.180 / 1.200 / 1.400 / 1.800 ms |
| `render.world` mean / p50 / p95 / max | 3.500 / 3.700 / 4.700 / 4.700 ms | 0.112 / 0.100 / 0.200 / 0.300 ms |

Sub-pixel text labels are hidden below `LOD_LABEL_ZOOM` (0.35); fixtures collapse into
fast outlines (open gates/doors) or bounding fills (closed gates/doors) below
`LOD_LOW_ZOOM` (0.2); spider traps cull web rings and roaming bodies independently;
and items collapse into flat boxes without drop shadows or sinusoidal animation.
`render.draw` times Phaser's CPU render pass, not GPU execution; headless Chrome may use
software GL. This addresses full-arena spectator and replay overhead, but does not
resolve the reported multi-actor slowdown during matches.

## Delegation adoption candidate review (#331, 2026-10-13)

The merged hut pilot's owning traces, snapshot tests, fill results and timing
account above were reviewed before selecting another builder. Its six accepted
offers out of 137 full-map offers, and its still-measured macro-hut cost, argue
for receiving checks and measured authorship rather than automatic gap filling.
The next bounded implementation issue is
[#338](http://localhost:3000/corey/astra_test/issues/338), compound exterior yards
to cover. This checkpoint adds diagnostic tooling and planning only.

Reproduce the candidate review with
`node tools/delegation-adoption-audit.mjs --seeds=20 --maps=1 --out=test-results/331-audit`.
The source checkpoint is `6737eedf4208b41fa052405b5aa8c7439a7ccbef`, `types-24`;
the audit is added in the #331 PR. Local measurements used Windows, Node
24.15.0 and an AMD Ryzen 9 5900X. The final audit ran without another local test
or benchmark. Its JSON and SVG previews are reproducible worktree artifacts,
not frozen fixtures. No generator version or baseline changes in this checkpoint.

Four shapes per builder use seeds 1–20, cell size 40, IDs `<type>-<seed>`, tier 1,
loot chance 0.3 and two west/east portals at row 8, length two. The concave
40×34 mask keeps `y < 20 || x < 20`. The 24×18 rows match the corresponding
`npm run fill -- --types=compound,depot --seeds=20 --width=24 --height=18 --min=3 --json=1`
diagnostic. Build times exclude fill/access diagnosis and are medians of one
build per seed, not repeated timing comparisons.

| Shape | Compound / depot build median (ms) | Compound / depot free-cell share | Compound exterior candidate cells, mean |
| --- | ---: | ---: | ---: |
| 17×16 | 1.781 / 2.942 | 0.709 / 0.839 | 0 |
| 24×18 | 2.172 / 2.786 | 0.728 / 0.858 | 0 |
| 40×34 field | 5.197 / 12.903 | 0.875 / 0.849 | 296 |
| 40×34 concave | 7.756 / 8.806 | 0.876 / 0.854 | 356.2 |

All 160 builds passed emitted-geometry portal reach and fill checks. Free cells
are not automatically surplus: compound's court and depot's aisles/density
choices are intentional. The compound diagnostic separately excludes its entire
building bounding box (including court), a two-cell surrounding band, and cells
within two cardinal steps of the ownership perimeter. This leaves measurable
exterior candidates in the large/concave cases but none in the small rectangles.
It does not extract reserved portal/gate routes or prove every candidate is
expendable. Depot has no corresponding spare-space classifier in this audit;
its exterior candidate value of zero means unmeasured, not no spare space.

Two explicit seed-1 rectangles were trialed independently through
`prepareDelegation`, with existing compound collision geometry passed as blockers
and `cover` required to emit usable content from its inherited interface:

- Field: `(2,2)`, 4×30, 120 cells; one offer, zero accepted, one rejected with
  `cover has no usable placement`. Ownership stays retained; no cover is added.
- Concave: `(27,2)`, 11×16, 176 cells; one offer accepted, no rejection, two cover
  elements. The 22×18 compound at `(3,2)` and its 15 rooms stay unchanged.
  Free cells decrease from 947 to 944. This is a small visible content gain,
  not evidence that most of the yard has been filled.

Both trial outputs passed original portal coverage, local crossing reach and
leaf fill checks against combined final collision geometry. Sampled hunter
routes also reached every room center, the court center and an exterior stand
at every chosen gate. Trial-and-diagnosis times were 590.474 ms (field rejection)
and 254.065 ms (concave acceptance); these include route checks and are not
production delegation overhead. Visually inspected previews show the unchanged
ring/court, rejected narrow field strip, two accepted exterior cover pieces and
depot's separate warehouse/container aisles. The SVG previews derive directly
from emitted collision shapes; they do not show roofs, loot or live movement.

The same three seeds used in #330 were generated at their authored sizes. The
audit checked only top-level compound/depot geometry, with zero portal/fill
errors across 15 compounds and 13 depots; this is not a whole-map diagnostic or
a nested block audit. Generation took 913.037 / 4,115.232 / 10,916.875 ms, one
run each; no performance change is inferred.

| Seed | Compound regions / with a ring | Compound owned cells | Exterior candidate cells | Largest exterior rectangle, cells |
| --- | ---: | ---: | ---: | ---: |
| `issue330-before-12x6` | 1 / 1 | 2,592 | 1,464 | 1,024 |
| `issue330-before-24x12` | 4 / 4 | 7,632 | 3,672 | 1,216 |
| `issue330-before-36x18` | 10 / 9 | 22,320 | 2,640 | 180 |

The authored-map evidence is concentrated. `compound@252,36` contributes all
1,464 candidate cells on the 12×6 map; `compound@336,276` (4,032 owned cells)
contributes 2,712 of 3,672 on the 24×12 map. Other ringed compounds leave either
240 candidate cells with no 3×3 rectangle, or 360 with a 9×20 west-side strip.
Such strips can still be needed by a west gate's approach beyond the diagnostic
two-cell band. #338 must report per-region offered, accepted and rejected
footprints/reasons before and after actual gate/portal route reservations,
alongside totals and final access checks. These candidate counts alone do not
establish adoption in ordinary-sized regions.

The unbuilt 11,232-cell `compound@336,342` in the last map contributes no exterior
candidate claim: without a ring there is no authored retained footprint to measure.
Its siting outcome is separately tracked by
[#340](http://localhost:3000/corey/astra_test/issues/340); portal count or shape
are possible causes, not a diagnosis. It must not become a full-region cover retry
or be absorbed into #338. #338 must separately exercise the
terminal empty behavior, actual production reservations, observer/snapshot
recovery, nested compounds, loot integration, before/after previews and versioned
content checkpoint. Compound is selected for its explicit capped building and
demonstrated compatible exterior witness; depot remains unselected until its
deliberate aisles and density omissions can be distinguished from unused ground.

## Compound exterior-yard adoption (#338, 2026-10-13)

The production policy and owning API are in [20.7](20.7-builder-delegation.md).
Before evidence was preserved from `ff9fd1b`, `types-24`, at
`test-results/331-audit`; after evidence is produced separately by
`node tools/compound-delegation-audit.mjs --seeds=20 --maps=1 --out=test-results/338-after`.
The final after report records source `2e89706`, `types-25`, with all builder
inputs committed. Its metadata lists only pending measurement documentation
and the previous baseline capture as tracked changes. The workload is the same four shapes, seeds 1–20, IDs, zones and portals as
#331 above, plus the same three authored-size maps. Windows, Node 24.15.0,
AMD Ryzen 9 5900X; timings below are single builds per seed and map, excluding
diagnosis and snapshot recovery. They describe added generation work, not a
performance fix or a controlled regression benchmark.

| Direct shape | Offers / accepted / rejected | Offered / accepted cells over 20 seeds | Before / after free-cell share | Before / after median build ms |
| --- | ---: | ---: | ---: | ---: |
| 17×16 | 0 / 0 / 0 | 0 / 0 | .709 / .709 | 1.744 / 5.000 |
| 24×18 | 0 / 0 / 0 | 0 / 0 | .728 / .728 | 2.117 / 8.634 |
| 40×34 field | 20 / 19 / 1 | 5,360 / 5,092 | .875 / .869 | 5.119 / 43.027 |
| 40×34 concave | 33 / 24 / 9 | 7,060 / 5,856 | .876 / .866 | 8.488 / 43.486 |

The direct concave seed-1 witness retains the original 17-piece ring (15 rooms,
two gates; its pre-adoption geometry hash is pinned in the focused test).
It offers two components totaling 336 of 1,080 cells. The 160-cell south lobe
is accepted; the 176-cell east rectangle from the diagnostic witness is
rejected because the production inherited cover brief yields no placement.
The accepted lobe adds two elements and three occupied cells (947 → 944 free).
Named patch identities and their inherited seeds differ from the earlier
explicit `exterior-witness` diagnostic. This distinction matters: a compatible
diagnostic rectangle does not guarantee production uptake. The court and
gate approaches remain authored empty space.

| Authored map | Diagnostic candidate cells / after protection | Offered cells | Accepted offers / cells | Rejected offers | Newly occupied cells |
| --- | ---: | ---: | ---: | ---: | ---: |
| `issue330-before-12x6` | 1,464 / 1,445 | 1,445 | 0 / 0 | 1 | 0 |
| `issue330-before-24x12` | 3,672 / 3,512 | 3,272 | 2 / 2,432 | 12 | 91 |
| `issue330-before-36x18` | 2,640 / 2,640 | 1,440 | 0 / 0 | 8 | 0 |

Uptake remains concentrated. `compound@336,276` (4,032 cells) offers 2,552
cells after 160 diagnostic cells are reserved for actual gate/portal routes.
Its two 1,216-cell side components are accepted, adding 56 cover elements.
Eight 15-cell fragments are rejected for incompatible crossings. Other
1,152-cell compounds offer two 180-cell strips each, also rejected for
crossing incompatibility. The 1,296-cell compounds retain their thin candidate
components without offers. On the 12×6 map, `compound@252,36` offers a single
1,445-cell component but retains it after crossing rejection. In total, these
15 top-level compounds offer 6,157 cells and accept 2,432 (two of 23 offers).
The accepted ownership is 60.3% of its one containing compound and 7.5% of
all top-level compound ownership across these maps. This is a sparse exterior
cover addition, not a claim that the yard is filled or broadly adopted.
Nine nested block compound lots on the 36×18 map build their rings and pass
final checks, but accept no exterior offers. The 11,232-cell compound remains
unbuilt; it now takes the required terminal empty path and drops its former
open-zone loot. Its siting investigation remains #340.

The audit exposed two access defects before this checkpoint. A crossing into
a thin inherited non-fill strip could be locally clear but unable to join the
retained hunter network. Declaring those inherited cells protected now rejects
that offer. Concave seed 18 could choose a widened south passage with a usable
off-center stand while its centered outer door had no actual yard stand.
Siting now tests the centered door's floor/ceiling whole-cell stands; ring
boxes stay unchanged across the audited direct cases, while invalid gate-side
choices can change. These are narrow access corrections, not an expanded
siting search or a diagnosis of #340.

All three whole-map reports have zero defects. All 80 direct cases, 15 top-level compounds and nine nested lots pass exact ownership partitions and final
containing and leaf fill/portal/crossing checks and sampled hunter routes to
every room center, court center and actual gate yard stand. Full and
omitted-result snapshots reproduce decisions, results and versions. Previews
show retained ring/court geometry and accepted/rejected exterior ownership;
free cells and rectangle counts are not proof of authorship. The small compounds
retain their original content. `npm run fill` on the preserved source and
adopter (20 seeds, compound only, 24×18 and 40×34) reports unchanged .728
free share for 24×18 and .875 → .869 for 40×34, with no failed builds.
Authored-map generation times were 1,346 / 5,060 / 12,433 ms after adoption,
versus 1,117 / 4,877 / 11,706 ms in the locally preserved before audit; these
single-run observations do not establish a timing regression.

The existing synthetic macro fixture is 200×150 cells, seed 3, 170 perimeter
portals and four gates. It offers 24,528 of 30,000 cells (81.8%) in two components,
but rejects both for incompatible crossings; all ownership stays retained.
This exposes the selection policy's limit on very broad synthetic yards even
though actual acceptance is conservative. Three sequential isolated runs of
`node --test --test-name-pattern=macro-sized tests/micro-compound.test.js`
took 199.5 / 189.5 / 199.9 ms before, versus 1,045.7 / 1,031.0 / 1,033.6 ms
after. A preliminary policy also offered twelve two-cell-wide circulation
slivers, took 1,791.5 / 1,805.2 / 1,818.3 ms in three isolated runs, and failed
the unchanged three-second assertion at 7,577 ms under full-suite contention.
Requiring a 3×3 yard pocket removes those slivers before preparation; this is
an authorship suitability screen, not a universal cover requirement. The
builder version advances from preliminary `compound-yard-1` to
`compound-yard-2`, so omitted historical snapshots refuse the changed policy.
Preparation still adds substantial work, even for rejected patches; this is
an acknowledged generation-cost increase. Each after run still satisfies the
unchanged three-second assertion. The complete fast compound, focused
delegation, slow access and mechanically updated rubble files take 9.2 / 5.5 /
10.0 / .3 seconds in isolated file timing, within their respective budgets.
Unit-suite file concurrency is bounded to four (31), retaining every assertion
while avoiding an unbounded mixture of fixture and whole-match work.
PR #342 review reproduced the contention failure on the final `compound-yard-2`
policy: `node --test tests/*.test.js tests/slow/*.test.js` completed in 136.0
seconds with 655/656 passing; its sole failure was the unchanged three-second
macro assertion at 4,182 ms. The earlier capped integration run passed all 656
in 197.7 seconds, with the macro fixture at 1,385 ms. The cap trades suite wall
time for bounded contention; it does not remove cases or relax timing assertions.
The capped fast suite after the shared gate-stand helper passes 642/642 in
111.5 seconds wall time, with the macro fixture at 1,589 ms (31).
The frozen netcode fixture is unchanged.

Follow-up [#344](http://localhost:3000/corey/astra_test/issues/344) investigates
cheaper rejection of incompatible crossings before complete preparation, with
the same ownership, access, deterministic decisions and snapshot contracts.

Sequential integration benchmarks also completed: `npm run bench` (seed 4217,
12×6, one room/viewer, 9,238 ticks) measured mean 2.706 ms and p95 5.202 ms
against a 50 ms tick budget, with one over-budget tick. `npm run bench:client`
at its default entry location measured 721 frames over 12.02 seconds, 60.0 fps,
16.80 ms p95 frame time and .600 ms p95 measured render work. These are bounded
simulation/default-view observations, not a reproduction or fix of the reported
crowd slowdown.

Final verification passes 656 fast/slow tests with the bounded file concurrency,
both browser labs (including stored-result equality for delegated compound),
the other browser checks and all three micro previews. The 224-case checkpoint
uses committed builder inputs `2e89706`; regeneration checks zero drift.

## The reported slowdown is still open

The user reports severe slowdown when many bots or players are nearby, including
off-screen. None of these short synthetic runs reproduced it. Off-screen culling and
navigation reuse are implemented, abandoned rooms retire, and smoothed frame deltas
were replaced with raw timing — none of which is evidence of a fix.

What would be: a real slow-run capture from Replays → Download performance
diagnostics, longer-lived matches, and runs on the affected device. Passing local
tests does not establish that this is fixed.
