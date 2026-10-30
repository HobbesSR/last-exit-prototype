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

## Integration and verification

- `npm run check` and `npm run typecheck` pass.
- Final `npm test` passes all 1,292 tests. The live-map ID pins are updated for
  intentional warehouse geometry/loot changes; uniqueness, ordering and
  multi-room roof-group assertions remain intact. The frozen simulation
  characterization fixture is unchanged.
- Focused depot tests and the depot builder-contract row at `BUILDER_SEEDS=20`
  pass. `test:times` measures the grown depot, infill and new composition files
  at 9.5, 0.5 and 3.5 seconds, below the 15-second file budget.
  The updated live-map roof/ID file measures 9.8 seconds in isolation.
- `npm run test:micro` passes 523 unit tests and all four browser previews.
- The selected slow library files pass all five tests: 25 default-size maps,
  one whole-map portal diagnostic and five maps each at 24x12 and 36x18.
- The full pre-capture sweep checks 224 maps in 116 seconds. All results
  identities change, 157 built/report views change, and no upstream view changes.
  `integration.json` retains full-map report/portal diagnostics for every one of
  those 157 changed maps: zero defects or broken promises, 534 seconds.
- The 224-map baseline is captured from `7f171253` at
  `2026-10-30T03:06:09.011Z` in 111 seconds, with no generation errors.
  An independent full check passes all 224 maps with zero drift in 149 seconds
  (`sweep-final.json`). Capture provenance is owned by 42.4 and 53.
- `clean-checkout-verification.json` records successful fourteen-output, source,
  tool and artifact verification in clean LF and CRLF clones of the content
  commit, using existing installed dependencies. The three retained PNGs were
  inspected in headless Chrome at 1500x1400; these are collision/composition
  previews, not art or balance acceptance.

To replay the changed-map diagnostics, decompress `sweep-before.json.gz` into
`test-results/533-sweep-before.json`, then run
`node tools/depot-composition-integration.mjs` at the content commit. The script
accepts both UTF-8 and the retained PowerShell UTF-16LE log encoding. Its source
inventory must remain unchanged across the run. The independent authored access
audit is `node tools/depot-composition-audit.mjs`; its portal and room searches
take several minutes. `node tools/builder-fill.mjs --types=depot --seeds=3
--width=40 --height=30 --json=1` reproduces the separate synthetic fill sample:
three built, zero failed, free share 0.829 and largest diagnostic gap 160 cells.

The whole slow tier, simulation/physics match sweeps, full main-game browser suite,
macro suite and general benchmarks are omitted under 31's single-builder scope.
No frozen gameplay fixture, placeable geometry, dependency, macro/library input or
experimental execution version changes. Structural hall wings remain open under
#533; further depot pocket filling and the costly movable-cord rollout are deferred.
