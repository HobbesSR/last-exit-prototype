# Edge clearance measurement (#836)

The findings are in [42.34](../../42.34-edge-clearance.md), and the definitions are in
[51.10](../../51.10-measurement.md) ("Edge clearance").

- `edge-clearance.json` is the `edge-clearance-1` report for `size-12-1`, `size-24-1` and
  `size-36-1`, with #688's parameters at cell size 48. For each map it gives blocked shares by
  side class, per type and hint split, the attribution of walkable unguaranteed samples, seam
  runs and internal guaranteed runs, all for both bodies. Each map's `source` is the SHA-256
  of its generated chain JSON. `revision` is the main commit measured, `6ac2b5c`, with only
  this tool added.
- `park-bays.json` holds the #758 check: the three #649 park examples, before and after
  fronts, each isolated and with an open two-cell ring, at 51.10's pocket thresholds and at a
  relaxed set. `park-bays.mts` produces it.

To reproduce, run from the repository root with Node v24.15.0:

```sh
node map/tools/edge-clearance.mts --widths 12,24,36 --out edge-clearance.json   # about 75 s; generation dominates
node docs/reports/issue-836/park-bays.mts --png DIR                              # PNGs need system Chrome
```

The source SHA-256 values (LF) at capture were:

- `map/tools/edge-clearance.mts`: `28e6b32b8c34600c137ed23c6d891b6d1f7a0472790c22cc4b1d9521a1743d28`
- `docs/reports/issue-836/park-bays.mts`: `00a96a9465eefd65cc6c9bbee17143d751cd3f74d5ec227778698b01d03d1549`

The maps are regenerated rather than retained, and the hashes identify them. Generated
content after a content version change will differ, so keep this report and record new
captures beside it rather than replacing it. The authoring check for #762 ran against
`diamond-12x6`, `diamond-24x12` and `diamond-36x18` with the command in 52.
