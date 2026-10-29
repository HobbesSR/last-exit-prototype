# Issue #647 adoption evidence

This directory preserves separate hut and compound measurements. Do not replace the original
files with a rerun. 42.3 owns durable findings; 20.7 and 53 own compatibility.

## Original hut-yard-2 milestone

`hut-cords.json.gz` contains the complete 98-case report generated from content
commit `bfb28be1f0470e9c04c2e56059e7f8106ae1325d`, retained in `97a58d8`.
`summary.json` is its derived per-case summary; `hut-cords.html` selects the 13
panels named by `retainedPanels` in that summary. The two original PNGs show
rectangle seed 1 and a production reroute. The HTML and summary are retained as
historical evidence, although the HTML is a large generated single line. Existing
Git-blob bytes are preserved; no current claim depends on regenerating them.

Original source: `test-results/hut-cords/{results.json,index.html}`. Command:
`node tools/hut-cord-audit.mjs --seeds=4 --maps --timing` at the original tool
revision, with pinned before hut `71a00c3` and current supporting modules. The
source tree's hut file was clean; report packaging/style changes followed.
The exact initial browser version was not recorded.

## Review response: hut-yard-3

`review.json.gz` preserves the new complete report from content commit
`faf7c19`, including every brief, before/after generation tree and result,
retention definitions and distributions, detached yard diagnostics, order
counterfactual and paired timings. `review-summary.json` keeps the aggregate
review data compact. New full HTML is generated locally, rather than committed.
`review-rectangle.png` and `review-minimum-yard.png` were rendered from the
retained report. The latter is the production case with the lowest retained
non-house-yard fraction.

Original source: `test-results/hut-cords-review/results.json`. Command:

```powershell
node tools/hut-cord-audit.mjs --seeds=4 --maps --timing --out=test-results/hut-cords-review
```

Workload: five synthetic shapes, seeds 1 through 4, plus every unique hut brief
from `issue330-before-12x6`, `issue330-before-24x12` and
`issue330-before-36x18`, using each authored zone size. This includes 78 production
huts, two nested in block lots. Baseline is hut source `71a00c3` with current
supporting modules; it is not a reconstruction of historical dependencies.
All final owner and containing reach checks use combined final blockers and
thorough search; fill checks use each owner's own physical geometry.

Timing: one warmup then three sequential before/after rounds, synthetic set
followed by the 29,584-cell / 228-portal fixture, under the machine-wide benchmark
lock. No other jobs from this task ran during timing. External CPU load was not
sampled; other agents share the machine. The macro outputs have different cover
uptake, so their timings are not equivalent-work comparisons. Runtime was Node
v24.15.0 on Windows x64; CPU/RAM identifiers and an exact measurement timestamp
were not embedded. New PNGs use headless Chrome 156.0.8078.49, viewport 1400 by
1000. The rendered report has 98 panels and no horizontal overflow.

Retained yard excludes owned cells touched by the realized house envelope from
both the original and retained yard counts. The fraction includes intentionally
open circulation and fixed approaches. It is evidence, not a percentage quota.
Candidate diagnostics distinguish static exclusions, probing and admission; the
sample has no tracker initialization/claim/population/settlement failures.
Original concave baseline findings remain in the complete report. A separate
check loads rectangular seed 1 from the retained original hut-yard-2 generation,
saves and reads a full snapshot unchanged, and verifies that omitted recovery
refuses the current hut-yard-3 implementation.

Regenerate the full current visual catalogue from retained data without building
maps, running validators, dispatching children or taking new timings:

```powershell
node tools/hut-cord-audit.mjs --render-from=docs/reports/issue-647/review.json.gz --out=test-results/hut-cords-review-render
```

The `--render-from` mode also accepts ordinary JSON, including the original
report after gunzip. It writes its expanded data and HTML under `--out`; leave
the retained files unchanged. Re-running generation is a new measurement and
will have new timing values; it must not be substituted for these retained bytes.

## SHA-256 of retained artifact bytes

| File | SHA-256 |
| --- | --- |
| `hut-cords.html` | `aaffee081ca6b0ec20c6145d06a1fec9971cffab0acb42dbba630f65f2dc65e3` |
| `hut-cords.json.gz` | `6d637e52c5177f43015d5d8a0500de6bee6ca7612b0f3830391118e666a8f5cc` |
| `production-reroute.png` | `fcfc08cfe4af03dd74a67034105dc073dc272131641e0843886c0cfbe4b0fdd5` |
| `rectangle-seed1.png` | `8eebd30bac5da976f82d4d691200103ae7165c877ff8184b20523b05bb4cf710` |
| `review-minimum-yard.png` | `c21d0faa5a4ec6bde945e9b9e8bfee744218efba2e97858c0911f06a4a0deada` |
| `review-rectangle.png` | `8474d7eb6d00208bcc3013d97de3dcf6799fcf1e64201856036011abca7c1f3e` |
| `review-summary.json` | `cfe8faaafe1b5667c8b1a0583f0e9df6110995ea515c22d9e8ba83a92c59d8f4` |
| `review.json.gz` | `4e6c4cdde4c7d15fefeb3a35f418ecd3e2d550c3d2b996f2f917159e1c8a31ff` |
| `summary.json` | `014bf8650b143ac5803b3e69b8dc5d351c8199dd8345741c0b5158d19a8f71dd` |

## Compound milestone: compound-yard-3

`compound-cords.json.gz` preserves all 38 paired inputs, owning generation trees,
results, diagnostics, allocation distributions and independent checks from
`test-results/compound-cords-final/results.json`. Content source is
`3d4106fff2ed12240b9741f3d7fc46343079f269`; baseline compound source is `ccb28eb`
loaded as a temporary sibling with current supporting modules. This does not
reconstruct historical dependencies. Production source was committed and clean;
the report records two tracked dirty files, documentation and a test-helper
comment, with no behavior difference. The root dependency lockfile is unchanged.

Workload: five synthetic shapes (small, rectangle, concave, holed, internal
margins), seeds 1?4, plus every unique top-level/nested compound from the three
same authored maps named in the hut section. There are 18 production inputs,
five nested in block lots. All owners and containing results pass thorough
portal checks against combined final blockers; fill checks use each owner's
own full physical footprint. Realized outer opening centers independently
determine both whole-cell gate stands for half-cell doors. Actual gates are
checked from their nearest original portal stand, with mesh fallback after a
grid miss (31). Full and omitted current snapshots, historical full snapshots,
historical omitted-version refusal and determinism all pass. The frozen
characterization fixture is unchanged.

`compound-summary.json` is the compact aggregate, with three selected case
summaries. The full report contains every result and no current failing check.
`compound-concave.png` shows peripheral and interior selection;
`compound-peripheral.png` shows the production 3-by-21 boundary slab;
`compound-open-yard.png` deliberately shows the largest production coverage
loss. These are collision/ownership previews, not roofs or art. Dashed amber
shows initial ring-envelope cords; blue shows independently checked final
gate-access routes. External portal promises are checked separately for every
owner and whole result. Chrome 156.0.8078.49, viewport 1400 by 1000, device scale
1; the 38-panel regenerated report has no horizontal overflow. Full HTML is
regenerated locally rather than committed.

The first audit used one global final cord graph and reported a budget miss
on `compound@276,330`; all final thorough portal checks passed. Preserve that
finding in `compound-gate-budget-finding.json.gz`: it contains the original full
failed record, its report provenance and the subsequent independent gate
recheck. Original local source remains `test-results/compound-cords/results.json`.
Its compound implementation is identical to the committed content source above;
only the gate-verification method changed. The recheck proves two gate routes
without increasing production/coordinator budgets. The corrected full audit
is new evidence, not replacement of an unexplained gameplay failure.

Commands, from the repository root:

```powershell
node tools/compound-cord-audit.mjs --seeds=4 --maps --out=test-results/compound-cords-final
node tools/compound-cord-audit.mjs --seeds=4 --timing --out=test-results/compound-cords-timing
node tools/compound-cord-audit.mjs --render-from=docs/reports/issue-647/compound-cords.json.gz --out=test-results/compound-cords-render
```

`compound-timing.json.gz` retains the separate synthetic timing run's complete
inputs/results and raw paired rounds. One warmup then three sequential rounds
run under the machine-wide benchmark lock, with no other jobs from this task.
The synthetic set has changed content (20 ? 68 children). The dense 30,000-cell,
170-portal fixture has zero children and unchanged ring both sides; current
initialization reports `budget` before any handoff probe. These are measured
slowdowns, not fixes. The raw timing report includes all thirteen eligible
macro offers and fallback diagnostics. Allocation, cost and coverage limits
are interpreted in 42.3; no hut-only percentage approval is generalized here.

Runs occurred on 2026-10-29, Node v24.15.0 on Windows x64. Exact audit/timing
start/finish timestamps, CPU/RAM identifiers and external CPU load were not
recorded; unrelated agents share the machine. The chain capture has its own
exact timestamp and source pin in 42.4. Retained gzip files use deterministic
mtime 0 and contain the source JSON bytes (the single finding is a faithful
extraction plus recheck). Original hut artifacts are untouched.

### Compound artifact SHA-256

| File | SHA-256 |
| --- | --- |
| `compound-cords.json.gz` | `4383a32bdf8004a801ed5fcd2f6221ef7d7ce250496168d9ced0d3ba19efc718` |
| `compound-timing.json.gz` | `3d28258d31b15e3f8bd85f974592863619e4ec26c2726aa7f83b31ba3fc62be3` |
| `compound-gate-budget-finding.json.gz` | `ee0762b6b9a1e2cb5f6c471baceb94984af70a43a296a6a55015d360c29fa7b1` |
| `compound-summary.json` | `0f14dbf453b163442cae7881dcd6c6b02a68470c3b2cb757d2223960f507e136` |
| `compound-concave.png` | `f7c57dba110295998e670460a919d961a901711c86fd7ca0cd4e8785e0b27b0e` |
| `compound-peripheral.png` | `78b54d41a216453bc3aa0e033b2250302f8485aa98bf598420d737abc134a3d0` |
| `compound-open-yard.png` | `31c561f88df88d5568a9da90131c70018eac85d144bdd6ac69c862e99e98f182` |
