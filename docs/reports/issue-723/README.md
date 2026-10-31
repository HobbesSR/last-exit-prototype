# Shared-origin warehouse entrance searches

The reusable search retains the exact single-target BFS route for every target,
including its direct check, stable seed and neighbour order, earliest swept
connector and straight-run collapse. Each call inspects the existing BFS prefix
before extending it. Searches belong to one immutable collision prefix; the
prototype adapter creates fresh per-origin searches within each trial. Rejected
and stale trials cannot publish them. No entrance obligation is sampled away.

The production PR adds the reusable API independently of #716's unready content.
`prepare.mjs` applies that same implementation to the pinned prototype and adapts
its entrance and displaced-proof calls in their original order. The prototype's
spatial broad phase, lazy initial proof, geometry and all other sources remain
unchanged. That adapter is retained here for #716 integration rather than
silently promoting the content change into this behavior-preserving PR.

## Controlled measurement

Control source: `1cb30ff13103ac46532fa855de71ab9ca6266155`, complete git archive.
This is the published #716 prototype plus historical #722 evidence. Corpus:
`docs/reports/issue-716/frozen-corpus.json.gz` at that revision, SHA-256
`b90b15079f1396798217462c7782a08a6d15f527838f5e8dd4f52f2d970ce9bb`.
The 121 briefs and full expected ordered outputs are never regenerated.

Three paired runs held the machine benchmark lock with no concurrent local
tests or diagnostics. Order alternated control/batch, batch/control,
control/batch. Each measured build checked its complete output hash.

| Pair | Independent searches | Shared searches |
| --- | ---: | ---: |
| 1 | 16.755 s | 14.681 s |
| 2 | 16.390 s | 14.439 s |
| 3 | 15.841 s | 13.546 s |
| Median | 16.390 s | 14.439 s |

Median total time decreased **11.91%**, or **1.135× faster**. This is direct
builder work only, excluding macro generation and composition. Market groups
show little benefit: the 24-size market median rose from 1.149 to 1.234 s
(7.44%), while the 36-size market median fell from 2.811 to 2.776 s (1.24%).
The principal gain is depot routing. Every condition and
repetition matched all 121 frozen expected results and aggregate output hash
`e02733543dbcb9de3d6c200dd3496479ab4d250fd525ec1988d03d100e185b15`.
Raw per-size/type timings and source hashes are in `comparison.json`.

This does not resolve the prototype's feature-versus-original-content cost
regression or establish ordinary-traversal encounter frequency. Historical
types-56 timing is context, not this optimization's control.

## Reproduction

Create two fresh directories named `control` and `batch` beneath a fresh
worktree-local scratch directory. Extract a complete `git archive` of the pinned
revision into each. Keep the archive unchanged. From this PR's repository root:

```text
node docs/reports/issue-723/prepare.mjs SCRATCH_DIRECTORY
node docs/reports/issue-723/compare.mjs SCRATCH_DIRECTORY NEW_REPORT.json
node docs/reports/issue-723/verify.mjs SCRATCH_DIRECTORY NEW_IDENTITY.json
node docs/reports/issue-723/parent-access.mjs SCRATCH_DIRECTORY NEW_PARENT_ACCESS.json.gz
node docs/reports/issue-723/source-audit.mjs SCRATCH_DIRECTORY NEW_SOURCE_AUDIT.json
```

The comparison refuses an existing output and stops on the first identity drift.
The first setup attempts exposed missing exported helpers in the adapter and
were corrected before the completed three-pair report; they are not timing
results. The original control and frozen expected corpus stayed unchanged.

Focused tests compare to an independent pre-batch algorithm, including target
reordering, duplicates, off-grid/invalid endpoints, disconnection, exhausted
searches, direct paths and expansion of a prior target's stopping node.

## #716 access, integration and traversal evidence

`identity.json` records repeat/reordered matches for all 121 direct regions and
21 frozen block parents. `parent-access.json.gz` retains the independent swept
routes from final parent geometry: all 21 have zero fill errors and valid
thorough portal checks. All **3,679 contestant loot targets** are reachable.
Hunter diagnostics retain 3,236 witnesses and 443 invalid larger-body targets;
those are not silently recategorized as contestant failures or successful
hunter access. This supplements the historical 121 direct-region checks.

`integration.mjs` builds a separate complete archive of current main at
`5d81668bb660808154f074184feb9185db53c96b`, overlays the feature/search files,
and retains main's depot appearance adoption. All 142 outputs match the
historical corpus after removing **only `appearance` properties**. Full
integrated output hashes and every appearance change count remain in
`integration.json`; this is not a claim of full-result identity across an
intentional appearance change. The current appearance test and 18 focused
access/market/boundary tests pass. Production files and compatibility versions
are not changed by this diagnostic. Future adoption needs a new content
version (the old prototype's proposed `types-57` is already used on main),
reviewed content expectations and a final chain baseline capture.

`frequency-audit.mjs` replays the stronger old-actual-route obstruction measure
from the immutable evidence archive. All nine replayed raw outputs match the
historical hashes exactly. `frequency.json` retains input/output hashes,
per-map denominators, zero-effect attempts and the removed-target subset.
Contestants: **137/1,359 affected**, 1,222 zero effects. Hunters:
**152/1,359 affected**, 1,207 zero effects. `size-12-1` and `size-12-2` have zero
effects for both bodies. Restricting to still-offered targets gives 131/1,272
and 146/1,272 effects. These fixed geometric routes do not establish an
encounter on a typical traversal or a player-traffic distribution. The
existing two-family prototype falls short of #716's encounter outcome; the
map-level count of physical joins cannot repair that result. No favourable
endpoints, seeds or new content have been substituted.

## Remaining cost and decision

`remaining-cost.json` is a separate contextual comparison against original
types-56 content at `54d9077a5fd881765b123d4d877d3bca67694409`, using the same
121 briefs from the archived baseline panel. Three alternating pairs held the
benchmark lock and checked every output against its own frozen expectation.
Original totals were 5.709, 5.297 and 5.385 s; optimized prototype totals were
13.382, 13.308 and 13.384 s. The median prototype remains **2.485 times** the
original time. Depot group medians are 1.996 versus 9.447 s; market medians are
3.248 versus 3.784 s. This is feature cost, not an isolated batching regression.

The original macro depot witness retains its 200-by-150 grid and 3 s assertion.
Each separate child process has a 10 s hard cap; capped attempts are incomplete,
never passes. See the raw report for every attempt and assertion output.
All three original attempts passed the unchanged assertion; all three optimized
prototype attempts reached the 10 s cap without completing. No exact prototype
scale duration or budget pass is claimed.

Reproduce this contextual comparison by extracting a complete original archive
as `SCRATCH_DIRECTORY/original` (retain `original.tar`), and extracting the
prototype's immutable `docs/reports/issue-716/evidence.tar.gz` to `EVIDENCE`:

```text
node docs/reports/issue-723/remaining-cost.mjs SCRATCH_DIRECTORY EVIDENCE/baseline NEW_COST.json
```

#724's trial-local clearance caching remains a justified bounded next cost
investigation; #723 alone does not meet the scale budget. Cost work cannot
resolve the separate traversal-frequency shortfall. Keep #716 open: adopting
the present two-family content would leave its encounter outcome unmet. Any
content redesign needs an explicit requirement decision and new expectations,
separate from these behavior-preserving optimizations.

`verification.json` records the main gates. The full 224-map chain check has
zero drift; the fast and micro suites pass. No fixture or baseline was recaptured.
