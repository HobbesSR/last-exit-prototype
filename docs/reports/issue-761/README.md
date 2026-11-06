# Fixed-layout portal-pitch and cap probe (#761)

Measurement only, alongside #837. Neither candidate is approved for adoption.
Direction: [17.2.11](../../17.2.11-navigation-structure-direction.md); existing
margin contract: [20.6](../../20.6-passable-margins.md); motivation and earlier
panel: [42.34](../../42.34-edge-clearance.md).

## Scope and definitions

The tool generates only macro placement for the three #688/#836 panel seeds,
`size-12-1`, `size-24-1`, and `size-36-1`, with the same parameters and cell size
48. It holds placed tiles, orientations, resolved classes, and region owners
fixed. It changes a copy of the **resolved guarantee view**, not authored tile
files, and does not solve a candidate library. This deliberately isolates the
seam-length and margin effects. It cannot establish that a changed authored
library places successfully, retains its graph proof, or produces physical
barriers and longer routes. No builders run.

Each seam unit is one cell side between different owners, counted once.
Runs are maximal straight stretches with the same two owners, split at a
guaranteed segment, corner, or change of owner pair, matching 42.34's seam
definition. Map edges and same-owner internal segments are excluded from seam
length. Internal guarantees still contribute their margin footprints.

- **Authored unguaranteed** means the unguaranteed runs induced by the baseline
  authorship or hypothetical changed guarantee view. The name distinguishes
  the structural run from its currently fillable portion; counterfactuals are
  not saved authored libraries. Its 6+ share is seam units in runs at least six
  cells long divided by all unguaranteed seam units in that variant.
- **Fillable** means both incident cells survive the clear footprint. Its 6+
  share uses fillable seam units as the denominator. The report also supplies
  `fillable6PlusShareOfUnguaranteed`, whose denominator is all unguaranteed seam
  units, so a growing candidate denominator cannot hide reduced fillability.
  Fillable is permission to build, not a claim that builders can or will block
  that whole run while meeting their portal obligations.

## Explicit candidates

1. `baseline`: unchanged guarantees and 20.6 whole-cell caps.
2. `caps-stop-at-hints`: unchanged guarantees; omit only a cap's contribution
   to a cell beside the immediately adjacent **hinted, unguaranteed segment**.
   Every side strip remains. Caps beside unstated segments remain. Union all
   other contributions normally: a perpendicular or overlapping guarantee can
   still clear a cell. The implementation derives contributions per guaranteed
   unit segment, as permitted by 20.6. This is whole-cell cap clipping, not a
   fractional setback or new legal margin rule.
3. `remove-side-parity-0` and `remove-side-parity-1`: remove all guaranteed
   halves on selected physical six-cell tile sides. Baseline sides already
   often have one guaranteed half, so this tests **zero halves on a subset of
   sides**, not reducing two halves to one everywhere. For horizontal units,
   require `y % 6 == 0` and select `(y/6 + floor(x/6)) % 2 == phase`;
   for vertical units swap x and y. Replace each selected guaranteed segment's
   view with mutual `not-passable-hint` and no guarantee, from both owners at
   once. Leave tile interiors and already unguaranteed segments unchanged.
   Complementary phases expose the arbitrariness of this spatial selection.
   Counts of removed units and affected tile sides are retained. Those counts
   include same-owner guarantees on tile sides as well as different-owner
   portal segments; the former also release margin cells.
4. Both parity variants combined with `caps-stop-at-hints`.

These are counterfactual spatial masks, not a proposal for a context-sensitive
tile prescription or a decision to remove a particular portal. Connectivity
components, proof failures, and short portals are recorded for each variant;
the production rules are used, without repair. An invalid candidate is still
useful for measuring this lever but cannot be adopted as measured.

## Turning witness

The tool reuses the geometry and movement helpers from the existing
`tests/map-passable-margins.test.js` corner witness, at cell sizes 40 and 48.
Two perpendicular guaranteed runs begin at `(1,1)`; their preceding segments
are hinted. A legal fill obstacle occupies `[2,6] × [2,6]` cells in the owning
region. A hunter must turn from `(4,1)` to `(1,4)` in cell coordinates. Full caps
clear `(0,0)` and supply the outside corner. Stopping caps at the hints removes
that cell from guaranteed context. Other strips still clear `(0,1)` and `(1,0)`.

The check records swept corner legs and a swept route search at the SDK's
0.925-cell hunter clearance, and replays a successful route through actual
`moveBody`/`canOccupy` with the same radius. Losing `(0,0)` permits a third owner
to fill it; the resulting diagonal gap to the interior obstacle is only
`sqrt(2)` cells, below the required 1.85-cell diameter (and even the unpadded
1.75-cell body diameter). This is a concrete obstruction witness, not a claim
that every shortened cap fails. It means universal clipping cannot inherit
20.6's turning argument unchanged. Geometry-aware replacement clearance would
need its own contract and acceptance work.

## Reproduction and provenance

Run from the repository root:

```sh
node map/tools/seam-pitch-probe.mts --out docs/reports/issue-761/seam-pitch.json
```

The tool refuses an existing output unless `--replace` is explicit. The JSON
retains the code revision, Node version, LF-normalized tool SHA-256, layout and
resolved-view hashes, library fingerprint, exact per-map parameters, all six
variants, and both turning witnesses. Layout hashes use `JSON.stringify` of the
macro Layout object, not chain-map JSON; they are not comparable to #836's
whole-map hashes.

Inline assertions check the unchanged baseline against the kernel footprint
and every actual macro brief's fill cells, confirm clipping cannot change
structural unguaranteed run lengths, verify the original resolved view was not
mutated, and verify the positive/negative turning witness. These are probe
self-checks, not a new fast-tier test file or a production content baseline.

## Results

Captured at `c96e24fb776c274b0b715aed8376660234c3a208`, Node v24.15.0,
with only the new probe involved in this measurement. The concurrent #837
helper changes do not run on this macro-only path. Tool SHA-256 (LF):
`dd190a0498b849ab51a56d12a498cb98fa8633674e3cf0091824840f9ca109fe`.
The retained [JSON](seam-pitch.json) supplies all integer counts.

Percentages below have three distinct denominators: **authored 6+** is the
share of all unguaranteed seam units in structural runs of 6+; **fillable 6+**
is the share of fillable seam units in contiguous fillable runs of 6+;
**fillable 6+ / all** uses all unguaranteed seam units instead. **Fillable / all**
is the fraction of unguaranteed seam units with both cells fillable, regardless
of run length. P0 and P1 are the complementary thinning phases above.

| Size | Variant | Authored 6+ % | Fillable 6+ % | Fillable 6+ / all % | Fillable / all % | Graph components |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 12 | Baseline | 3.90 | 0 | 0 | 35.28 | 1 |
| 12 | Caps stop at hints | 3.90 | 0 | 0 | 62.40 | 1 |
| 12 | P0 | 55.15 | 11.03 | 7.32 | 66.36 | 3 |
| 12 | P0 + caps | 55.15 | 17.56 | 13.32 | 75.84 | 3 |
| 12 | P1 | 53.83 | 14.60 | 9.57 | 65.51 | 3 |
| 12 | P1 + caps | 53.83 | 20.18 | 15.33 | 75.97 | 3 |
| 24 | Baseline | 3.72 | 0 | 0 | 34.25 | 1 |
| 24 | Caps stop at hints | 3.72 | 0 | 0 | 58.11 | 1 |
| 24 | P0 | 50.38 | 9.25 | 5.83 | 63.05 | 5 |
| 24 | P0 + caps | 50.38 | 13.82 | 10.00 | 72.35 | 5 |
| 24 | P1 | 49.64 | 9.25 | 5.81 | 62.76 | 2 |
| 24 | P1 + caps | 49.64 | 13.99 | 10.09 | 72.09 | 2 |
| 36 | Baseline | 4.94 | 0 | 0 | 34.04 | 1 |
| 36 | Caps stop at hints | 4.94 | 0 | 0 | 58.86 | 1 |
| 36 | P0 | 51.21 | 11.12 | 7.03 | 63.20 | 2 |
| 36 | P0 + caps | 51.21 | 15.69 | 11.41 | 72.70 | 2 |
| 36 | P1 | 52.10 | 11.27 | 7.07 | 62.72 | 3 |
| 36 | P1 + caps | 52.10 | 15.43 | 11.12 | 72.08 | 3 |

Baseline seam counts exactly reproduce 42.34: 2,154 / 8,388 / 16,881 units.
At 36, 834 units lie in structural 6+ runs and 5,747 units are fillable on both
sides. The contiguous fillable stretches are still only one or two cells long.

**Clipping caps does not make structural runs longer.** It raises available
edge, but even the baseline's long structural runs remain split by the union of
other guaranteed strips/caps. At 36, it releases 4,189 additional two-sided
fillable seam units, taking 5,747 to 9,936, without creating any fillable 6+ run.
It also fails the turning witness at both tested cell sizes: full caps have
clear swept legs, a found route, and successful actual movement; clipped caps
have none of those three witnesses. The narrow-gap calculation above explains
why this particular negative result is more than a grid-search miss.

**Fewer guaranteed sides can expose much longer structural runs**, about
50–55% of unguaranteed seam length in this panel. Remaining guarantees still
fragment fillable runs substantially. At 36, thinning without cap changes makes
1,977 / 1,997 units part of fillable 6+ runs; combining both candidates makes
3,208 / 3,143. The complementary phases give similar aggregate shares, but
both disconnect the guaranteed graph on every sampled map. All baseline/cap
variants have zero proof violations; thinned variants have one fewer proof
violation than their component count. Every variant has zero short-portal
violations. Longer unguaranteed runs alone do not preserve macro inference.

This ends the probe. It demonstrates a lever and two constraints: selective
authorship must retain graph connectivity, and shortened caps need a replacement
turning argument. It selects neither candidate for adoption. Re-placement,
builder content, actual seam blockage, long-route detour and representative
frequency remain unmeasured. One seed per size and complementary spatial masks
are a bounded sensitivity check, not a seed sweep or authored-library result.

Actual validation:

```sh
node map/tools/seam-pitch-probe.mts --widths 12 --out docs/reports/issue-761/check-12.json
node map/tools/seam-pitch-probe.mts --out docs/reports/issue-761/seam-pitch.json
npx tsc -p map/tools/tsconfig.json --noEmit
```

All passed. The temporary 12-wide capture matched the full capture's first
map and turning results, and was removed. No production or test-tier change is
made by these new tool/report files; no content version, frozen fixture or
chain baseline was updated.
