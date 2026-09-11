# Decoupling verification — September 10, 2026

Started from `5dd7d61` with a clean tracked worktree and the existing untracked
`FRESH_SESSION.md`. Gameplay remains `last-exit-0.6`.

## Checkpoints

- `0cd204e`: frozen characterization generated from unchanged gameplay.
- `6f141d4`: simulation systems and explicit tick coordinator.
- `c2d35c0`: ordered map generation and separate routing/navigation caches.
- Client checkpoint: input/HUD controllers, independent controller browser checks,
  architecture documentation and this verification record.

Before extraction, syntax checks, all 50 existing unit/server tests and the full
browser suite passed. Simulation passed 56 tests; map and client passed 59.
The complete syntax, unit/server/characterization and browser suites passed before
each subsystem checkpoint, followed by both benchmarks. No expected fixture was
regenerated after extraction.

The frozen fixture covers complete ordered maps for seeds 1, 9, 4217 and 777;
every authoritative tick and contestant/gladiator/directed projection in four
complete bot matches; and full scripted snapshots/projections for equipment,
latched commands, charging, doors, PvP, elimination, respawn, abilities, transit,
extraction and completion. Dependency tests enforce the public export surfaces,
acyclic shared imports, graph tie-breaking and cache invalidation.

Browser verification covers six-slot inventory, keyboard/touch rearrangement and
drops, dual-stick multitouch, pointer aim, charging/extraction, doors and roofs,
occlusion, reconnect/owner recovery, spectators, replay seeking/download and raw
diagnostic downloads. Unit/server tests additionally cover windows, gladiator
respawns, PvP, replay frame/command preservation and spectator delay. Independent
controller checks verify frozen HUD inputs, callbacks, minimap cloak/roof/viewport
concealment, one-shot consumption, dialog/blur/visibility resets and cleanup.

## Timing comparison

All measured on the same Windows machine using the default benchmark workloads:
seed 4217, one room, one viewer, full bot match (4,464 ticks); installed headless
Chrome, 1440 × 1000 viewport, entry location, 12 seconds holding D after warmup.
Commands: `node tests/bench.mjs --json` and
`node tests/bench-client.mjs --json`. Subsystem verification runs tests and
benchmarks sequentially. The first raw client baseline may have overlapped
characterization work, so the isolated repeats below govern the final comparison.
Raw benchmark reports are preserved in [REFACTOR_BENCHMARKS.json](REFACTOR_BENCHMARKS.json).

| Stage | Server mean / p95 ms | Raw client frame mean / p95 ms | Client JS frame mean ms | State gap mean ms |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 0.910 / 2.531 | 16.666 / 17.600 | 0.346 | 50.000 |
| Simulation | 0.904 / 2.521 | 16.667 / 17.400 | 0.255 | 49.940 |
| Map | 0.883 / 2.470 | 16.667 / 17.300 | 0.253 | 49.970 |
| Client | 0.878 / 2.453 | 16.667 / 17.300 | 0.252 | 49.981 |

To remove baseline load as a confound and investigate packet-gap variation, three
additional baseline/final pairs ran sequentially, alternating original and final
code. The original ran in a detached `5dd7d61` worktree with the same installed
dependencies. No tests ran during these repetitions. Median results:

| Version (three runs) | Server mean / p95 ms | Raw frame mean / p95 ms | Client JS frame mean ms | State gap mean / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Original `5dd7d61` | 0.882 / 2.455 | 16.667 / 17.400 | 0.259 | 49.994 / 62.800 |
| Refactored | 0.873 / 2.438 | 16.667 / 17.400 | 0.263 | 49.992 / 61.100 |

No reproducible degradation was observed. Client throughput stayed about 60 fps,
with zero server ticks over the 50 ms budget. The tiny JS timing difference is
within observed run-to-run variation (original 0.256–0.260 ms, final 0.258–0.268 ms).
Packet-gap variation also appears in the original. These local results do not
establish that the user's previously reported slowdown is fixed, nor do they
establish an optimization win. The initial human-readable baseline also passed
(0.962 ms/tick, 60.0 fps). All raw reports, including repeats, are retained.

## Scope and handoff

Server transport, renderer internals, movement, equipment, traps and view geometry
are byte-for-byte unchanged from `5dd7d61`. Public exports, mutable state shapes,
snapshot/wire fields, replay compatibility and simulation version are preserved.
No gameplay fixes or balance changes are mixed into the extraction. No new
gameplay defect was established during this pass; existing deferred work remains
in `IMPLEMENTATION_NOTES.md` and `REQUIREMENTS.md`.

`ARCHITECTURE.md` describes ownership, dependencies and cache contracts. The
existing handoff notes are preserved and supplemented in `FRESH_SESSION.md`,
which remains untracked. Checkpoints are local commits; no push was performed.
