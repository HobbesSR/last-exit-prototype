# Statics-only preparation step (#1087)

Owning measurement: [42.22](../../42.22-tick-cost-attribution.md#statics-only-preparation-step-1087).

2026-11-15, Node v24.15.0, content-7, `@dimforge/rapier2d-compat` 0.21.0. Base
`435c883` (main); branch `claudecode/1087-statics-step`. No fixture, content or
wire version changed.

## Workloads

- **Native attribution.** A scratch probe built one 36x18 match (seed 4218, a
  production-worker map) with `createMatch` and wrapped `stepNative` to read
  Rapier's own profiler (`RawPhysicsPipeline.timing_*`) per native step. It made
  three matches in turn in one process, so the first is cold and the next two
  show what a match costs once the process has run one. `nativeFirstSteps` in the
  summary holds both sides. Attribution only; not a comparison benchmark.
- **Startup pairs.** Four sequential alternating base/branch runs of
  `room-startup.mjs --size=36x18 --maps-cache=<cache> [--root=<base>]`, after one
  cache-building run that is excluded. One direct dev viewer per room, recording
  on, under the exclusive machine lock; every contention stamp is false. The
  issue asked for three pairs; the fourth was added to check a process CPU
  difference (below). Cache SHA-256 is in the summary.
- **Hashes.** `frame-hashes.mjs --views --payloads`: the standard 12x6 set (four
  contents, three seeds) and one whole 36x18 match (content-7, seed 4218, 10,634
  frames) from the probe's cached map. Base and branch printed byte-identical
  files; `hashes-12x6.txt` and `hashes-36x18.txt` are those files.

## Findings

1. **What the first step spends.** Cold process: the first native step took 62.8–66.2 ms
   wall, of which Rapier's timer saw 36–38 ms, mostly broad phase (24.8–25.1 ms
   over 33,268 colliders). The rest is outside Rapier's step, and nearly all of
   it disappears for the second match in the process, so it is first-use cost of
   the wasm code, not per-match work. Second and third matches: 22.0–22.9 ms, with
   broad phase 19.4–20.0 ms. Narrow phase, islands and solver are each under 2 ms.
2. **An API.** Rapier 0.21's JS bindings expose no broad-phase update or
   collision-detection-only call: `RawPhysicsPipeline` has only `step` and
   `stepWithEvents`, and `RawBroadPhase` only queries. The route taken is the
   issue's alternative, one native step while only statics exist.
3. **Equivalence.** Frame, all-view and map payload hashes identical for the
   12x6 set and the whole 36x18 match; `characterization-physics` and
   `characterization-physics-bots` pass against the frozen fixture unchanged.

With the step: the first gameplay native step is 5.4 ms cold and 2.2–2.4 ms
warm (broad phase about 2 ms). Tick 1 in the probe: 118 → 42 ms cold, 34–38 →
12–15 ms warm.

## Startup pairs

| Metric (pairs 1 / 2 / 3 / 4) | Base | Branch |
| --- | --- | --- |
| Cold tick 1, ms | 108.3 / 115.4 / 108.2 / 111.4 | 49.9 / 49.0 / 51.2 / 51.7 |
| Cold tick 1 `sim.solve`, ms | 69.9 / 72.3 / 69.3 / 73.2 | 8.0 / 7.9 / 8.0 / 9.2 |
| Steady `sim.solve` (ticks 201–400) mean / max, ms | 0.48–0.51 / 1.54–1.78 | 0.49–0.50 / 1.24–1.73 |
| `prepare.staticsStep`, ms | — | 59.9 / 58.9 / 57.2 / 58.2 |
| Cold make/ready wall, ms | 669.5 / 653.5 / 664.6 / 665.5 | 678.8 / 683.1 / 666.0 / 677.4 |
| Cold make/ready process CPU, ms | 1109 / 1218 / 1016 / 969 | 1672 / 1579 / 1688 / 1531 |
| Concurrent make/ready wall, ms | 1059.7 / 789.0 / 827.8 / 802.8 | 725.2 / 740.2 / 729.8 / 736.2 |
| Largest host wake gap, ms | 197.3 / 133.9 / 139.6 / 134.1 | 45.7 / 46.4 / 44.8 / 45.6 |
| Lifecycle wall / process CPU, s | 10.9/9.6, 10.4/8.7, 10.5/8.9, 10.5/10.3 | 10.4/11.0, 10.3/12.7, 10.3/10.6, 10.3/9.8 |
| Recorder drops (cold room, new room) | 10,1 / 10,1 / 11,1 / 10,1 | 9,1 / 9,1 / 8,0 / 9,0 |

Tick 1 `sim.solve` is now about 8 ms against a steady maximum of 1.2–1.8 ms
(about five times) and a steady mean of 0.5 ms. In the probe the remaining
first-step cost is mostly first use of the solver's code in a cold process (2.2
ms warm against 5.4 ms cold).

Make/ready wall time grows by about 0–30 ms although the step itself takes
57–60 ms of main-thread time, and its process CPU grows by about 450–700 ms. The
extra CPU is on other threads. That fits V8 compiling Rapier's wasm code in the
background once the statics step has run it, instead of during tick 1, but it
was not verified.

Whole-lifecycle process CPU is noisy: pairs 1–3 show more on the branch (the extra is
in the throughput-paced 400-tick window, in background-thread bursts), and pair 4 shows
less. A match-only probe over 400 ticks, with and without a recorder, showed no branch
excess (recorded: base 3.5/3.0 s, branch 2.6/3.2 s). It is reported here, not attributed.

Recorder drops are unchanged and fail recording health on both sides. On current
main the cold room also drops eight to eleven frames (#908's runs measured none for it); the
match-plus-recorder probe drops ten or eleven at its start on both sides. Which
commit changed that was not traced. #1088 owns the start drops.

## Retained files

- `summary.json.gz`: per-run startup figures (wall, CPU, stages, drops, contention),
  the map cache digest and the native first-step probe output for both sides.
- `hashes-12x6.txt`, `hashes-36x18.txt`: the identical base/branch hash files.
