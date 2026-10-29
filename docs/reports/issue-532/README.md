# Issue 532: authored hut capacity sample

This report compares the checked-in hut strategy at revision `5077596` with the
uncommitted working tree after the multi-house change on 2026-10-29.
The final content checkpoint is `c3d79be`; no exact dirty-tree digest was
recorded for the measurement. Node was v24.15.0. These are counts and geometry
checks, with no timing comparison or hardware-performance claim. It samples one deterministic generated
map for each bundled authored zone size, using seeds `size-12-1`, `size-24-1`,
and `size-36-1`. It is a useful authored-site witness, not a seed sweep or a
claim about every map.

## Results

| Zone size | Huts | Houses before → after | Multi-house huts after | Owned cells | Fill cells | Physically occupied cells before → after | House-envelope cells before / after | Report defects | Hut reach errors | No-fit huts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 12×6 | 3 | 3 → 3 | 0 | 180 | 121 | 27 → 27 | 33 / 33 | 0 | 0 | 0 |
| 24×12 | 22 | 22 → 60 | 13 | 2,538 | 1,379 | 245 → 466 | 257 / 599 | 0 | 0 | 0 |
| 36×18 | 43 | 43 → 113 | 24 | 4,734 | 2,582 | 462 → 877 | 513 / 1,143 | 0 | 0 | 0 |

“Physically occupied” is `owned cells - free cells` from `measureFill`; a cell is
occupied when a generated obstacle intersects it. It measures the geometry's
actual footprint, not the hut's fill mask. “House-envelope area” sums each
enclosing element's rectangular `template.w × template.h`, converted to
48×48-world-unit cell equivalents. It includes the walls' full rectangular
envelope, including interior floor, and is not an additional occupied-cell
count. The original baseline run did not capture envelope bounds. A separate
[envelope comparison](envelope-comparison.json) replays the historical hut module
from `5077596` with current supporting modules on these unchanged briefs. It
verifies exact primary-house equality in all 68 huts and every current actual
doorstep against final combined geometry. The resulting envelope totals are in
the table; these are house addressed intent, excluding cover and empty yard intent.
The historical replay is not a full old-checkout reproduction.

The after build also produced no report defects, no hut portal-reach errors, and
no no-fit hut regions in these samples. Representative multi-house regions are
`hut@162,72` (24×12, four houses, 144 owned / 78 fill cells),
`hut@714,192` (24×12, five houses, 252 / 142), `hut@558,6` (36×18, four
houses, 144 / 72), and `hut@630,462` (36×18, two houses, 84 / 36). The full
per-hut records, including each house's bounds, live in [before-after.json](before-after.json).

## Reproduction

The before snapshot was made from the repository source at `5077596`; the after
snapshot used the working tree. Both use `CELL_SIZE=48`, eight contestants,
two exits, three hunters, loot chance `0.04`, loot tier step `0.09`, and each
size's matching bundled library. The generation call was `generateChainMap(seed,
params, library, 48, engines)`, where `engines` uses the current
`REGION_TYPES_VERSION` and `buildRegion`. The per-hut fill values use
`measureFill(brief, elements)`. The after run additionally checked
`mapViews(map, composeRegions).report.defects` and
`validatePortalReach({...brief, blockers: elements.flatMap(element =>
elementShapes(element))}).errors` for every hut.

The builder-fill diagnostic command was:

```powershell
node tools/builder-fill.mjs --types=hut --seeds=3 --width=24 --height=18 --json=1
```

The after result was `built=3`, `failed=0`, `freeShare=0.769`,
`gapsPerRegion=4.33`, `gapCellsShare=0.347`, and `largestGapCells=72`. The
pre-edit run reported `freeShare=0.897`, `gapCellsShare=0.684`, and
`largestGapCells=140` (same command and options). These synthetic rectangular
briefs are a separate diagnostic from the authored maps above.

To repeat the authored after sample, run this from the repository root with
Node's TypeScript support:

```powershell
node docs/reports/issue-532/reproduce.mjs
```

The JSON in this report includes the full sampled per-hut counts and available
post-change house bounds. The baseline was generated before edits from source
revision `5077596`. The reproduction script follows the same parameters and
checks for the after snapshot. It records only these three seeds; broader
generation sweeps and the normal type-specific tests remain separate
verification.

To repeat the historical envelope comparison and current doorstep checks:

```powershell
node docs/reports/issue-532/envelopes.mjs
```

This writes `envelope-comparison.json` and removes its temporary historical module
from a fresh directory under `test-results/` after the run. Its counts can be compared with the separate original before/after record.

## Integration diagnostics

[Raw sweep drift and full-map diagnostic results](integration.json) pin content
commit `c3d79be`. The full 224-map pre-capture sweep changed results on all maps,
built geometry on 199, and reports on 193. No upstream view changed. All 199
cases with built drift were regenerated and checked with
`checkMap(generate(seed, params), { diagnose: true })`, the same checker used
by CLI `validate --diagnose true`; all passed with no report defects or broken
portal promises. The pinned case parameters are in the baseline provenance;
the raw record lists each case/seed checked. Wall times in this record are
verification run durations with other checks running, not timing comparisons.

The micro unit gate passed all 513 tests. After updating the browser's single-house
trace assumption, all four micro browser scripts passed individually. The five
selected slow library tests passed (25 default-size maps, five each at 24 x 12
and 36 x 18, plus the default-size all-region diagnostic). Typecheck and syntax
checks passed. New multi-house tests measured 2.2 seconds in `test:times`.

The 224-map recapture pins `c3d79be67e7e22a6837c846c31d449d555597f23`,
`2026-10-29T21:24:35.167Z`, Node v24.15.0, with no generation-error entry.
The recorded command is `node map/tools/cli.mts sweep --out
map/tools/fixtures/chain-baseline.json` (100 s). The final fast suite runs after
this capture and verifies its quick-case hashes.

Comparing the captured hash sets with the independent pre-capture run matches
all 224 exactly; this verifies the capture without a third regeneration pass.

Final `npm test`: 1,276 passed, zero failed (149 s). The first full run found
seed 2's expected generated-ID pin changes; those expectations were updated for
the deliberate content change, keeping the ID-order assertions. That run also
had an early client-config test-process exit without a diagnostic. Its isolated
rerun passed both tests, and the subsequent full suite passed without recurrence.
The cause of that initial process exit is unknown.
