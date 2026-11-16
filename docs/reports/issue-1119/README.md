# Room startup on threads (#1119)

Owning measurement: [42.22](../../42.22-tick-cost-attribution.md#room-startup-on-threads-1119).

2026-11-15, Node v24.15.0, content-7. Base `ced6be0` (main, with #1087, #1088 and
#1115); the harness change is `room-isolation.mjs --profile` on branch
`claudecode/1119-threaded-startup`. No server, fixture, content or wire change.

## Workloads

- **Profiled.** `room-isolation.mjs --host=threads --pairs=3 --profile` at 12x6 and
  36x18. Each size runs in one process. Each pair is a fresh room service with two
  rooms: room A (seed 4217) and room B (seed 4218). Maps were generated once before
  timing and handed over packed. Real loopback sockets, a real file archive and one
  dev viewer per room.
  - **Windows.** Each room's own series are read per window: preparation, tick 1,
    and its first 10 s after tick 1.
  - **Chunked reads.** The profiler keeps 600 samples per series and a room's loop
    banks one frame per wake (about 70–80 a second), so the 10 s windows are read
    every 2 s and merged. Each early window holds all 200 ticks (`loop.simSteps`
    equals `sim.tickPacing`'s count) in 5–7 chunks of at most about 170 frames.
  - **Cold room.** Only pair 0's room A is the first room thread in its process.
    B in pair 0, and both rooms in pairs 1 and 2, start in a process that has
    already run a room.
- **Isolation.** The same tool at 36x18 without `--profile` and with default windows
  (2 s settle, 3 s steady), as in [42.46](../../42.46-room-threads.md).

All runs were under the exclusive machine lock, with no contention. The other processes'
busy share was 2.7–4.3 %. No run reported an error, and no recorder dropped a frame. Map
cache SHA-256 values are in the summary.

**A discarded first set.** The first profiled set read a 10 s early window in one piece. It
overflowed the 600-sample retention, dropping A's first 1.3–2.4 s after tick 1 (review 847), and it
observed B for only 1.5 s (review 849). Its early-window figures are withdrawn. Its preparation and
tick 1 windows were within the retention and agree with the cold-process finding below. Every tick
cost in it ran about 20–25 % higher than in this set, also uncontended; that difference was not
traced. This set replaces it.

## Findings

| 12x6, pair 0 / 1 / 2 | Room A | Room B |
| --- | --- | --- |
| Make/ready wall, ms | 623.6 / 534.3 / 523.2 | 579.3 / 550.8 / 548.1 |
| `prepare.staticsStep`, ms | **38.0** / 2.3 / 2.4 | 2.6 / 2.4 / 2.5 |
| Tick 1 `loop.tick`, ms | **22.2** / 15.1 / 14.9 | 16.4 / 15.6 / 16.0 |
| Tick 1 `sim.solve`, ms | **7.0** / 2.6 / 2.6 | 2.9 / 2.8 / 2.8 |
| Largest tick in the first 10 s, ms | 28.9 / 27.8 / 27.7 | 38.2 / 34.5 / 36.1 |

| 36x18, pair 0 / 1 / 2 | Room A | Room B |
| --- | --- | --- |
| Make/ready wall, ms | 1304.6 / 1192.8 / 1170.2 | 1283.5 / 1274.2 / 1248.7 |
| `prepare.staticsStep`, ms | **58.0** / 20.6 / 20.4 | 21.7 / 22.2 / 21.9 |
| Tick 1 `loop.tick`, ms | **39.3** / 33.6 / 33.4 | 33.4 / 31.9 / 30.9 |
| Tick 1 `sim.solve`, ms | **7.8** / 4.8 / 4.7 | 4.5 / 4.7 / 4.6 |
| Largest tick in the first 10 s, ms | 34.9 / 33.2 / 33.1 | 44.0 / 43.2 / 43.7 |

Each tick 1 window held one simulated tick. A's make/ready process CPU was 1062 / 671 / 719 ms at
12x6 and 2313 / 1531 / 1969 ms at 36x18.

1. **The cold cost is paid once per process, not once per thread.** Only the first room thread in a
   process pays it:
   - a statics step of 38 ms against 2.3–2.6 ms at 12x6, and 58 ms against 20.4–22.2 ms at 36x18;
   - more tick 1 `sim.solve` (7.0 against 2.6–2.9 ms, and 7.8 against 4.5–4.8 ms);
   - about 0.35–0.8 s more make/ready process CPU at both sizes.

   Every later room thread starts warm, including the first room of pairs 1 and 2, whose threads
   started after pair 0's had ended. The warm 36x18 statics step (about 21 ms) matches #1087's
   second-match-in-process broad phase (19–20 ms of a 22–23 ms step). That fits V8 keeping compiled
   wasm for the process. The mechanism was not verified.
2. **Tick 1 is mostly bots.** In a warm thread tick 1 is 15–16 ms at 12x6 and 31–34 ms at 36x18.
   Within it, `sim.bots` is 4–5 ms and 11–15 ms, against 2.6–4.8 ms of `sim.solve`.
3. **The largest tick in each room's first 10 s is route planning, not startup.** `sim.bots.plan` was
   26–34 ms of the largest tick at 12x6 and 22–30 ms at 36x18. No run had a tick over 50 ms. Seed 4218
   (B) plans more than seed 4217 (A).
4. **The other room is not disturbed.** During B's startup, A's own `loop.tick` maximum was
   5.7–6.4 ms at 12x6 (steady 6.1–10.1 ms) and 11.1–12.1 ms at 36x18 (steady 9.7–14.2 ms).

## Isolation re-run (36x18, unprofiled)

| Pair | A steady gaps p50 / max / over 75 | A startup gaps p50 / max / over 75 | Startup CPU / wall, ms | B ready / first state, ms |
| --- | --- | --- | --- | --- |
| 0 | 47.5 / 67.3 / 0 | 47.0 / 69.5 / 0 | 4360 / 3075 | 1453 / 1567 |
| 1 | 47.4 / 65.5 / 0 | 47.1 / 71.5 / 0 | 3968 / 3073 | 1446 / 1570 |
| 2 | 47.3 / 66.5 / 0 | 47.5 / 78.0 / 1 | 3907 / 3094 | 1466 / 1589 |

These are in the range of #1089's runs: startup maxima of 64–90 ms with at most one gap over 75 ms. B is
ready about 0.2–0.25 s later than in #1089's runs (1198–1257 ms). #1088's earlier header accounts for
about 140 ms of that; the rest was not traced. The profiled set's B was ready in 1249–1284 ms. A recorded
164 frames and B 32, and neither dropped any.

## Retained files

- `summary.json.gz`: the profiled `--out` files for both sizes and the isolation `--out` file, with every
  window's full series rows (merged windows carry their chunk count), plus the base commit and the map
  cache digests.
