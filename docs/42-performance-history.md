# 42. Performance history

Durable findings from completed verification passes. The narrative of each pass
lives in its commits; only results that still constrain a decision are kept here.

The isolated physics comparison and no-go evidence for #437 are in
[42.6](42.6-physics-comparison.md). The user-directed Rapier remediation, revised
gate results and bounded integration proposal for #451 are in
[42.9](42.9-physics-remediation.md).

The current unresolved slowdown is recorded below. Historical runtime measurements are in [42.2](42.2-runtime-performance.md), generation and delegation measurements in [42.3](42.3-generation-and-delegation-evidence.md), and map chain captures in [42.4](42.4-chain-checkpoint-history.md). The navigation experiment remains in [42.1](42.1-navigation-experiment.md), the portal graph's first measurements are in [42.5](42.5-portal-graph.md), its free-space mesh bottom level in [42.7](42.7-navigation-mesh.md), bots' adoption of the tile planner in [42.8](42.8-bot-adoption.md), and replanning spread over ticks in [42.10](42.10-sliced-replanning.md).

The navigation representation experiment lives in [42.1](42.1-navigation-experiment.md):
continuous safe edges, sampled passage misses and a negative result for the initial
every-boundary-transition hierarchy.

The original measurement preamble applied to the records moved from this page:

Every number below was measured on one Windows machine with Node 24.15.0 and
installed headless Chrome, running benchmarks sequentially with no competing test
or benchmark process. They are not capacity promises, and browser, GPU and
operating-system scheduling effects sit outside these JavaScript phase timings.

Its placement was historical; individual sections retain their specific workloads
and limits. It does not fill missing metadata for measurements moved here from
other documents.

The #340, #347 and #361 evidence sections remain below because their cited local
raw outputs were not found during the 2026-10-20 #381 retention pass:
`test-results/340-solution-focused`, `test-results/347-audit`,
`test-results/347-depots-after.json` and `test-results/361-boundary.json`.
Their recorded observations remain historical statements, not newly verified
results. The checked-in #340 focused input fixtures remain available through
[the fixture provenance](../tests/fixtures/README.md).

## Historical heading routes

## Baselines

Moved to [Baselines](42.2-runtime-performance.md#baselines).

### Three-hunter content checkpoint (2026-09-18)

Moved to [Three-hunter content checkpoint](42.2-runtime-performance.md#three-hunter-content-checkpoint-2026-09-18).

### Historical extraction comparison

Moved to [Historical extraction comparison](42.2-runtime-performance.md#historical-extraction-comparison).

## The measured cost of explicit field privacy

Moved to [The measured cost of explicit field privacy](42.2-runtime-performance.md#the-measured-cost-of-explicit-field-privacy).

## Crowd diagnostics

Moved to [Crowd diagnostics](42.2-runtime-performance.md#crowd-diagnostics).

## The measured cost of route straightening

Moved to [The measured cost of route straightening](42.2-runtime-performance.md#the-measured-cost-of-route-straightening).

## Live chain-map checkpoint (2026-10-03)

Moved to [Live chain-map checkpoint (2026-10-03)](42.2-runtime-performance.md#live-chain-map-checkpoint-2026-10-03).

## Client draw cost on a real GPU (2026-10-04)

Moved to [Client draw cost on a real GPU (2026-10-04)](42.2-runtime-performance.md#client-draw-cost-on-a-real-gpu-2026-10-04).

## Live matches at each authored size (2026-10-05)

Moved to [Live matches at each authored size (2026-10-05)](42.2-runtime-performance.md#live-matches-at-each-authored-size-2026-10-05).

## Retained overhead textures (#290)

Moved to [Retained overhead textures (#290)](42.2-runtime-performance.md#retained-overhead-textures-290).

## Spectator and replay level of detail (#272, 2026-10-13)

Moved to [Spectator and replay level of detail (#272, 2026-10-13)](42.2-runtime-performance.md#spectator-and-replay-level-of-detail-272-2026-10-13).

## Map generation at each authored size (2026-10-04)

Moved to [Map generation at each authored size (2026-10-04)](42.3-generation-and-delegation-evidence.md#map-generation-at-each-authored-size-2026-10-04).

## Hut yard-to-cover pilot (#330, 2026-10-10)

Moved to [Hut yard-to-cover pilot (#330, 2026-10-10)](42.3-generation-and-delegation-evidence.md#hut-yard-to-cover-pilot-330-2026-10-10).

### PR #336 review response: macro-hut cost (2026-10-11)

Moved to [PR #336 review response](42.3-generation-and-delegation-evidence.md#pr-336-review-response-macro-hut-cost-2026-10-11).

## Delegation adoption candidate review (#331, 2026-10-13)

Moved to [Delegation adoption candidate review (#331, 2026-10-13)](42.3-generation-and-delegation-evidence.md#delegation-adoption-candidate-review-331-2026-10-13).

## Compound exterior-yard adoption (#338, 2026-10-13)

Moved to [Compound exterior-yard adoption (#338, 2026-10-13)](42.3-generation-and-delegation-evidence.md#compound-exterior-yard-adoption-338-2026-10-13).

## Cheaper incompatible-crossing preparation (#344, 2026-10-13)

Moved to [Cheaper incompatible-crossing preparation (#344, 2026-10-13)](42.3-generation-and-delegation-evidence.md#cheaper-incompatible-crossing-preparation-344-2026-10-13).

## Empty compound siting diagnosis (#340, 2026-10-13)

<a id="compound-diagnosis-340"></a>

The exact current `compound@336,342` input from
`generate('issue330-before-36x18', {mode:'game', zoneWidth:36, zoneHeight:18})`
was regenerated from `c8c87b1d9adbc045e4d51a6a88a9c6ef048a0451`, `types-25`.
Its serialized brief matches the separate focused input in
`tests/fixtures/compound-340-brief.json.gz`; that fixture's provenance is in
`tests/fixtures/README.md`. This investigation changes no content or baseline.
It does not revise the historical `types-24` sample or exterior-yard evidence.

Reproduce without any previous audit artifacts:

```powershell
node tools/compound-siting-audit.mjs --out=test-results/340-audit
node tools/compound-siting-audit.mjs --brief=tests/fixtures/compound-340-brief.json.gz --out=test-results/340-focused
```

At the initial diagnosis checkpoint both commands wrote the exact brief, emitted result, JSON reason trace and
standalone collision/access SVG. The full-map command checks that building the
captured input again equals the map's emitted result. Diagnosis uses the same
production search; its optional probe observer changes neither order nor choices.
The preview was rendered in Chrome and visually inspected. Measurements here
describe geometry, not speed; Windows, Node 24.15.0, Ryzen 9 5900X.

| Exact witness | Result |
| --- | --- |
| Original ownership | 11,232 cells, rectangle 156×72 |
| Fill after inherited margins | 6,240 cells; 4,992 owned cells excluded |
| Known-clear context | 5,376 cells, including cells across original portals |
| Original external portals / internal guaranteed runs | 76 / 586 |
| Largest fill square (independent dynamic-programming check) | 4×4 at (337,343) |
| Largest fill rectangle requiring both sides at least two | 4×4 at (337,343) |
| Largest unrestricted fill rectangle | 156×1 at (336,343) |
| Internal-run margins alone | Exclude 4,688 owned cells; no contained 10×10 remains |
| Production candidate probes | Zero: minimum contained rectangle is absent |
| Execution | `empty`, `builder-empty`, `compound has no usable ring box` |
| Emitted structures, gates, loot, core elements | All zero |
| Original portal access | 304 stands checked, 75 connecting hunter routes, zero errors |

The failure is **fill containment before `siteCompound` runs**, not inaccessible
gates, disconnected portal stands or exhausted seeded probes. The internal
guarantees' repeating clear strips and end caps prevent even a 5×5 fill square.
Removing external-portal constraints would therefore not provide the minimum
10×10 ring. This internal-only calculation isolates a sufficient cause; it is
never passed to a production builder as permission to ignore other constraints.
Final empty geometry preserves all original ownership and portal relationships;
room/court/gate targets are absent, rather than counted as successful routes.

Decision: **documented expected fallback under the current fill and ring
contracts** ([20.6](20.6-passable-margins.md), [54](54-region-types.md),
[20.7](20.7-builder-delegation.md)). More probes or a behavior-preserving siting
optimization cannot create a contained minimum box. Producing a ring here would
require separately reviewed content authorship that leaves a suitable fill area,
or a different compound design that preserves all guaranteed access. Neither is
selected at that initial checkpoint. It did not infer that this authored appearance
is desirable, weaken guaranteed segments, retry the complete region as cover,
or change loot. Corey's subsequent request extends this work into the authored
content correction below; it preserves the diagnosis of the original exact input.

The focused tests pin this exact input and compare diagnosed accepted sites to
actual emitted rings on small 17×16 and large 40×34 witnesses. The isolated file
takes 1.0 s, below [31](31-verification.md)'s 15 s budget. `npm run check`,
`npm run typecheck` and all 658 tests in `npm run test:all` pass. The 224-map
chain sweep reports zero drift. Browser integration and server/client benchmarks
were not rerun for this read-only diagnosis; the SVG was rendered and inspected
separately. These checks and previews
cover the stated inputs only, not every compound or a proposed new content policy.

### Authored solution extension

The existing structure-join authoring policy in [52](52-map-primitives-and-library.md)
was applied to included common/district modules, but its tool did not inspect
local set pieces in top-level libraries. The 36×18 library's `military-quarter`
therefore retained original `compound-grounds` on all 312 compound slots.
Those references now select the existing inward variants according to same-class
slot adjacency. Only joined compound sides change to occupancy hints; all exposed
prescriptions and 78 checkpoint slots stay unchanged. The authoring tool's optional
`--compound-library` path (since #347 `--local-library`) checks/regenerates this compound-only extension while
retaining its original three-module behavior. No new tile variants are needed.

The exact original input remains an empty fallback witness. The corrected
same-seed brief preserves ID, seed, 11,232 owned cells, all 76 external portals,
zones and hints exactly; its authored internal guarantees change deliberately
from 586 to zero. Fill increases from 6,240 to 10,856 cells. The first accepted
site is a 24×24 box at (402,366), after 16 hint candidates fail fill containment.
It emits 22 rooms, two compound gates, 94 collision obstacles, 24 door records
and 511 loot pickups under the unchanged builder/loot policy. This is one
compound ring; door records include room doors. No exterior cover is added in
this witness. Empty-to-ring output and its loot are intentional content changes.

Reproduce without previous local reports:

```powershell
node tools/compound-siting-solution-audit.mjs --out=test-results/340-solution
node tools/compound-siting-solution-audit.mjs --after-brief=tests/fixtures/compound-340-inward-brief.json.gz --out=test-results/340-solution-focused
```

The full command regenerates the corrected map, compares its brief exactly to
the second captured fixture and checks its emitted result against the direct
build. The focused command compares both preserved inputs without generating
the macro map. Both emit before/after fill/collision previews, a ring close-up,
input/result JSON, production reason traces and access evidence. Hunter routes
reach all 22 room centers, the court center and actual realized outer-door yard
stands. Final collision geometry passes all 304 portal stand samples and 75
connecting routes. The slow regression also checks both whole-cell neighbors
of half-cell door centers. Its isolated time is 26.4 s, within [31](31-verification.md)'s
60 s budget. These are sampled swept-body routes, not an assertion about every
possible compound; old saved embedded libraries retain their former output.

The checkpoint is deliberately library-only: `types-25`, macro version 3 and
wire/library format versions are retained. Existing immutable primitive/set-piece
module revisions are unchanged; the corrected 36×18 resolved library fingerprint
is `a79cd8c355545bfc`. The original compressed brief and frozen
`behavior-netcode-1.json.gz` remain untouched. Final baseline provenance belongs
in [53](53-map-artifacts-and-tools.md).

Final verification: 665/665 root tests and 136/136 macro tests pass, along with
typecheck, syntax/check and the Map Lab browser check. The authoring test takes
3.0 s and the new slow access test 26.4 s. The 224-map baseline capture retains
all hashes/cases unchanged, with content input provenance `ef97600`; it does
not cover the 36×18 library. That size's exact witness and five report seeds
provide the relevant bounded evidence. Before/after collision and ring close-up
previews were rendered in Chrome and inspected. See [53](53-map-artifacts-and-tools.md)
for the content checkpoint and limitations.

## Local block and depot quarters (#347, 2026-10-14)

#340's authoring covered only the 36×18 library's local `military-quarter`.
The same library's `city-centre` (240 `block-grounds` slots) and
`industrial-quarter` (180 `depot-grounds` slots) kept their original internal
seams. Diagnosis used #340's method on every region these quarters formed in
the first five maps holding each, seeds `issue347-0` to `issue347-10`:

```powershell
node tools/local-quarter-fill-audit.mjs --out=test-results/347-audit
```

| Before, `types-28`, library `98ccf9996c89de82` | Block (5 × 8,640 cells) | Depot (5 × 6,480 cells) |
| --- | --- | --- |
| Internal guaranteed runs | 2,210 | 1,665 |
| Fill cells | 24,000 | 18,052 |
| Largest fill square, every region | 4 × 4 | 4 × 4 |
| Below 54's fill minimum | 34 of 136 lots: all 23 depot and 8 compound lots, 3 huts | all 5 regions (10 × 10) |
| Structures / obstacles | 6 / 73 | 0 / 0 (`open` fallback) |

The loss is the #340 pattern: repeated seam margins leave no contained fill.
Even the 73 ruins lots placed nothing. Every sampled region passed swept portal access.

**Correction.** `map/tools/author-inward-grounds.mts`'s optional library input,
renamed `--local-library`, now authors local block, compound and depot slots
alike (52). That changes 420 references in `diamond-36x18.json`, using the
existing 27 inward variants. Every other slot and piece is unchanged. Same seeds,
same placements, region IDs and ownership:

| After, library `76a434e7c5cb18f0` | Block | Depot |
| --- | --- | --- |
| Internal guaranteed runs | 0 | 0 |
| Fill cells | 41,320 | 31,144 |
| Largest fill square | 46 × 46 | 70 × 70 |
| Below fill minimum | 3 of 136 lots (depot lots cut by frontage margins) | none |
| Structures / obstacles | 150 / 2,202 (248 rooms, 18 warehouses, 16 compound gates) | 90 / 2,602 (90 warehouses) |

**Depot defect found on the way.** The corrected depots first failed swept access:
six portals in four of the five regions were unreachable. These depots
have 42 to 54 portals. Past 32 portals, `depot` skipped its route tree for
`cover`'s boundary rule, which lets a box stand flush on one side of a
rectangular region. A warehouse then sat over a portal's approach and sealed it.
The old seams had hidden this: no depot that large had a 10 × 10 fill before. On these
regions the tree takes about 0.1 s, and the whole depot build 0.15 to 0.25 s
instead of about 0.1 s. Depot therefore builds the tree at every portal count
(`types-29`, 54). Afterwards all ten regions pass, with zero fill-constraint
errors.

That builder change also reaches the default library. Its sweep holds 18
filled depots with more than 32 portals. Under both builders all 18 pass swept access, and
they keep the same 124 warehouses. Container rows go from 625 to 620; 16
sweep cases drift. Reproduce by running once per builder revision:

```powershell
node tools/depot-portal-audit.mjs --out=test-results/347-depots-after.json
```

`cover`, `plant` and `park` keep the boundary rule past 32 portals. Whether
it seals their portals is a separate question, answered below (#361).

Batches of 60 game and 30 playground maps at 12 × 6 and 3 game maps at
36 × 18 show no defects. Server/client benchmarks were not rerun; the timings
above are single builds on Windows, Node 24.15.0, Ryzen 9 5900X, not paired
benchmarks. See [53](53-map-artifacts-and-tools.md) for the checkpoint.

## Boundary rule past 32 portals (#361, 2026-10-14)

#347 left `cover`, `plant` and `park` on the boundary rule past 32 portals.
The audit builds every such region in the chain sweep's pinned cases (seeds
`sweep-1` up, as `runCase` names them) and in maps `issue361-0` to
`issue361-19` of the 24 × 12 and 36 × 18 libraries, then
runs swept `validatePortalReach` on the built geometry:

```powershell
node tools/boundary-portal-audit.mjs --out=test-results/361-boundary.json
```

| `types-29` → `types-30` | `cover` | `plant` | `park` |
| --- | --- | --- | --- |
| Regions (sweep / 24 × 12 / 36 × 18) | 17 (3 / 1 / 13) | 70 (16 / 14 / 40) | 118 (6 / 27 / 85) |
| Portals, largest mask | 34–46, 3,132 cells | 34–62, 8,640 cells | 34–80, 6,984 cells |
| Unreachable portals | 0 → 0 | 0 → 0 | 2 → 0 |
| Pieces | 597 → 597 | 159 → 159 | 1,323 → 1,294 |
| Build, mean / worst | 14 / 20 ms → 14 / 20 ms | 23 / 55 ms → 24 / 57 ms | 13 / 59 ms → 40 / 175 ms |

Cover and plant didn't change; their timings differ only by run-to-run noise.

**Park seals portals.** Two 36 × 18 parks each lost one side portal to a clump
standing flush over its approach: `issue361-6` `park@408,150` (42 portals) and
`issue361-7` `park@582,456` (34 portals). A plain 36 × 72 rectangle with 36
portals, a portal every 6 cells, reproduces this on seeds 5 to 9
(`tests/micro-park.test.js`).

**Correction.** `park` protects routes at every portal count. Up to 32 portals
it keeps its route from the first portal to each other one, so smaller parks
don't change. Past 32 portals it uses `depot`'s nearby-portal tree, since the
first-portal routes cost 252 ms mean and 2.1 s worst on these 118 parks,
against 23 ms and 145 ms for the tree (`protectedRoutes` alone, two runs
each). 29 of the 118 parks change their pieces; 1,323 pieces in all become 1,294
(`types-30`, 54). The sweep's built view moved on one map (53).

Batches of 60 game and 30 playground maps at 12 × 6, and 3 diagnosed game maps
at 36 × 18, show no defects. Timings are single builds on Windows, Node 24.15.0,
not paired benchmarks.

## Completed checkpoints

Moved to [Completed checkpoints](42.2-runtime-performance.md#completed-checkpoints).

## The reported slowdown is still open

The user reports severe slowdown when many bots or players are nearby, including
off-screen. None of these short synthetic runs reproduced it. Off-screen culling and
navigation reuse are implemented, abandoned rooms retire, and smoothed frame deltas
were replaced with raw timing — none of which is evidence of a fix.

What would be: a real slow-run capture from Replays → Download performance
diagnostics, longer-lived matches, and runs on the affected device. Passing local
tests does not establish that this is fixed.

## Hint walls (#407, 2026-10-22)

`types-31` adds plain walls along hints in `hall`, `ruins` and `rubble`, about
71 a sweep map (42.4). The live map grows with them: seed 1 ends at obstacle
`o511` instead of `o415`. `npm run bench` (seed 4217, 12 × 6, one room, one
viewer), run sequentially on this machine, two runs on `main` and three on the
branch:

| | `main` (`types-30`) | `types-31` |
| --- | --- | --- |
| Tick mean | 1.957 / 1.967 ms | 2.442 / 2.474 / 2.483 ms |
| Tick p50 | 1.156 / 1.162 ms | 1.780 / 1.792 / 1.794 ms |
| Tick p95 | 5.840 / 5.665 ms | 6.809 / 7.186 / 7.086 ms |
| Ticks in the match | 3,204 | 2,997 |

The match itself differs, so this is not a like-for-like cost per wall.
`sim.step` rose from 0.257 to 0.376 ms a frame, with bots, nav-grid rebuilds
and sight-ray edge tests (524 to 802 a frame) carrying most of it. Mean use of
the 50 ms budget went from 3.9% to 5.0%. It is a real increase, recorded so a
later slowdown report can start from it; it was not optimized here.
