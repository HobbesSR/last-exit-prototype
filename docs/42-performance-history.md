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

## The reported slowdown is still open

The user reports severe slowdown when many bots or players are nearby, including
off-screen. None of these short synthetic runs reproduced it. Off-screen culling and
navigation reuse are implemented, abandoned rooms retire, and smoothed frame deltas
were replaced with raw timing — none of which is evidence of a fix.

What would be: a real slow-run capture from Replays → Download performance
diagnostics, longer-lived matches, and runs on the affected device. Passing local
tests does not establish that this is fixed.
