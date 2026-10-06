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

Room creation blocks the server's main thread for the generation time (about 2 s
at 24 × 12 and 6 s at 36 × 18, #184) and has not been moved off it. The 36 × 18
choice is therefore available to play and measure live, but is not yet something to
offer on a server that hosts other rooms.

## The reported slowdown is still open

The user reports severe slowdown when many bots or players are nearby, including
off-screen. None of these short synthetic runs reproduced it. Off-screen culling and
navigation reuse are implemented, abandoned rooms retire, and smoothed frame deltas
were replaced with raw timing — none of which is evidence of a fix.

What would be: a real slow-run capture from Replays → Download performance
diagnostics, longer-lived matches, and runs on the affected device. Passing local
tests does not establish that this is fixed.
