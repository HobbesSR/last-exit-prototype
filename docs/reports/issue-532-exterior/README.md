# Secondary exterior compound outbuildings (#532)

The production compound builder now tries one detached HOUSE after its unchanged
ring and courtyard, before offering exterior yards to cover. This completes one
useful exterior composition class; multiple rings, larger-hut authored margins,
broader courtyard grammar and maximum residual use are separate work.

## Authored admission and access

The retained inputs come from fresh `forgejo/main` at `e9e9be3`, using the three
matching bundled libraries, cell size 48 and the parameters in
[the compressed baseline](before.json.gz). It contains all nine compounds from
`size-12-1`, `size-24-1` and `size-36-1`, their complete original BuiltRegions,
site inventory and original source hashes. The 12 × 6 sample has no compounds.
This differs from older #532 samples because subsequent authored-library changes
altered those maps. The inventory counts possible individual rectangles, never
simultaneous capacity or successful admission.

| Map seed | Compounds | Outbuildings | Occupied cells before / after | Loot before / after |
| --- | ---: | ---: | ---: | ---: |
| size-12-1 | 0 | 0 | 0 / 0 | 0 / 0 |
| size-24-1 | 3 | 2 | 723 / 770 | 588 / 559 |
| size-36-1 | 6 | 4 | 1,353 / 1,456 | 1,938 / 1,856 |

All six additions are three-room 6 × 6 houses, addressing 216 body cells in
total. Physical occupancy uses `measureFill` on complete before/after results;
it includes changed exterior cover, rather than counting enclosed floor space
as a solid obstacle. Loot changes include changed retained/child ownership and
cover composition as well as exclusion from new walls/doors. No loot quota or
chance parameter changed. The three no-fit compounds retain their entire prior
output, not merely their primary structures.

Ring and courtyard elements compare exactly in every paired compound. The
final-geometry audit passes all 1,176 room-center, door-center/approach
and outbuilding-bypass targets in the retained owner's access mask. All 36
final owners pass partition, fill and portal checks against combined geometry;
the complete compound portal promise passes too. Results are in
[after.json](after.json).

Run `node docs/reports/issue-532-exterior/audit.mjs` to rebuild the report, or
add `--verify` to compare against it without updating the saved evidence. The
script checks baseline source digests against `e9e9be3`, pins current normalized
source hashes and complete before/after output hashes, checks all actual rooms
and door approaches, and sweeps every returned mesh segment against exact final
collision geometry. It reuses a mesh across local targets rather than repeating
large grid floods. Target starts use the nearest original portal; the portal
promise joins those starts. Retained targets cannot borrow arbitrary cover-child
interiors. The baseline file is historical evidence; do not regenerate it from
the changed implementation.

## Admission and ownership

Try 6 × 6 with three rooms, 6 × 4 / 4 × 6 with two, then
4 × 4 / 4 × 3 / 3 × 4 / 3 × 3 with one. Independent seed channels leave the
primary composition unchanged. A candidate must fit inherited reduced fill,
stay two cells from the ring, and have a complete two-cell exterior access
collar. A standing-block flood around the pessimistic ring box connects actual
gates and the house doorstep and preserves every previously reachable exterior
2 × 2 stand still valid outside the new body. This protects side pockets as
well as portal connectivity. Unreachable lobes are refused before their
candidate flood; removing free space cannot make them reachable.

The later yard transaction claims/populates the ring/court and house bodies
together, reserving the complete house collar as fixed retained access. Its
2 × 2 tiling covers every collar cell, including odd-sized footprints. Cover
cannot claim those cells or introduce new margins through them. Existing
crossing selection, receivers, optional-adopter limits and snapshot encoding
are unchanged. One outbuilding is an authored composition choice, not a density
target or an exhaustive search for the maximum number of buildings.

The [browser preview](browser-preview.png) shows the retained ring/keep and the
detached three-room house in the lower lobe of the concave browser fixture.
The browser test compares the complete result with the server-side builder,
checks the portal promise and all three building traces before capturing it.
This is a synthetic presentation witness, separate from the authored-map audit.

`types-55` / `compound-yard-6` intentionally changes content, including compound
lots inside blocks. Full historical snapshots retain stored results; omitted
older results require their matching implementation. Current full/omitted
recovery and observer tests include the outbuilding. The frozen gameplay fixture,
HOUSE version, macro/library versions and wire format remain unchanged.

## Verification checkpoint

Focused exterior and snapshot checks pass. The first fast run passes 1,293 of
1,307 tests: thirteen failures depend on the intentionally stale chain baseline,
and one is the old seed-2 generated-ID pin. Current IDs are `o1238`, `door-838`,
`item-2074`; seed 1 remains unchanged. Assertions for roof identity/order/groups
remain intact. Final post-capture validation is recorded below when complete.

The 224-map pre-capture comparison takes 176 seconds: all 224 result identities
change, with 89 built and 88 report changes, no upstream drift and no error
drift. [The raw comparison](sweep-before.json) selects the changed maps for
whole-map diagnostics. Reproduce with the baseline from `e9e9be3`, then run:

```powershell
node tools/hall-chain-diagnostics.mjs docs/reports/issue-532-exterior/sweep-before.json docs/reports/issue-532-exterior/integration.json
```

The existing diagnostic runner accepts report paths independently of its
historical filename. It binds normalized generation-source hashes, rebuilds
every built-drift map and runs complete report/portal/fill checks.

The rectangular builder-fill witness (`--types=compound --seeds=4 --width=40
--height=34 --json=1`) builds 4/4 before and after: free share .842 → .825,
large-gap share .692 → .620, largest remaining gap 272 cells in both. This
diagnostic is supplementary; occupied-cell gains do not establish access.

Generation timing uses `timing.mjs` only while tests and sweeps are idle. It
loads the original compound strategy from the source-bound base commit,
rewrites only its relative import URLs into a fresh scratch control module,
verifies every control/current output hash and alternates three measured paired
repeats after warmup. Geometry/work differs intentionally; this is end-to-end
composition cost, not isolated flood or coordinator attribution.

The [three-repeat timing report](timing.json), Node v24.15.0, measures:

| Witness | Cells / portals | Before median | After median | Median paired change |
| --- | ---: | ---: | ---: | ---: |
| Eligible `compound@246,228` | 1,152 / 24 | 327 ms | 548 ms | +67.3% |
| Eligible `compound@348,162` | 11,232 / 76 | 7,108 ms | 8,791 ms | +21.3% |
| No-fit `compound@252,186` | 1,296 / 24 | 1,046 ms | 1,037 ms | −0.5% |

All control/current outputs match their respective retained hashes. The added
structure, stronger admission flood and retained bypass/handoff obligations
have a real generation cost; the large compound was already expensive before
this change. No wall-clock admission, budget increase, default planner promotion
or general performance-remediation claim follows from these three witnesses.

All 89 changed maps pass complete final-geometry diagnostics (358 seconds),
with 212 normalized source files still matching the diagnostic inventory.
The selected slow gate passes all 14 tests: all compound seed/mask/access and
determinism sweeps, the corrected authored military-quarter witness, 25 default
maps, five 24 × 12 maps, five 36 × 18 maps and a full game-map portal diagnostic.
These concurrently run checks are validation, not performance measurements.

All 535 micro unit tests and the four browser previews pass; the separately
added odd-width test also passes. The browser rerun verifies the new third
building trace. A redirected PowerShell run surfaced Node's experimental warning
as an error exit without an assertion failure; unredirected/`cmd` reruns of the
browser checks return zero. No warning or exit was suppressed in assertions.

The [initial isolated file budgets](file-budgets-before-split.txt) found the
combined ell/ring observer file at 15.1 seconds. Its identical seed, gate
parameters and assertions now run in separate mask files, measured at 7.8 and
9.6 seconds in [the final split check](file-budgets-final.txt). Other edited fast
files measure 0.4–6.8 seconds; the authored slow witness measures 49.4 seconds,
below its 60-second limit. Nearest-portal starts preserve every original target
and use the independently checked portal promise. Earlier concurrent 67.4 and
83.8 second observations are not claims that a generation slowdown was fixed.

Run `node docs/reports/issue-532-exterior/chain.mjs` (or add `--verify`) to
regenerate the exact three authored maps, compare their compound briefs and
complete outputs with the paired audit, and check complete map reports. This
is separate from replaying already-retained briefs.

The 224-map baseline is recaptured from content commit
`0d7b5560011cfb0dc8e41461d85c09df2ab77439` at
`2026-10-30T14:42:36.449Z`, Node v24.15.0 (118 seconds), with no generation errors.
Wire, macro, library/placeable and frozen gameplay fixture versions are unchanged.
The independent [post-capture comparison](sweep-final.json) passes all 224 maps
with zero drift in 160 seconds. Final `npm test` passes all 1,309 tests, zero
failures (218 seconds), including the new odd-width and split observer cases.
Final check/typecheck pass, and all 212 diagnostic / 177 authored-audit source
hashes still match the generated implementation. CI remains external to these
local results and is reported on the PR.
