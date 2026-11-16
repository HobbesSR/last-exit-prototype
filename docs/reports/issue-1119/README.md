# Room startup on threads (#1119)

Owning measurement: [42.22](../../42.22-tick-cost-attribution.md#room-startup-on-threads-1119).

2026-11-15, Node v24.15.0, content-7. Base `ced6be0` (main, with #1087, #1088 and
#1115); the harness change is `room-isolation.mjs --profile` on branch
`claudecode/1119-threaded-startup`. No server, fixture, content or wire change.

## Workloads

- **Profiled.** `room-isolation.mjs --host=threads --pairs=3 --profile --settle-ms=10000`
  at 12x6 and 36x18. Each size runs in one process. Each pair is a fresh room service
  with two rooms: room A (seed 4217) and room B (seed 4218). Maps were generated once
  before timing and handed over packed. Real loopback sockets, a real file archive
  and one dev viewer per room.
  - **Windows.** Each room's own series are read per window: preparation, tick 1,
    and an early window. A's early window is its first 10 s; B's is the 1.5 s tail.
  - **Cold room.** Only pair 0's room A is the first room thread in its process.
    B in pair 0, and both rooms in pairs 1 and 2, start in a process that has
    already run a room.
- **Isolation.** The same tool at 36x18 without `--profile` and with default windows
  (2 s settle, 3 s steady), as in [42.46](../../42.46-room-threads.md).

All runs were under the exclusive machine lock, with no contention. The other processes'
busy share was 3.1–3.6 %. No run reported an error, and no recorder dropped a frame. Map
cache SHA-256 values are in the summary.

## Findings

| 12x6, pair 0 / 1 / 2 | Room A | Room B |
| --- | --- | --- |
| Make/ready wall, ms | 673.5 / 600.9 / 597.1 | 628.5 / 623.3 / 613.5 |
| `prepare.staticsStep`, ms | **40.3** / 2.5 / 2.6 | 2.9 / 2.5 / 2.6 |
| Tick 1 `loop.tick` (ticks in window), ms | **31.6** (1) / 19.6 (1) / 19.0 (1) | 21.7 (1) / 21.0 (1) / 22.2 (1) |
| Tick 1 `sim.solve`, ms | **10.5** / 3.4 / 3.4 | 3.7 / 3.7 / 3.7 |
| Largest early tick, ms | 30.6 / 32.4 / 30.7 | 47.9 / 62.4 / 50.6 |

| 36x18, pair 0 / 1 / 2 | Room A | Room B |
| --- | --- | --- |
| Make/ready wall, ms | 1506.8 / 1310.7 / 1305.8 | 1401.8 / 1446.5 / 1424.6 |
| `prepare.staticsStep`, ms | **66.0** / 21.0 / 20.9 | 24.8 / 23.7 / 24.2 |
| Tick 1 `loop.tick` (ticks in window), ms | **60.0** (2) / 46.5 (2) / 45.0 (2) | 40.3 (2) / 44.1 (1) / 43.5 (2) |
| Tick 1 `sim.solve`, ms | **8.9** / 5.7 / 5.5 | 6.5 / 6.2 / 6.2 |
| Largest early tick, ms | 20.7 / 18.9 / 19.0 | 61.2 / 60.9 / 57.4 |

A's make/ready process CPU was 1265 / 766 / 766 ms at 12x6 and 2750 / 1938 / 1891 ms at 36x18.

1. **The cold cost is paid once per process, not once per thread.** Only the first room thread in a
   process pays it: a statics step of 40 ms against 2.5–2.9 ms at 12x6, and 66 ms against 21–25 ms at 36x18.
   It also pays more `sim.solve` in tick 1, and about 0.5 s (12x6) or 0.85 s (36x18) more make/ready
   process CPU. Every later room thread starts warm, including the first room of pairs 1 and 2, whose
   threads started after pair 0's had ended. The warm 36x18 statics step (21–25 ms) matches #1087's
   second-match-in-process broad phase (19–20 ms of a 22–23 ms step). That fits V8 keeping compiled wasm
   for the process. The mechanism was not verified.
2. **Tick 1 is now mostly bots.** Tick 1 is 19–22 ms at 12x6 and 40–47 ms at 36x18 in a warm thread.
   `sim.bots` is 5–7 ms and 14–22 ms of that, against 3.4–6.5 ms of `sim.solve`. Some 36x18 windows
   held a catch-up tick as well; the count is in parentheses.
3. **The largest early tick is first route planning, not startup.** In B's first 1.5 s every run had a
   48–62 ms tick, at both sizes and in warm threads. `sim.bots.plan` was 40–54 ms of it. Room A's
   first 10 s peaked at 19–32 ms, also bot planning. B is always seed 4218, so this is that seed's
   first plans. 42.22's #867 section saw them at tick 13 (about 35 ms) and said each room's own tick
   was under 50 ms. For seed 4218 it now is not.
4. **The other room is not disturbed.** During B's startup, A's own `loop.tick` maximum was 9.2–17.2 ms,
   against 8.8–15.9 ms in its steady window.

## Isolation re-run (36x18, unprofiled)

| Pair | A steady gaps p50 / max / over 75 | A startup gaps p50 / max / over 75 | Startup CPU / wall, ms | B ready / first state, ms |
| --- | --- | --- | --- | --- |
| 0 | 47.5 / 67.3 / 0 | 47.0 / 69.5 / 0 | 4360 / 3075 | 1453 / 1567 |
| 1 | 47.4 / 65.5 / 0 | 47.1 / 71.5 / 0 | 3968 / 3073 | 1446 / 1570 |
| 2 | 47.3 / 66.5 / 0 | 47.5 / 78.0 / 1 | 3907 / 3094 | 1466 / 1589 |

These are in the range of #1089's runs: startup maxima of 64–90 ms with at most one gap over 75 ms. B is
ready about 0.2–0.25 s later than in #1089's runs (1198–1257 ms). #1088's earlier header accounts for
about 140 ms of that; the rest was not traced. A recorded 164 frames and B 32, and neither dropped any.

## Retained files

- `summary.json.gz`: the three `--out` files, with every window's full series rows, plus the base commit
  and the map cache digests.
