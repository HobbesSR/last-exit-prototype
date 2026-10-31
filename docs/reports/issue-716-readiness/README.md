# #716 readiness reassessment

**Retain as evidence; reject both candidates for adoption. #716 stays open.**
The boundary-first content improves the fixed ordinary-route effect counts but
does not establish the requested typical-traversal outcome. A separate local
witness-repair experiment preserves the frozen content yet still hits the scale
cap in all three attempts. No production code, public API, content version,
baseline or frozen fixture changes here.

Owning record: [42.3](../../42.3-generation-and-delegation-evidence.md).
Direction: [17.2.11](../../17.2.11-navigation-structure-direction.md).
Obligations: [20.6](../../20.6-passable-margins.md).
Parent ownership: [20.3.5](../../20.3.5-district-and-core-element-builders.md).
This is a readiness rejection, not a completed #716 acceptance package.

## Sources and one declared content candidate

The task starts from main `bca7e10`. The complete historical prototype is
`1cb30ff13103ac46532fa855de71ab9ca6266155`, prepared with #723 and #724 by
[`../issue-724/setup.mjs`](../issue-724/setup.mjs). Its original frozen corpus
SHA-256 remains
`b90b15079f1396798217462c7782a08a6d15f527838f5e8dd4f52f2d970ce9bb`.
The historical WIP branch and all earlier captures are preserved.

[`protocol.json`](protocol.json) declares the candidate and stopping boundary.
The original nine maps are `size-{12,24,36}-{1,2,3}` at cell size 48, with all
151 original endpoint pairs per body/map. No seeds or endpoints were replaced.
The original briefs and all core sites remain exact. Only depot/market are
changed; 21 block parents are rebuilt because they can dispatch depot children.
Other top-level results remain the original saved results.

[`frontage-prepare.mjs`](frontage-prepare.mjs) copies a complete snapshot and
applies two independently seeded policies before regular interior placement:

- Depot attempts inward container rows of 6, 4, then 2 cells at exposed owned
  sides, using its existing density and new draw channel 11.
- Market moves its frontage pass first, tries inward counters of 4 then 2
  cells, and retains the existing 0.55 probability and channel 3.

Canvas fill, doorway spacing, portal crossings, movable portal witnesses and
registered warehouse entrance targets still constrain every atomic placement.
The existing quarter-cell attachment closes shape insets only within an owned
footprint. Neither builder reads the other owner's content or seed. No macro
guarantees, caps, ownership or parent planning rules change.

The complete 302-file [source audit](source-audit.json) finds exactly two changed
files for this candidate: `strategies/depot.ts` and `strategies/market.ts`.
Readable inserted code is retained in [the depot snippet](depot-boundary.ts.txt)
and [the market snippet](market-frontage.ts.txt).

## Fixed traversal outcome

The comparison retains the existing stronger measure: a static part participating
in a positive-length cross-owner join obstructs the **old actual route** at body
radius, and the same fixed endpoints have a complete final route. It does not
attribute the entire route-length change to that part, simulate exploration,
count player traffic, or replace the measure with join totals or direct chords.
An independent anchor audit finds no joined seams lacking positive static/static
overlap (gate-only joins) in this candidate.

| Fixed map | Joined length, world units | Contestant effects / 151 | Hunter effects / 151 |
| --- | ---: | ---: | ---: |
| size-12-1 | 0 | 0 | 0 |
| size-12-2 | 170.6 | 0 | 0 |
| size-12-3 | 193.4 | 6 | 3 |
| size-24-1 | 1,057.2 | 50 | 51 |
| size-24-2 | 1,085.4 | 14 | 18 |
| size-24-3 | 753.0 | 29 | 26 |
| size-36-1 | 1,923.6 | 26 | 32 |
| size-36-2 | 2,404.8 | 47 | 44 |
| size-36-3 | 1,813.0 | 36 | 47 |

Total effects are **208/1,359 (15.31%) contestant** and
**221/1,359 (16.26%) hunter**, versus 137/152 in the previous prototype.
Zero-effect attempts remain **1,151/1,138**; the same two small maps have zero
effects. Still-offered actual targets retain **202/1,263** and **214/1,263**
effects. Their denominator changes from the prior 1,272 rather than silently
substituting new loot targets. Final fixed-route failures are 15 contestant and
24 hunter invalid endpoints, with zero unreachable/search-miss/sweep-defect
results. Core endpoints are unchanged; removed loot endpoints remain explicit.

The category counts prevent the loot-heavy aggregate from hiding long controls:

| Category | Attempts per body | Previous contestant / hunter effects | Candidate contestant / hunter effects |
| --- | ---: | ---: | ---: |
| Spawn–exit | 198 | 60 / 76 | 72 / 80 |
| Spawn–charger | 297 | 31 / 33 | 65 / 76 |
| Charger–loot | 864 | 46 / 43 | 71 / 65 |

All 66 spawn–exit attempts on the three small maps have zero effects per body.
The largest seed-1 map also has zero contestant spawn–exit effects. Eight maps
have physical joins, totaling 9,401 world units; that is not an encounter
denominator or a claim that the typical-traversal requirement is satisfied.
No arbitrary detour-p90 or percentage pass threshold is introduced.

[`summary.json`](summary.json) retains every map/body/category, actual-target
denominator and final status. Its `typePairs` includes all eligible type pairs,
including zero joins: eligible seam length, contact length by owner type,
joined length, both bodies' blocked-sample denominators, contiguous blocked-span
counts and maximum lengths. The full raw spans and routes are in the archive.
Blocked half-cell spans remain sampled crossing diagnostics, not exact
continuous-space impassability intervals.

## Why further density tuning is not the next action

The initial loose [exposure audit](exposure.json.gz) finds 794/1,359 contestant
and 830/1,359 hunter routes touching selected owners' eligible seam cells. An
even looser full-fill ceiling is 978/961. These are optimistic opportunities,
ignoring access, spacing, opposing content and siting; neither establishes that
new physical joins can actually be made.

The tighter [contact-opportunity audit](opportunities.json.gz) holds the other
builders and block plans fixed. An unmodified opposite owner must already have
static obstacle contact; a depot child can change a block parent's contact only
where that child's allowed fill reaches the seam. It finds **zero possible
positive static joins for all 63 eligible depot/market seam cells in
`size-12-1`**. The opposite sides have no contacts of any kind. Nine of those
seams face `block@114,78`, but none belongs to the allowed fill of its sole depot
child, `lot-5` (200 owned cells, 171 allowed fill cells). An independent read-only
review reconstructed this plan and verified the zero-contact result.

Thus increasing the selected builders' density cannot remove this map's zero.
This is a limitation of the **chosen two-family scope on these unchanged
inputs**, not proof that incidental cross-region obstacles are impossible or
that guarantees must be weakened. It applies to the declared top-level
depot/market interface metric, not all internal barriers or all possible family
selections. Of the 3,883 eligible spans across the panel, 3,859 are one cell;
the remaining 24 are two cells.

The next design review should reassess the two-family selection and a composition
whose required-access proof scales before another implementation. Do not add
more families to this prototype, weaken 20.6, replace the fixed panel, redefine
encounters to force a pass, or resume optional #743 overhead work automatically.
This pass stops at that concrete selection/readiness boundary.

## Access, determinism and scale

Independent final checks cover **121 direct owners plus all 21 block parents**:
zero fill errors, zero thorough portal failures and zero saved/repeat/reordered
build differences. All **38,831 actual contestant loot targets** have swept
access witnesses. Hunter diagnostics at the larger SDK cell profile retain
**32,008 witnesses / 6,823 invalid targets**; hunter loot access is not the
contestant target promise. Full paths are retained separately from old targets.
See [validation.json](validation.json) and the compressed per-map records.

The original cached prototype's instrumented scale probe reaches access
initialization in about 154 ms, including 339 initial routes, then hits its
10-second cap during incremental placement. The retained trace reaches more
than 1,100 route witnesses and 16,000 swept proof shapes, with many 100–150 ms
preparations. This locates the observed cost after initialization; it does not
by itself attribute every preparation to one internal phase. Diagnostic logging
adds overhead, so these values are not a timing comparison.

A **separate**, one-file [local repair candidate](local-repair.ts.txt) stores
witness points and tries a short reconnection across the padded bounds of added
geometry before falling back to the original full-endpoint search. Unchanged
prefix/suffix segments lie outside those bounds. Exact swept search, fallback,
target registration and atomic commit remain in place. It matches all 142 frozen
outputs, both typechecks and all nine access/rollback tests; another 284
repeat/reordered builds match too. It changes only `content-access.ts` in the
302-file source audit. Local search can discover a valid route the conservative
full-root lattice misses on other inputs; this is not a universal byte-equivalence
claim beyond the frozen corpus.

| Unchanged 200×150 depot witness | Pair 1 | Pair 2 | Pair 3 |
| --- | --- | --- | --- |
| Cached original prototype | 10 s cap | 10 s cap | 10 s cap |
| Same content with local witness repair | 10 s cap | 10 s cap | 10 s cap |

The original >10 warehouses, >100 rows and 3-second assertion are unchanged.
Attempts run as one locked sequence, alternate pair order, and use isolated
child processes with test isolation disabled so timeout cannot orphan a test
worker. No task tests, browser work or other task benchmarks run during these
comparisons. Cooperating comparisons use the machine lock; external load,
hardware and power configuration were not measured. Capped attempts have no
completion duration or speedup. [local-scale.json](local-scale.json) retains all
six results; [local-verification.json](local-verification.json) retains checks.

**Local repair is not a scale fix and is not adopted.** This experiment uses the
original frozen content, not the new frontage candidate. Frontage capture build
times are single observations of rebuilt owners only, excluding unchanged
owners/macro/composition; they are not a paired cost comparison or a scale pass.
The frontage candidate has no separate successful macro-scale evidence.

## Inspection, checks and reproduction

Gunzip [inspector.html.gz](inspector.html.gz) to a standalone HTML file for all
nine before/after maps, both bodies, ownership, guarantees, physical contacts,
eligible seams, complete routes, failures and zeros. Representative images:
[large full map](preview/size-36-1-full.png),
[24-size joined close-up](preview/size-24-1-joined.png), and
[small zero-join example](preview/size-12-1-joined.png).
The small example reports no joined seam and retains the eligible-seam view.

Headless Chrome checked all 36 map/panel/body states, each with 151 route
options, full/eligible/joined controls, and failures/zero-hit choices. Nine
states expose failure choices; no page/console errors occur. Six screenshots
were inspected. [QA metadata](preview/result.json) pins the HTML, script and
browser version. Computer-use browser surfaces were unavailable; the existing
project Playwright dependency supplied this software-test fallback.

`npm run check`, prototype frontage typechecking and the 19 focused builder
contract tests pass. The local-repair typechecks/access tests, all-owner final
checks, source audits and deterministic rebuilds are separate recorded checks.
No canonical runtime code changes, so the fast/micro/full-chain/simulation suites
were not rerun for this report-only change. Full new 51.10 navigation metrics,
current-main appearance/integration, final content/version expectations and
baseline capture remain adoption gates; rejected candidates are not promoted
through those gates. The frozen gameplay fixture is untouched. Before any
future adoption, also reconcile the route-search query/clearance signature with
an options object as recorded in #716 comment 8552.

Run from this PR's checkout; every output path must be fresh. `setup.mjs` prints
`SNAPSHOTS`. Make `EXTRACTED` first and extract the original immutable evidence:

```text
node docs/reports/issue-724/setup.mjs
tar -xzf SNAPSHOTS/control/docs/reports/issue-716/evidence.tar.gz -C EXTRACTED
node docs/reports/issue-716-readiness/frontage-prepare.mjs SNAPSHOTS/batch FRONTAGE
node docs/reports/issue-716-readiness/capture.mjs FRONTAGE EXTRACTED PANEL
node docs/reports/issue-716-readiness/effects.mjs FRONTAGE EXTRACTED PANEL EFFECTS SUMMARY.json
node docs/reports/issue-716-readiness/validate.mjs FRONTAGE PANEL VALIDATION
node docs/reports/issue-716-readiness/exposure.mjs SNAPSHOTS/batch EXTRACTED EXPOSURE.json
node docs/reports/issue-716-readiness/opportunities.mjs SNAPSHOTS/batch EXTRACTED PANEL OPPORTUNITIES.json.gz
node docs/reports/issue-716-readiness/local-repair-prepare.mjs SNAPSHOTS/batch LOCAL
node docs/reports/issue-716-readiness/local-check.mjs LOCAL IDENTITY.json
node docs/reports/issue-716-readiness/scale-check.mjs SNAPSHOTS/batch LOCAL SCALE.json
node docs/reports/issue-716-readiness/verify.mjs LOCAL VERIFICATION.json
node docs/reports/issue-716-readiness/source-audit.mjs SNAPSHOTS/batch FRONTAGE LOCAL SOURCES.json
node FRONTAGE/tools/incidental-seam-view.mjs EXTRACTED/baseline-corrected PANEL EXTRACTED/baseline-routes PANEL VIEW.html
node docs/reports/issue-716-readiness/browser-check.mjs VIEW.html BROWSER_OUTPUT
```

[`evidence.tar.gz`](evidence.tar.gz) contains `issue-716-frontage-panel-v2`
(full captures, endpoints, source manifest, raw seams/routes),
`issue-716-frontage-effects`, `issue-716-frontage-validation` and
`issue-716-scale-diagnostic`. It does not replace or duplicate the old frozen
corpus. Full saved results carry the explicit experimental identity
`issue-716-readiness-frontage-1`; ordinary omitted-result regeneration must not
substitute current production engines. Artifact digests are in
[`artifacts.json`](artifacts.json).
