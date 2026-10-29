# Cord handoff cost (#661)

This report compares the cord-domain optimization against `2f66bc6`.
The production change is confined to `map/micro/cord-witness.ts`: row-major
contiguous access cells become padded row strips before clipping. The union is
unchanged, including holes and separate components. No budgets, candidate
policies, receiver versions or execution/snapshot formats change.

## Reproduction and provenance

Run from the repository root with Node 24.15.0 or newer:

```powershell
node tools/cord-handoff-profile.mjs --profile --source=2f66bc6
node tools/cord-handoff-profile.mjs --profile
node tools/cord-handoff-profile.mjs --compare=2f66bc6
node tools/cord-handoff-profile.mjs --dense --source=2f66bc6
node tools/cord-handoff-profile.mjs --dense
```

All modes acquire the machine-wide benchmark lock and clean up temporary sibling
modules. Do not run other CPU-heavy jobs alongside them. Reports go to
`test-results/issue-661/`; retained copies accompany this README. Each records
source/input SHA-256 hashes and source commits. The historical source override
substitutes only cord discovery; other dependencies are the current tree.
The comparison rejects differences in the other six selected modules. The full
transitive dependency graph is not recreated as a historical checkout.

The exact 38 briefs come from `../issue-647/compound-response.json.gz`: 20
synthetic cases and 18 authored production cases, including top-level compounds
and block lots in the three recorded authored map sizes. No maps are regenerated
to select a more favorable workload. The older original-adoption timing compared
different output/content; it is not the baseline for this change.

## Attribution

Stage instrumentation is generated into private temporary modules, detached from
production RNG, IDs, inputs, proposals and snapshots. Times are wall-clock;
inclusive stages overlap and exclusive stages subtract measured descendants.
`preparation` includes canonical partition preparation, `partitionValidation`
includes margin inheritance and partition checks, and `receiverPreview` includes
exact receiver consultation (including cache hits). `clone` covers explicit clones
in the instrumented coordinator, preparation and executor, not nested dependency
clones. `replay` covers canvas reconstruction. Cord stages separate whole witness
discovery, mesh clipping/triangulation, search and exact swept proof. Acceptance
and final verified execution have separate stages. Per-probe rows preserve
verdicts, reasons, work counters and stage deltas. Initialization failure is
recorded separately. One instrumented pass is attribution, not a speedup claim.

## Paired timing

The comparison runs one complete warmup and three sequential paired rounds,
alternating before/after order. Every pair asserts equality of the full serialized
owning generation result, including retained/child interfaces, receiver-version
pins, offers and output. Raw per-case times and hashes are retained. Measurements
are from one Windows x64 machine; external CPU load was not sampled. They do not
establish a general SDK capacity or a per-tick performance improvement.

## Dense initialization and guard decision

The investigation uses the audit's fixed 200-by-150-cell geometry and seed 3.
All runs site the ring using the full 170-portal brief with four gates. Only the
coordinator's initialization portal set changes: original-order prefixes of 128,
129, 140, 150, 160 and 170. A hash assertion holds ring geometry, gate steps,
fixed access and interior terminals constant. The temporary guard bypass and
immediate return after initialization are investigation-only. No candidate
probes, claims, population, settlement or delegation execute in this mode.
Initialization success alone cannot justify removing the production guard.

## Results and decision

Baseline instrumented attribution across 38 cases (29 with handoffs, nine
without): total 29.27 s; preparation 14.00 s, including 7.63 s partition/margin
validation (3.85 s margin inheritance); cord witness discovery 10.96 s, including
7.18 s mesh construction, 0.65 s search and 1.64 s exact sweeps. Explicit measured
clones account for 3.77 s across stages, canvas replay 0.72 s, exact receiver
consultation 0.71 s, and final verified execution 2.81 s inclusive. These overlap;
do not sum inclusive columns. There are 531 meshes, 5,186 cord searches and
304,527 cord sweeps. Preparation remains the largest cost after this change.

Of 588 probes, 69 succeed (4.61 s inclusive), 115 are rejected during preparation
(0.80 s), 402 refuse external routing (17.07 s), and two exhaust a routing budget
(0.59 s). No initialization fallback occurs in these retained cases. All 588
verdicts, reasons and returned work counters match after the change. The after
instrumented pass spends 3.20 s in mesh construction; this is attribution from
one pass, not a controlled stage benchmark.

| Uninstrumented workload | Before median | After median | Median paired reduction |
| --- | ---: | ---: | ---: |
| All 38 cases | 35.264 s | 24.483 s | 21.3% |
| 20 synthetic cases | 10.413 s | 8.104 s | 14.5% |
| 18 production cases | 24.557 s | 16.379 s | 24.2% |
| 29 cases with handoffs | 35.219 s | 24.446 s | 21.4% |
| Nine cases without handoffs | 44.6 ms | 36.5 ms | 1.6% (noise-scale) |

Median paired reduction is the median of the three per-round reductions, not
the ratio of independently selected medians. Whole-workload reductions are
19.5%, 30.6%, and 21.3%. Every warmup and measured pair has identical complete
owning generation output. Actual transfer remains 4,364 synthetic and 9,053
production cells, with 39 and 30 children respectively. The nine no-handoff
cases invoke no coordinator and do not establish an optimization benefit.
All 38 paired output hashes also match the full serialized `after.generation`
objects in the retained #647 response report, independently confirming these
coverage counts against the original evidence.

| Fixed-site initialization portals | Result | Sweeps / attempted paths | Before / after median init time |
| --- | --- | ---: | ---: |
| 128 | success | 4,135 / 259 | 1,277 / 503 ms |
| 129 | success | 4,144 / 261 | 1,520 / 489 ms |
| 140 | success | 4,542 / 283 | 1,591 / 522 ms |
| 150 | budget | 4,646 / 244 | 1,442 / 379 ms |
| 160 | budget | 4,660 / 232 | 1,285 / 346 ms |
| 170 | budget | 4,670 / 220 | 1,172 / 303 ms |

All dense trials build one mesh; outcomes, counters, primary obligations and
output hashes match before/after in every round. Original 170-portal margins
remain fixed along with the ring; the prefix experiment changes obligations,
not geometry or primary siting. Source attribution identifies the accepted-path
segment cap, rather than geometric/search refusal or the sweep/path-count caps.
It depends on discovered route complexity, not just the number of portals.
The elementary lower bound (one segment per distinct non-root obligation) is
below the cap here and cannot cheaply prove exhaustion. A stronger predictor
would itself require route/mesh work; no source-supported cheap replacement is
established by this investigation.

**Keep** row-strip coalescing. **Keep** the production 128 guard provisionally;
initialization success at 129/140 is not full execution evidence. **Defer** a new
coordinator work budget or stronger early-failure predictor: changing refusal
policy can change coverage/content, and these data do not justify such a contract
change. Do not raise budgets, shift the count threshold, restore the rejected
low-coverage policy, or begin a general preparation/cache rewrite here.

## Retained artifacts

| Artifact | SHA-256 |
| --- | --- |
| [compare.json.gz](compare.json.gz) | `b8f228ebe64c19a222dc91a9d3ae4a4a196848f92c28e71ea60d612465a20f2a` |
| [profile-before.json.gz](profile-before.json.gz) | `2e13fe589e86d952802c98d6d3bf9e9cefa961e3fdbd5e5db955ba2b193eeb8e` |
| [profile.json.gz](profile.json.gz) | `3de595b5e77516c3cc45e5a7183c118dc448988ae5692d890bb11cf19cb65990` |
| [dense-before.json.gz](dense-before.json.gz) | `5bfe7c3956de5a0495bbc553c17cada3506bbbbcc32e34cfc7c14c2a6bb4fd62` |
| [dense.json.gz](dense.json.gz) | `1fef85f1205b417548c660c0c68a3c740bc841fff1d4ed7dfad8b011c8ce906e` |

## Validation

- `npm run check` and `npm run typecheck`: pass.
- `npm test`: 1,256 tests pass.
- `npm run test:micro`: 503 tests and all four browser preview programs pass;
  includes parcel/delegation atomicity, access, observer isolation, and current
  full/omitted compound and hut recovery witnesses.
- `node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json`:
  224 checked, zero drift (133 s).
- `npm run test:times -- tests/micro-cord-witness.test.js`: 0.3 s (15 s budget).
- `git diff --check`: pass.

No frozen fixture or chain baseline was regenerated. The behavior-preserving
change does not move builder output, so type-specific slow output sweeps, the
unrelated whole-match slow tier, full game browser suite, and general runtime
benchmarks were not run (31). The full micro gate includes its browser previews.
