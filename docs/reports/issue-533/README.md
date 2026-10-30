# Depot composition audit (#533)

`baseline.json.gz` captures production outputs and observer traces for all twelve
retained authored depot briefs from #663, plus a 6x6 no-fit and an isolated
zero-density case. It records the commit and raw SHA-256 inventory of the measured
micro/kernel/shared TypeScript, verified unchanged across capture. The twelve
production outputs exactly match the corresponding output hashes in #663.

Run `node tools/depot-composition-audit.mjs` after implementation to produce
`comparison.json.gz`. An optional first argument selects the output path; an
optional second argument filters workload names for a smoke run. The report binds
the baseline and audit hashes, current source inventory and tracked dirty state,
retains full current output/traces and per-case measurements. It refuses changes
to the measured sources during capture. For the authored baseline, geometry
checks are reused from #663 only after matching the full output hash; fallback
cases are evaluated directly. Current diagnostics use the resulting collision
geometry, not candidate-admission evidence.

Warehouse envelope and roof area are cell counts. Fill reports occupied area;
manifest reports rows, infill crates and loot. Thorough portal/fill errors,
actual exterior door standing squares and every allocated room are retained.
Doorstep route checks start at the nearest portal stand and room checks at the
first exterior stand; a failure diagnoses that sampled route and does not prove
that all possible entrances fail. A null doorstep route means there is no portal.
The sample covers one map per authored size and is not a seed sweep.

Run `node tools/depot-composition-audit.mjs --visual` to regenerate the twelve
paired SVG previews in `index.html.gz` and an uncompressed local copy at
`test-results/533-depot-composition.html`. This does not rerun geometry checks.

## Results

| Authored map | Depots | Warehouses | Envelope / roof cells | Occupied cells | Rows | Crates | Loot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12x6 | 2 | 7 → 14 | 336 → 672 | 370 → 481 | 32 → 17 | 29 → 29 | 70 → 51 |
| 24x12 | 5 | 13 → 24 | 624 → 1,152 | 708 → 843 | 65 → 34 | 53 → 53 | 144 → 124 |
| 36x18 | 5 | 37 → 72 | 1,776 → 3,456 | 2,139 → 2,463 | 211 → 94 | 144 → 141 | 453 → 417 |
| Total | 12 | 57 → 110 | 2,736 → 5,280 | 3,217 → 3,787 | 308 → 145 | 226 → 223 | 667 → 592 |

Before and after both have zero thorough portal/fill errors, zero failed sampled
exterior stands (210 before, 404 after), and zero failed room checks (138 before,
266 after). The no-fit and zero-density cases retain their exact prior output.
The 756-cell `depot@318,30` has 2 → 4 warehouses and 6 → 0 rows; its occupied
cells rise 90 → 114 and infill crates 6 → 10. The #663 fixed control retained
2 warehouses and 6 rows under a full exterior ring, suggesting the increased
warehouse quota contributes to this case's row loss; its other policy differences
prevent a clean causal attribution. Other cases retain at least two rows.

After diagnostics, the registry version and explanatory depot comments changed.
`node tools/depot-composition-audit.mjs --rebind` verified all fourteen complete
outputs against the captured results without rerunning the geometry routes;
`final-source-verification.json` preserves the diagnostic and final inventories,
changed paths, and each output hash. The script gained the separate visual branch
while the original diagnostics ran; their calculation was not changed.

For later checkout verification, run `node tools/depot-composition-audit.mjs
--verify`. It verifies retained baseline and comparison hashes, the final tool
and complete micro/kernel/shared TypeScript inventory with CRLF normalized to LF
(and no other whitespace changes), then rebuilds and compares all fourteen full
outputs. The normalized inventory and tool hash live in
`final-source-verification.json`; the original raw-byte diagnostic and final
inventories remain historical evidence. `--rebind` is a capture-time bridge and
compares raw bytes; use `--verify` for clean checkouts with different line endings.
Verification does not rerun the expensive room-route diagnostics.
