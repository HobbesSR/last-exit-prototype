# Prepared sweep indexes and residual startup (#908, #842)

Owning measurement: [42.22](../../42.22-tick-cost-attribution.md).

2026-11-14, Node v24.15.0, content-7. Base `9798a4d`; implementation
`93569c6`; common startup harness `3eacaa7`. These are branch comparisons,
not post-merge main evidence. Corey authorized measuring #842 on the unmerged
#908 branch. No fixture or content version changed.

## Workloads

- Three sequential alternating base/branch pairs of
  `node tests/bench-stages.mjs --size=36x18 --seed=4217 --rooms=2 --clients=8 --spectators=1 --maps-cache=<cache> --out=<report>`.
  This is the `bench:stages` script, unchanged. Each run completed 12,000 ticks,
  recording with drains between ticks, on the same production-worker cache for
  seeds 4217/4218. No recording drops. The baseline was archived beneath the
  worktree; each version used its own simulation/cache module instances.
- Three alternating pairs per size of `room-startup.mjs --size=<12x6|36x18>
  --maps-cache=<cache> --root=<base|branch> --out=<report>`, using the common
  harness. One direct dev viewer per room, live scheduler, recording enabled.
  Both maps were prepared/adopted before timing. All six 12x6 runs were healthy;
  all six 36x18 runs failed recording health. Failures are retained, not treated
  as capacity evidence. All runs had zero lifecycle errors.
- One exploratory synthetic pair: `bench-stages.mjs --size=36x18 --tile=2x1
  --ticks=50 --seed=4217 --clients=1 --spectators=0 --maps-cache=<cache>`.
  One tiled 72x18 room, recordings healthy. This is a cold-cost scaling witness,
  not a repeated performance comparison, live-room startup or supported topology.
- One branch `room-startup.mjs --size=36x18 --maps-cache=<cache>
  --profile=<prefix>` for attribution only. Inspector overhead invalidates its
  latency/health figures for comparison. Preparation's largest sampled native
  stack was `createGame -> synchronize -> overlapsDynamicBox -> WASM`, with
  70 leaf samples; GC had 63, `queueAddBody` 58 and `structuredClone` 39.
  The profile locates residual work; it does not quantify a proposed fix.

All runs were sequential under the exclusive machine lock; every retained timing
run's contention stamp is false. Process CPU includes recording/map workers.
An initial cache-building startup diagnostic and a tool-interrupted full-match
attempt were excluded from comparisons. PowerShell recorded an outer nonzero
status after relaying the lock's stderr wait notice; the comparison runner's
seven child statuses (focused tests, types and five remaining timings) were zero.

## Retained files

- `summary.json.gz`: source/cache provenance, each stage run's wall/CPU time,
  max/p99.9/over-budget counts and stage summaries; full unprofiled startup
  reports including cold-tick attribution and raw wake/delivery series; synthetic
  results. Preparation wake maxima select wake timestamps inside make/ready.
- `timings.json.gz`: all six whole-match tick totals and relevant stage series.
- `preparation-profile.json.gz`: preparation CPU profile with repository-relative
  source URLs. Profile timings are not comparative evidence.
- `hashes-12x6.txt`, `hashes-36x18.txt`: identical base/branch snapshot, all-view
  and sampled live/delayed/recording map-payload hashes. The 12x6 set is the
  tool's standard four contents and three seeds; the 36x18 match is content-7,
  seed 4217, 12,001 frames. Map-cache SHA-256 digests are in the summary; the
  local caches are inputs to this investigation, not new fixtures.

## Verification

`check`, both typechecks, fast gate (1,475 passing), selected characterization,
room-size and live-map integration (15 passing), and exact hash comparisons all
passed. Focused swept-index and match regressions passed before timing. Four new
fast cases cover cache reuse before the first sweep and cancellation in both
preparation phases; the existing match trace now distinguishes source order from
native ID order. The complete changed test files take 0.3 s (`swept-index`) and
1.2 s (`match`) alone. No recurring large-map benchmark/test was added.

No browser, full chain sweep or full slow suite was run: no geometry algorithm,
generation input, browser path or wire format changed. The whole-match hashes
and frozen characterization cover the simulation equivalence contract; the
existing lifecycle and roster/input witnesses ran in the fast gate. These
checks do not establish live worker-map delivery/adoption performance, real
socket/network/storage capacity, or full startup isolation.
