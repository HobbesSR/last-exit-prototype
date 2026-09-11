# Server encapsulation verification — September 11, 2026

This pass starts at `fa1e1b9`, after the simulation/map/client extraction. The frozen
fixture still originates from unchanged `5dd7d61`; it was not regenerated. Simulation
version remains `last-exit-0.6`. No weapon, hunter-count, physics, map or trap balance
change is included. Requirements F-11 through F-18 are accepted, pending gameplay work.

## Checkpoints and tests

| Checkpoint | Unit/server/characterization | Syntax, browser, server/client benchmarks |
| --- | ---: | --- |
| Baseline `fa1e1b9` | 59 passed | Passed |
| Replay writer/store `93bc904` | 61 passed | Passed |
| Match/rooms/transport `236f8a6` | 67 passed, plus the new boundary test | Passed |
| Awaited shutdown `1b9af8d` | 73 passed | Passed |
| Field contracts `039a4b6` | 74 passed | Passed |

Browser coverage retains desktop and touch input, six inventory slots,
swap/merge/drop, doors/roof transitions, charging and extraction,
reconnects, spectator delay, replay seek/download, diagnostics, and isolated
input/HUD controllers. Unit/server cases include PvP, window collision/sight, hunter respawning, map placement,
private projections, accepted-input recording and archive integrity. Recursive
syntax checking includes every new server/shared/test module.

New focused tests cover detached match queries/commands; fake-time catch-up,
backpressure, matchmaking, abandonment and reconnect replacement; exact spectator
delay; replay JSON/hash and immutable accepted commands; real stream backpressure;
stream/publication failure; and shutdown ownership. Dependency tests prohibit
server application use of diagnostic `room.game`, transport access to simulation,
and room access to gzip/filesystem implementation details.

The shutdown defect was reproduced before fixing it: three new assertions failed
because shutdown completed before an already-started archive operation. The fix
tracks outstanding finalizations independently of retained rooms and makes close
idempotent. Slow and rejected publication now settle correctly. This is a separate
operational reliability correction, not a gameplay adjustment. Recording failure
policy during live play remains an unanswered product/operations question.

## Comparable timing

Raw measurements and environment are in `ENCAPSULATION_BENCHMARKS.json`. Runs were
sequential on the same Windows machine, Node 24.15.0 and installed headless Chrome
152.0.7977.83, viewport 1440 × 1000. No simultaneous test or benchmark process was
used. Local results are not capacity promises; browser/GPU and operating-system
scheduling effects remain outside these JavaScript phase timings.

| Default workload | Baseline | Final |
| --- | ---: | ---: |
| Complete server tick mean | 0.906 ms | 0.903 ms |
| Complete server tick p95 | 2.506 ms | 2.533 ms |
| Raw client frame mean | 16.667 ms | 16.667 ms |
| Raw client frame p95 | 17.600 ms | 17.400 ms |
| Mean authoritative packet gap | 50.006 ms | 50.003 ms |

The server workload uses seed 4217, one room, one player view and runs to completion.
The default client workload holds D from entry for 12 seconds after warmup.

Explicit field filtering does have a cost. Three alternating runs against an
isolated `fa1e1b9` checkout, with ten player views per tick, produced these medians:

| Ten-view workload | Baseline | Final |
| --- | ---: | ---: |
| Complete tick mean | 1.064 ms | 1.183 ms |
| Complete tick p95 | 2.749 ms | 2.843 ms |
| Combined projection mean | 0.145 ms | 0.255 ms |

The reproducible increase is approximately 0.11 ms of projection work from copying
permitted nested fields, closely accounting for the 0.118 ms increase in complete
tick mean. That is about 11% of this small baseline workload, or 0.24% of the 50 ms
tick budget. It is an accepted cost for explicit field privacy; it is not reported
as a performance improvement. No new snapshot cache was introduced to hide that
cost because existing diagnostic callers can mutate frames.

## Crowd diagnostics

Run each command three times sequentially for comparison:

```powershell
node tests/bench-client.mjs --json --server-profile --location=crowded --actors=ai
node tests/bench-client.mjs --json --server-profile --location=crowded --actors=idle
node tests/bench-client.mjs --json --server-profile --location=offscreen --actors=ai
node tests/bench-client.mjs --json --server-profile --location=offscreen --actors=idle
```

These benchmark-only arrangements put a stationary observer at a central street
node and nine other actors nearby or initially 1200 units to the right. Idle actors
retain identical initial placement and equipment. Large shields prevent deaths;
autonomous traps are removed to isolate actor work. Normal gameplay code and the
default benchmark remain unchanged. AI actors can move away after initial placement;
this is not a permanently fixed crowd or a representative combat-balance scenario.

| Workload, median of three runs | Simulation per tick | Raw client mean / p95 | Render JavaScript mean |
| --- | ---: | ---: | ---: |
| Nearby, AI | 7.051 ms | 16.667 / 17.600 ms | 0.566 ms |
| Nearby, idle | 0.170 ms | 16.667 / 17.500 ms | 0.557 ms |
| Initially off-screen, AI | 6.010 ms | 16.667 / 17.500 ms | 0.568 ms |
| Off-screen, idle | 0.193 ms | 16.667 / 17.500 ms | 0.552 ms |

Server profiles accumulate per scheduler wake, including idle wakes. The table's
simulation-per-tick estimate divides `sim.step.mean` by `sim.step.calls` over the
same rolling window; wake p95 values are not labeled tick p95. Raw client intervals
use actual frame timestamps. All timing series retain at most 600 samples.

At the end of all three idle samples the nearby case renders ten actors and the
off-screen case renders only the observer, although both receive ten actors. The
off-screen AI case ends with only the observer transmitted: other actors move beyond
the transmission radius. Nearby AI still receives ten but renders only the observer
at the end. Counts include the observer and are endpoint observations, not averages.

AI decisions dominate the measured server work; ray-edge test counts are substantial,
while local client actor drawing is small. This suggests examining bot sight/query
cost and geometry candidate filtering next, with focused profiles before optimizing.
It does not establish the reported slowdown's cause. None of these short synthetic
runs reproduced severe stuttering. A real slow-run diagnostic capture, longer-lived
matches and target-device runs remain necessary.

## Scope and handoff

The new owners are documented in ARCHITECTURE.md. ENCAPSULATION_PLAN.md records what
is complete, next boundaries for content/equipment, difficulty/traps and physics,
and batched release/deployment/replay/persistence questions. REQUIREMENTS.md preserves
the user's inline answers and latest gameplay additions. The prototype still has
two hunters and its existing controls/physics until the next gameplay checkpoint.

`room.game` remains a mutable diagnostic escape hatch, static welcome maps retain
the prototype visibility contract, and the profiler remains process-global. These
limits are explicit; this pass does not claim distributed isolation or production
anti-cheat. No gameplay defect fix was mixed into the extractions. `FRESH_SESSION.md`
is refreshed with earlier notes preserved and remains untracked. Commits are local;
no deployment or push was performed.
