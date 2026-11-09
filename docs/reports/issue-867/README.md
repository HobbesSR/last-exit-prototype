# Rooms on one loop at 36x18 (#867)

Owning measurement: [42.22](../../42.22-tick-cost-attribution.md), "Rooms on one loop (#867)".

Main at `a837cc0` (content-7, Node v24.15.0), 2026-11-09. One production-worker map cache for
36x18 seeds 4217 and 4218, built by `tools/perf/room-startup.mjs --maps-cache`. Its SHA-256 is in
`summary.json`. The cache is local and is not a fixture.

Six whole matches (10,233 ticks each) of
`node tests/bench-stages.mjs --size=36x18 --seed=4217 --rooms=<1|2> --clients=8 --spectators=1 --maps-cache=<cache>`,
alternating one room and two rooms, run sequentially under the benchmark lock with nothing else from
this session running. Every run kept every recorded frame. Two rooms use seeds 4217 and 4218 and
advance in lockstep from tick 1, which a live server does not do.

- `summary.json` has each run's tick statistics, over-50-ms ticks with their largest stages, wall
  and process CPU (including recording workers), GC, and top-level stage mean/p99/max. It also holds the
  single startup-diagnostic run and the tick-601 attribution.
- `timings.json.gz` has each run's per-tick totals, untimed residual and top-level stage series.

The tick-601 attribution came from a 640-tick seed-4218 one-room run under `--cpu-prof`. Its profile
was not retained, because the finding is restated in #908.
