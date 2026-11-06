# Edge clearance measurement (#836)

The findings are in [42.34](../../42.34-edge-clearance.md), and the definitions are in
[51.10](../../51.10-measurement.md) ("Edge clearance").

- `edge-clearance.json` is the `edge-clearance-1` report for `size-12-1`, `size-24-1` and
  `size-36-1`, with #688's parameters at cell size 48. For each map it gives blocked shares by
  side class, per type and hint split, the attribution of walkable unguaranteed samples, seam
  runs and internal guaranteed runs, all for both bodies. Each map's `source` is the SHA-256
  of its generated chain JSON. `revision` is the main commit measured, `6ac2b5c`, with only
  this tool added; the capture was committed as `dd5b600`. The report is unchanged after the
  boundary sampling moved into `navigation-structure.ts` (`boundarySamplesOf`), which both
  reports now share.
- `park-bays.json` holds the #758 check: the three #649 park examples, before and after
  fronts, each isolated and with an open two-cell ring, at 51.10's pocket thresholds and at a
  relaxed set. `park-bays.mts` produces it.

To reproduce, run from the repository root with Node v24.15.0:

```sh
node map/tools/edge-clearance.mts --widths 12,24,36 --out edge-clearance.json   # about 75 s; refuses an existing file without --replace
node docs/reports/issue-836/park-bays.mts --png DIR                              # PNGs need system Chrome
```

The source SHA-256 values (LF) at capture were:

- `map/tools/edge-clearance.mts`: `59859f122cfcb22a04ee8de880230e1d09a8075326ec35808f4af81d0f66d551`
- `map/tools/navigation-structure.ts` (shared sampling): `8181f6894ca080915b94b008dd2d3f1194b716af4bf10eb738660935b30d2a8c`
- `docs/reports/issue-836/park-bays.mts`: `00a96a9465eefd65cc6c9bbee17143d751cd3f74d5ec227778698b01d03d1549`

The maps are regenerated rather than retained, and the hashes identify them. Generated
content after a content version change will differ, so keep this report and record new
captures beside it rather than replacing it. The authoring check for #762 ran against
`diamond-12x6`, `diamond-24x12` and `diamond-36x18` with the command in 52.
