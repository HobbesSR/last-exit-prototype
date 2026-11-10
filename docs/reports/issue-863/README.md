# Item-drop and admission evidence

Owning measurement: [42.22](../../42.22-tick-cost-attribution.md), "Item drops and
body admission (#863)". This is the item-drop follow-up to #635; #867 retains
the post-follow-up multi-room capacity check.

Baseline is `6943fa1`, implementation `ff6136e`, Node v24.15.0, content-6. A fresh production-worker map
for 36x18 seed 4217 was generated from that revision and cached with its portal
graph and packed navigation tiles. Both revisions restore independent copies
of the same cache. Its SHA-256 and the implementation source digests are in
`summary.json`. The cache is local, not a new characterization fixture.

Each of three sequential pairs runs baseline then implementation, under the
existing benchmark lock, with no concurrent tests or hash jobs from this agent.
`tests/bench-stages.mjs` runs the entire match, one room, one bot-seat player
view, no spectator, recording enabled to a discard stream. No omitted recording
frame is accepted. This workload does not establish several-room capacity,
live socket delivery, room-startup isolation, or disk throughput.

Temporary copies of both revisions add identical profiler hooks around
`scatterPoint`, `synchronizePhysicalItems` and `eliminate`, recording time and
call counts per tick. Production source has no additional timers. `drop.sync`
includes all item reconciliation in the tick, and `drop.eliminate` includes the
whole elimination, including inventory/reserve drops. These are inclusive timers;
do not add them together. `sim.itemSync` is the existing ordinary synchronization
stage. Initial cache construction remains setup work; mutation can still move
array entries, and snapshot position indexing remains separate from ownership
lookup.

`pair-<N>-<variant>.json.gz` retains the complete benchmark output, including
per-tick stage series, totals, GC, recorder health, wall and process CPU time.
Per-tick times exclude inter-tick recorder draining; loop wall/CPU includes it
and worker CPU. Setup/map generation is outside both measurements.
`summary.json` includes each elimination tick and matched early pickup ticks.
`pickups.json` records the removed ground ids and loot effects on those ticks;
`pickup-witness.mjs` reproduces this untimed check against the same cached map.
`frames12.txt` and `frames36.txt` are the exact matching
baseline/implementation frame and all-view digests, generated without the
temporary timers.

The retained scripts are copies of the local measurement helpers. To reproduce,
copy `prepare.mjs`, `instrument.mjs`, `measure.mjs` and `pickup-witness.mjs` into
`test-results/issue863/` and run them from the repository root. Archive `6943fa1`
into `test-results/issue863/base/` and `changed/`, providing the current installed
dependencies to each archive. Run `node test-results/issue863/prepare.mjs` on the
baseline generation source, then:

```text
node test-results/issue863/instrument.mjs test-results/issue863/base base
node test-results/issue863/instrument.mjs test-results/issue863/changed changed
node test-results/issue863/measure.mjs
```

The changed archive receives the working tree's three simulation files. The
instrumentation script reads unchanged baseline functions directly from git.
Freeze those source files before running comparisons. Regenerate the cache
after any generation/content change. Run the standard frame-hash command with
`--views`, and the 36x18 command with `--contents=content-6 --seeds=4217
--maps-cache=<same-cache> --views`, against both uninstrumented revisions.
