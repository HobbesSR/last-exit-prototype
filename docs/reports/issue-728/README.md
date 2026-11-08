# Recording worker evidence

The owning measurement is [42.22](../../42.22-tick-cost-attribution.md),
"Recording worker (#728 stage 1)". These are measurements of the existing
full-state format, not a delta format or multi-room capacity claim.

Source: baseline `7f93dea`, implementation `952f4af`, Node v24.15.0. Baseline
`server/replay-writer.js` was read directly from git and loaded against the
unchanged shared JSON owners. The same `tests/bench-stages.mjs` from `952f4af`
ran on both sides; the baseline copy changed only its writer import. Cache
loading and CPU reporting were therefore present on both sides.

Workload: seed 4217, content-6, 1,200 ticks, one room with one player view and no
spectator, recording on with discarded gzip output. The production map worker
generated the 36x18 geometry/navigation once
from `7f93dea` into a fresh local cache. Each process restored its own copy. No
map-generation or preparation time is in the tick or loop/CPU measurements.

Runs are three sequential baseline/implementation pairs at 36x18, under the
built-in benchmark lock, without this agent's tests running. The lock serializes
benchmarks, not every process on the shared machine. Per-tick timing excludes
inter-tick recorder draining; `run.wallMs` and `run.cpuMs` include those drains
and worker CPU. These unpaced runs measure loop work with healthy recording,
not network delivery, real disk performance or wall-clock live scheduling.
Injected Writable timings include the worker's acknowledged compressed-chunk
bridge. Production file outputs live entirely in the worker and do not use that
bridge; their end-to-end throughput was not measured here.

Reproduction uses `npm run bench:stages -- --size=36x18 --content=content-6
--seed=4217 --ticks=1200 --clients=1 --spectators=0 --maps-cache=<fresh-cache>
--out=<json>`. The cache format is shared
with `tools/perf/room-startup.mjs`; regenerate it from the recorded source revision
after any generation/content change. Archive comparison uses
`tools/perf/recording-compare.mjs --baseline=<archived-writer-module>
--maps-cache=<same-cache> --out=<json>`.

The synthetic 72x36 server run (`--tile=2x2`) failed before timing on the baseline:
the current map's repeated geometry exceeds the existing 100,000-static-body cap.
The cap is unchanged. Instead, three alternating writer pairs run
`tools/perf/recording-payload.mjs --maps-cache=<same-cache> --ticks=1200
--out=<json>`, adding `--baseline=<archived-writer-module>` for the old writer.
This probe tiles only the recording payload: stable kept lists, 33,300 items,
2,884 gates, changing tick, 4,169,610 bytes in the initial frame (later tick numbers
add up to three bytes). It does not advance a
synthetic 72x36 simulation, and its append times are not total server tick times.

`summary.json` retains each paired run's tick/append statistics, cold tick,
CPU/wall time, geometry digest and the pre-timing 72x36 admission failure.
`timings.json.gz` also retains every measured 36x18 tick and stage series. All
six 72x36 payload runs have identical whole-gzip and frame digests; packaging
asserted equality and zero omissions across both workloads.
`archive.json` retains the whole 36x18 match's compressed-byte count, gzip digest,
ordinary-serialization frame digest and snapshot digest. Archives were streamed
to digest sinks, avoiding retention of two 1.20 GB output files.
`frames12.txt` and `frames36.txt` are `frame-hashes.mjs --views` outputs.
The 36x18 snapshot digest agrees with the independent archive comparison.
The simulation/view modules are identical to the baseline source; only the
archive comparison runs both writer implementations against the same frames.

The browser integration test timed out in `tests/browser.mjs:518` (mobile room
startup) on both the implementation and the baseline writer/store modules
loaded from `7f93dea`. The implementation failed twice, including an isolated
run; the baseline failed at the same step with the same 15-second timeout and
no browser errors. It is not reported as a passing browser gate.
