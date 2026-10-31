# Local clearance reuse (#724)

Status: implementation and controlled comparison complete; integration gate
results are recorded in `verification.json`. No #716 content is adopted.
There is no production caller on main: the 26.68% measured gain belongs only
to the pinned prototype modified by `prepare.mjs`. Exporting the SDK API does
not change production generation cost or content.

## What is reused

`createRouteClearance` binds one actual immutable access mask, body radius,
supplied door-collider policy and growing accepted collision prefix. A compact
numeric table memoizes half-cell grid standing and directed cardinal-edge
checks. Added shape bounds expanded by radius plus a grid step conservatively
invalidate nearby clear checks. Affected checks use exact swept collision again;
remote clear checks and previously blocked checks remain reusable. Arbitrary,
off-grid and longer endpoint connectors retain exact uncached checks.

Each preparation owns its new checks and local invalidation until a revision-
checked, single-use commit. Refused and stale trials cannot publish entries or
geometry. BFS state remains separate and is rebuilt per origin/trial. The
production API is independent of the unready #716 content, following #723's
integration boundary. The retained adapter applies it to the frozen prototype
without changing targets, admission, geometry, search order, RNG or IDs.

## Controlled comparison

Control: the complete prototype at
`1cb30ff13103ac46532fa855de71ab9ca6266155`, prepared with #723's batch
implementation from `2b72f1fb3519df2653ea7768848d1f92764a8cf4`.
Only the cache module, route clearance callback and guard adapter differ in
the candidate. `source-audit.json` checks all 302 map/shared source files,
including added files. `grid-comparison.json` retains archive/source pins,
Node version, group times, output hashes and run order.
Hardware and power configuration were not recorded. External non-cooperating
process load was not measured; the machine lock serializes cooperating
benchmarks, and this task ran no tests or diagnostics during measurements.

Frozen corpus SHA-256:
`b90b15079f1396798217462c7782a08a6d15f527838f5e8dd4f52f2d970ce9bb`.
All 121 full ordered outputs (elements, loot, core elements and manifests) stay
unchanged. Three sequential pairs held the machine benchmark lock without
competing local tests or diagnostics, alternating control/cache order.

| Pair | Post-#723 control | Grid cache |
| --- | ---: | ---: |
| 1 | 14.583 s | 11.839 s |
| 2 | 14.825 s | 10.870 s |
| 3 | 15.192 s | 10.758 s |
| Median | 14.825 s | 10.870 s |

Median total time falls **26.68%**, or **1.364 times faster**. This measures
direct builders, excluding macro generation and composition. Every measured
pass matches aggregate output hash
`e02733543dbcb9de3d6c200dd3496479ab4d250fd525ec1988d03d100e185b15`.
`grid-identity.json` also retains exact repeat/reordered equality for all
121 direct regions and 21 frozen block parents (284 additional builds).

| Group | Control median | Cache median |
| --- | ---: | ---: |
| Depot / 12 | 0.712 s | 0.637 s |
| Depot / 24 | 1.975 s | 1.573 s |
| Depot / 36 | 7.827 s | 4.170 s |
| Market / 12 | 0.105 s | 0.121 s |
| Market / 24 | 1.252 s | 1.342 s |
| Market / 36 | 2.928 s | 3.103 s |

The gain is in depot routing. Market group medians regress by approximately
15.6%, 7.1% and 6.0% at sizes 12, 24 and 36; there is no claim that caching
helps every region type.

## Remaining cost and scope

`remaining-cost.json` is a separate locked three-pair contextual comparison
against original types-56 content at
`54d9077a5fd881765b123d4d877d3bca67694409`, using the identical 121 briefs and
each implementation's frozen expectations. Original totals are 7.713, 5.971
and 5.989 s; the cached prototype takes 11.556, 11.195 and 11.035 s.
At the median it still takes **1.869 times** the original time. Depot group
medians are 2.323 versus 6.262 s; market medians are 3.506 versus 4.636 s.
This comparison does not isolate caching and must not replace the controlled
post-#723 comparison above.

All three original 200-by-150 macro depot witnesses pass their unchanged
3 s assertion. All three cached-prototype attempts hit the 10 s child-process
cap without completing. A capped attempt is incomplete; no exact scale
duration or budget pass is claimed. Raw assertion output is preserved.

#716's separate typical-traversal shortfall remains unresolved. This cost
optimization does not adopt its content, change compatibility versions,
recapture fixtures, inspect neighbour content or weaken access promises.

## Investigation history

The preliminary post-#723 diagnostic (`profile.json`) counted 6,051,367
swept-clearance calls and 1,700,889 distinct directed endpoint/radius checks
per actual mask across the 121 briefs. Instrumented swept-check time was
11,107.336 ms within a 20,173.422 ms build. Instrumentation overhead is included:
this is attribution, not an uninstrumented speed comparison.

The initial adapter named the cache callback `clear`, shadowing the existing
entrance-standing helper. It therefore supplied a shape array where the cache
expected an endpoint. The first cached build changed
`size-12-1/depot@126,102`. Work stopped under the issue's output-drift rule,
and Corey explicitly authorized continued debugging. The collision was fixed
by naming the callback `cachedClear`; the standing helper is retained.
The adapter is also typechecked. `failure.json` and
`first-comparison.json` preserve the incomplete failed attempt.
The latter retains the old #723 harness's inherited scope wording; it is not
a completed comparison or a batching measurement.

After that fix, `diagnosis.json` compares every requested cached answer for
the failed depot against uncached swept geometry: all 20,486 agree and its
full result matches the original expectation. `grid-diagnosis.json` repeats
that check for the final representation. No expected output was regenerated.

Two correct generic capsule caches were slower and were rejected:
`first-cache-comparison.json` gives 15.153 versus 18.785 s medians;
`indexed-cache-comparison.json` gives 15.763 versus 18.230 s.
Each completed three locked pairs with exact outputs. Their implementations
are preserved as `first-cache.ts.txt` and `indexed-cache.ts.txt`, with their
repeat/reordered reports. `identity.json` records the first correct
representation; `indexed-cache-identity.json` records the indexed variant.
The redundant `first-cache-identity.json` copy was removed after verifying
that its SHA-256 matched `identity.json`; no distinct capture was discarded.

## Adoption and deferred review notes

The prototype has a spatial-query argument before the clearance callback;
main currently has only the callback. Before adoption, reconcile these through
an options object rather than shifting positional arguments. The current
production signature remains unchanged in this review follow-up.

The review also identified avoidable accepted-view allocation, string bucket
keys and cloned geometry as possible market overhead. They are hypotheses,
not attributed causes or measured improvements. Address them separately with
source-pinned frozen-output checks and quiet paired timings; the measurements
above remain bound to the reviewed implementation.
The optional follow-up is tracked on [#743](/corey/astra_test/issues/743),
behind the missing functional outcomes in #716 and #717.

Computed trial results are deliberately discarded on refusal. Publishing even
unaffected results into accepted state would change the strict trial-isolation
policy. Such reuse needs an explicit accepted-prefix proof and rollback tests;
it is not part of this approved implementation or a required next task.

One later timing attempt could not acquire the machine lock and produced no
measurements. It was retried with a longer lock wait; no test or diagnostic
ran while waiting or measuring.

## Reproduction

From this repository root, run:

```text
node docs/reports/issue-724/setup.mjs
```

The script prints a fresh worktree-local snapshot directory. It extracts
complete prototype and #723 driver archives, prepares the post-#723 control,
verifies its two changed source hashes and the frozen corpus, and prepares
the cache candidate. Substitute the printed directory below. Reports refuse
existing output files.

```text
node docs/reports/issue-724/diagnose.mjs SNAPSHOTS NEW_DIAGNOSIS.json
node docs/reports/issue-723/verify.mjs SNAPSHOTS NEW_IDENTITY.json
node docs/reports/issue-724/source-audit.mjs SNAPSHOTS NEW_SOURCE_AUDIT.json
node docs/reports/issue-724/compare.mjs SNAPSHOTS NEW_COMPARISON.json
```

For the contextual cost/scale comparison, additionally extract a complete git
archive of the original revision above into `SNAPSHOTS/original`, preserving
it as `SNAPSHOTS/original.tar`. Extract the prototype's immutable
`docs/reports/issue-716/evidence.tar.gz` into `EVIDENCE`, then run:

```text
node docs/reports/issue-724/remaining-cost.mjs SNAPSHOTS EVIDENCE/baseline NEW_COST.json
```

Correctness tests include growing-prefix route equivalence, local node/edge
invalidation, a thin wall between free endpoint bodies, translated/negative
origins, exact uncached connectors, copied geometry and rejected/stale trial
isolation. The prototype's nine access/rollback tests also pass. Owning
contracts are [20.2](../../20.2-geometry-access.md); gate policy is
[31](../../31-verification.md).
