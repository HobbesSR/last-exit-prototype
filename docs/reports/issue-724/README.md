# Clearance reuse: stopped checkpoint

Status: **incomplete; frozen-output drift, not ready for adoption or PR**.

The first cache variant changed the expected output of
`size-12-1/depot@126,102`. Issue #724 explicitly requires stopping and escalating
on any output drift, so no fix, further diagnostic run, repeat/reordered check,
focused test run or remaining timing pair was attempted after that failure.
The cause is not established. Expected outputs and historical captures were
not regenerated. No performance improvement is claimed.

## Inputs and experiment

Prototype archive: `1cb30ff13103ac46532fa855de71ab9ca6266155`.
The control applies the published #723 batch implementation, using
`docs/reports/issue-723/prepare.mjs` and `map/micro/geometry.ts` from
`2b72f1f` (fresh main at task start). The variant changes only clearance
execution and its guard adapter, retaining the control's geometry/content.
The frozen corpus SHA-256 is
`b90b15079f1396798217462c7782a08a6d15f527838f5e8dd4f52f2d970ce9bb`.

A preliminary post-#723 diagnostic counted 6,051,367 `travelClear` calls and
1,700,889 distinct directed endpoint/radius checks per actual mask across all
121 briefs. Instrumented swept-check time was 11,107.336 ms within a
20,173.422 ms build. Instrumentation overhead is included; this is work
attribution, not a controlled speed comparison. It motivated a lazy per-check
cache of capsule results, retaining blocked checks under monotone growth and
retesting previously clear capsules against spatially local newer blockers.

The cache binds one actual immutable mask, radius, supplied door collision
policy and growing prefix. Trials own unpublished entries; only a revision-
checked commit publishes them. Searches remain fresh per origin/trial.
These are implementation intentions, **not verified correctness claims**.

The failed comparison held the machine benchmark lock, with no concurrent
local tests or diagnostics. The control completed all 121 expected outputs in
13,762.474 ms, aggregate hash
`e02733543dbcb9de3d6c200dd3496479ab4d250fd525ec1988d03d100e185b15`.
The cached condition failed in the first pair; there are no completed pairs
and no usable median. `failure.json` preserves source pins, the control's raw
group timings and failure. The original incomplete harness output is retained
as `first-comparison.json` (its inherited #723 scope wording is stale).

## Reproduction and next action

The Codex worktree retains complete `control/` and `batch/` snapshots beneath
`test-results/issue-724`, together with `prototype.tar` and the diagnostic
script/report. Unrelated untracked review artifacts were left alone.

To reconstruct elsewhere, extract the prototype archive into fresh `control`
and `batch` directories. Extract `2b72f1f` separately as a driver. Run its
#723 `prepare.mjs` with the driver as working directory, then copy its two
modified batch files (`geometry.ts`, `strategies/content-access.ts`) into
control. From this checkpoint's repository root run:

```text
node docs/reports/issue-724/prepare.mjs SNAPSHOTS
node docs/reports/issue-723/compare.mjs SNAPSHOTS NEW_REPORT.json
```

The second command reproduces the stopped failure; it must not be treated as
authorization to resume after escalation. Preserve all expected outputs.

Pending lead decision: authorize a bounded correctness diagnosis of this first
variant or discard it and choose a different cache representation. Start with
the failed row and compare individual cached clearances to `travelClear`
before any further timings. Review the snapshot adapter as well as the cache;
do not assume the representation alone caused the output difference.

Pending checks if work resumes: focused tests in
`tests/micro-route-clearance.test.js` and `tests/micro-route-batch.test.js`,
repeat/reordered equality for all 121 direct and 21 parent rows, three quiet
locked paired comparisons with complete source pins, and changed-area gates
from [31](../../31-verification.md). The new focused tests have **not run**;
review their coverage and instrumentation assertions before relying on them.
Production content adoption, version changes, fixture recapture, neighbour
inspection and #716 traversal-frequency redesign remain outside #724.
