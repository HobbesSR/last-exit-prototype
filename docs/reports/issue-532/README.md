# Issue 532: authored hut capacity sample

This report compares the checked-in hut strategy at revision `5077596` with the
working tree after the multi-house change. It samples one deterministic generated
map for each bundled authored zone size, using seeds `size-12-1`, `size-24-1`,
and `size-36-1`. It is a useful authored-site witness, not a seed sweep or a
claim about every map.

## Results

| Zone size | Huts | Houses before → after | Multi-house huts after | Owned cells | Fill cells | Physically occupied cells before → after | Summed house-envelope area after* | Report defects | Hut reach errors | No-fit huts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 12×6 | 3 | 3 → 3 | 0 | 180 | 121 | 27 → 27 | 33 cell-equivalents | 0 | 0 | 0 |
| 24×12 | 22 | 22 → 60 | 13 | 2,538 | 1,379 | 245 → 466 | 599 cell-equivalents | 0 | 0 | 0 |
| 36×18 | 43 | 43 → 113 | 24 | 4,734 | 2,582 | 462 → 877 | 1,143 cell-equivalents | 0 | 0 | 0 |

“Physically occupied” is `owned cells - free cells` from `measureFill`; a cell is
occupied when a generated obstacle intersects it. It measures the geometry's
actual footprint, not the hut's fill mask. “House-envelope area” sums each
enclosing element's rectangular `template.w × template.h`, converted to
48×48-world-unit cell equivalents. It includes the walls' full rectangular
envelope, including interior floor, and is not an additional occupied-cell
count. Before house-envelope bounds were not captured, so the report does not
claim a before/after change in house-envelope area.

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
lead's pre-edit run reported `freeShare=0.897`, `gapCellsShare=0.684`, and
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
