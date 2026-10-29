# Depot movable-cord comparison (#663)

This is a tool-only composition experiment following epic #529 comments 7150 and
7380 after merged #662. Production remains `buildDepot`, with unchanged content,
registry, RNG/ID order, snapshot/chain formats and frozen fixture. The comparison
shares the existing candidate walk rather than introducing a new depot grammar
or raising warehouse quota.

## Inputs and controls

`results.json.gz` retains six isolated 24x18 opposite-portal seeds and all twelve
top-level depots in the current-library maps `issue330-before-12x6`,
`issue330-before-24x12` and `issue330-before-36x18`. These authored inputs cover
756, 1,944 and 2,880 cells with 20–36 portals. This is one map per authored size,
not a seed sweep or evidence about every possible depot.

Each workload retains the exact brief, hash, complete production/fixed/movable
results, collision/portal/door/room/bypass/spacing checks, accepted pieces crossing
the old route bands, intentional empty areas and final swept witnesses. The report
pins the source checkpoint, hashes of micro/kernel/shared TypeScript and the audit,
Node/platform, dirty-source state and exact input hash. Original hashes identify
measured Windows worktree bytes, including mixed line endings and EOF blank lines.
`measured-sources.json.gz` now retains **all 174 exact measured source texts**;
each text's raw hash must match the unchanged original `results.json.gz` inventory.
The former three-entry archive is preserved as `measured-sources-original.json.gz`.
This includes `parcel-area.ts`: its measured raw bytes were still available and
match the recorded hash; Git's version differs only in EOL/EOF whitespace.

`tools/depot-cord-verify.mjs` checks the complete archived inventory before rebuilding.
Checkout comparison normalizes CRLF to LF and EOF blank lines to one final newline.
The two historical trailing-whitespace cleanups are explicitly tagged in the archive
and applied only to measured expected text. The helper pins the two authorized
paths; forged cleanup tags cannot extend that exception. Token edits, new inline whitespace,
missing source entries and tampered archive text still refuse. No hash inventory is
silently skipped or replaced with a claimed historical source we cannot recover.
`final-source-verification.json` records canonical hashes and all 54 exact output/
diagnostic comparisons. Its `verificationToolSha256` and support-module hash use
UTF-8 with LF line endings, matching normal Git blob bytes independently of checkout
EOL conversion. Original geometry and cost measurements remain unchanged.

The audit refuses a source change during capture. `index.html` provides the comparison table and three inspected screenshot pairs;
`all-workloads.html.gz` preserves the complete eighteen-workload HTML preview
alongside the production reference. These are collision/intent previews, not art/roof renders.

Fixed and movable controls share seed, candidate ordering, warehouse quota/design,
lane phase, piece spacing and intentional density-skipped spans. Both additionally
require a complete two-cell exterior access ring, actual warehouse doorstep
protection/reach, and omit secondary crate infill. Production retains its original
rules and infill. This deliberately isolates primary composition; fixed-vs-movable
is the routing comparison. Production-vs-experiment is **not** a route-only delta.
Admitted sites change later candidates, so final geometry is not held constant.

Movable admission routes against private template-box proxies, conservatively
blocking warehouse interiors. It reuses the prospective coordinator for ordinary
rows, rebuilding detached when a warehouse adds new exterior standing terminals.
Actual geometry is preflighted separately; failed admission publishes neither it
nor changed routing evidence. Empty intent remains nonblocking. The SDK's existing
search/operation bounds remain; its boolean ordinary-commit refusal is reported
as `routing-or-canvas`, not diagnosed as an impossible geometry or a specific
budget failure. Fixed mode has no equivalent coordinator operation bound. Retained
operation counts must be considered before attributing a difference to routing.
This adapter accepts the depot's exterior access demands; it is not a general
solution for access intentionally running through its own pessimistic envelope.

The first exploratory implementation rebuilt every prior routing operation on
every candidate. Its unmeasured full audit was stopped before completion, and replaced with the adapter above. No measured speedup or
completed comparative result is claimed for that abandoned attempt.

## Findings

| Workload | Policy | Warehouses | Container rows | Occupied cells | Warehouse envelope cells | Loot sites |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Six isolated seeds | Fixed | 3 | 25 | 203 | 144 | 596 |
| Six isolated seeds | Movable | 6 | 23 | 262 | 288 | 557 |
| Twelve authored depots | Production reference | 57 | 308 | 3,217 | 2,736 | 667 |
| Twelve authored depots | Fixed | 57 | 261 | 2,761 | 2,736 | 783 |
| Twelve authored depots | Movable | 57 | 264 | 2,769 | 2,736 | 770 |

Five isolated warehouse parcels and two isolated row parcels cross old protected
route bands. Three formerly warehouse-free fixed-control cases gain a warehouse;
seed 5 demonstrates a useful warehouse crossing while both controls already have
one. In authored depots, six row parcels cross old bands but no warehouse does;
warehouse counts/area remain equal, and the net gain is three rows/eight occupied
cells. This is modest composition utility on these production inputs, not evidence
for a broad warehouse-density gain. Candidate changes can lose rows in individual
cases (for example 34 to 31 at `depot@696,372`); the complete per-case evidence is
retained rather than selecting only wins.

All three authored maps have no report defects. Both experimental policies have
zero thorough portal/fill errors, zero failed exterior doorstep-square/reach checks
(208 fixed and 222 movable stands across all eighteen cases), and zero failed room
checks at actual contestant clearance. Deliberate empty spans remain explicit:
1,132/1,130 authored cells for fixed/movable. Maximum accepted operation counts
are 84/86, well below the movable coordinator's unchanged 1,024-operation bound;
that limit does not explain the measured admission differences.

Production reference remains unmodified. In isolated `crossing-3` and
`crossing-5`, two original outside standing blocks lie outside their access masks;
the first-stand-anchored room-route check consequently records four misses. These
are retained reference diagnostics, not four proofs that no other entrance reaches
those rooms. All twelve authored production references pass the sampled checks.
Preview green dots indicate gate-centre routes; actual traced exterior standing
squares/reach in the raw `doorsteps` records are the stronger access evidence.
`aggregate.json` lists these reference limitations explicitly.

Decision: **retain** the generic movable-envelope capability and this comparison;
**adapt selectively** when frozen admission blocks a chosen primary composition;
**defer production depot promotion** and blanket migration. The production sample
already meets the unchanged warehouse quota under both controls, and its row gain
is small. Preserve existing placeables, infill, inward grounds, ownership and
recovery. Reassess #532's multiple houses/courtyard use and #533's structural hall/
depot composition against their actual intended reach; do not commission general
SDK optimization or extra pocket polish merely because this experiment exists.

## Cost

`timing-inputs.json.gz` deliberately selects crossing seed 5 and the first authored
workload in each distinct (cell count, portal count) stratum: 756/20, 1944/30,
1944/21, 2880/36 and 2880/28. The six-case cost sample spans all three map sizes
and includes both largest portal families. It is selected by input shape/count,
not observed speed, and is a subset of the eighteen geometry workloads.

`timing.json` retains one warmup followed by three sequential paired rounds,
rotating policy order and holding the machine benchmark lock. Output hashes must
match warmup in every round; the report's hashes are also checked against the
geometry capture. No other task test/benchmark runs concurrently. External machine
load is not sampled. These are builder-call costs including the experimental
adapter, not server tick costs or general SDK overhead.

Six-case total build times, after warmup:

| Round | Production reference | Fixed experiment | Movable experiment | Movable vs fixed |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.246 s | 11.351 s | 14.181 s | +24.9% |
| 2 | 0.254 s | 10.671 s | 12.970 s | +21.5% |
| 3 | 0.224 s | 10.264 s | 13.258 s | +29.2% |

Independent total medians are 0.246/10.671/13.258 s; the median **paired** movable
increase over fixed is 24.9%. Movable is 51.1?59.1 times the production reference
in these rounds, while the fixed experiment is also far more expensive than
production. Both experimental controls add full envelope/door obligations and
repeated actual-geometry preflight, and have different admitted content. The
production ratio therefore does not isolate cord-discovery cost. These results
are sufficient to defer production promotion; they do not justify a general SDK
performance project or a new budget/guard policy. Exact timed output hashes match
both warmup and the retained geometry capture. `timing-summary.json` retains the
arithmetic; Node v24.15.0 / Windows x64, one machine, external load unmeasured.

## Compatibility and verification

Experimental owning snapshots use `depot-cord-comparison-1:fixed` and
`depot-cord-comparison-1:movable`. Focused tests reconstruct full snapshots without
an engine and omitted-result snapshots with the matching registry, refuse the
other identity, and test canonical reordered inputs. There is no child dispatch,
new ownership partition or changed historical crossing reconstruction. Production
`types-50`, wire 8, macro 3, library 3 and `region-2` remain unchanged.

Focused tests cover a warehouse crossing the old protected route, real hunter
standing squares at every realized outside door, actual contestant clearance into
each room, thorough final portal/fill validation, separating-cut and inaccessible
new-door refusal, invalid geometry rollback, deliberate empty intent, density zero
and undersized fallbacks. Reordering is additionally checked on all eighteen
retained briefs and all three policies.

Validation on the measured executable source, with portable source verification checked separately:

- `npm run check` and `npm run typecheck`: pass.
- `npm test`: 1,263/1,263 pass.
- `npm run test:micro`: 510/510 plus four browser preview programs pass.
- Full `sweep --check map/tools/fixtures/chain-baseline.json`: 224 maps, zero
  drift, 135 s. No baseline or frozen fixture recapture.
- Both new files under `test:times`: 0.5 s adapter and 2.2 s integration,
  below the 15 s fast-tier file limit (measured while non-timing audits ran).
- All eighteen paired geometry/reordering workloads pass. Full/omitted snapshots
  for crossing seed 5 and an authored 756-cell depot recover under both policies;
  wrong-policy regeneration refuses. The raw four snapshot pairs are retained in
  `recovery.json.gz` and their output is checked against the geometry capture.
- Inspected Chrome-rendered screenshots for the isolated crossing, compact
  authored depot and large authored depot; full HTML retained for every workload.
- Source hashes and exact output hashes match between geometry and all three
  sequential timing rounds. After final whitespace-only cleanup, all 54 complete
  outputs/diagnostics match again under `tools/depot-cord-verify.mjs`. Review #503
  corrects the verifier to reproduce from clean LF and CRLF Git exports, checks all
  174 archived raw source hashes, and pins its final LF-normalized self-hash. Five
  provenance regressions reject source/archive tampering; typecheck passes.
  `git diff --check` passes. Binary archives and inspected
  PNGs have byte hashes in `sha256.json`.

The unregistered experiment does not move production outputs, so output-specific
slow seed sweeps, unrelated whole-match/physics slow tests, full main-game browser
suite and general runtime/client benchmarks were not run (31). The complete micro
browser gate and full chain sweep cover the affected production integration.

## Reproduce

```powershell
node tools/depot-cord-audit.mjs --input=docs/reports/issue-663/results.json.gz --out=test-results/663-replay
node tools/depot-cord-audit.mjs --timing --input=docs/reports/issue-663/timing-inputs.json.gz --out=test-results/663-timing
node tools/depot-cord-verify.mjs docs/reports/issue-663
npm run test:times -- tests/micro-depot-canvas.test.js tests/micro-depot-experiment.test.js
```

To unpack the complete retained preview without regenerating maps or measurements:

```powershell
node --input-type=module -e "import{readFileSync,writeFileSync}from'node:fs';import{gunzipSync}from'node:zlib';writeFileSync('test-results/663-all-workloads.html',gunzipSync(readFileSync('docs/reports/issue-663/all-workloads.html.gz')));"
```

To regenerate the three current-library maps rather than reuse retained inputs,
omit `--input`. `--capture` only collects exact inputs, and `--direct` selects the
six isolated seeds. A later library or engine version can legitimately differ;
compare source/input hashes before interpreting a new report.

Owning mechanics: 20.3.4; cords: 20.10; recovery: 20.7/53; verification: 31;
epic selection and stopping: 32/41. The reports retain evidence for a decision;
they do not close #529, #532, #533 or #535 or promote an experimental policy.

## Review #503 correction

The original verifier compared raw local byte hashes and had archived only three
source files, so normal Git EOL conversion and `parcel-area.ts`'s extra EOF blank
lines caused false source-change failures on a clean checkout. Its recorded
self-hash also did not match the final committed script. This was a verification/
provenance defect; the reviewer independently reproduced every full build and
diagnostic. The correction preserves the original result/timing archives, retains
the complete measured source inventory, and regenerates verification metadata
using explicitly defined normalization. No depot/SDK implementation, content,
threshold, budget or performance result changes.

Clean-export validation uses Git `checkout-index` on the staged candidate tree,
once with `core.autocrlf=false` and once with `core.autocrlf=true`, with empty
scratch directories and only the installed dependency directory linked in. Both
run the exact advertised verifier command; the resulting 54 comparisons and
LF-normalized verifier self-hash are checked against the candidate Git blob.
See `clean-checkout-verification.json` for the retained outcome and source tree.
