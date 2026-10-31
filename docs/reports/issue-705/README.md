# Opt-in macro boundary experiment (#705)

The finding and disposition belong to [42.26](../../42.26-macro-boundary.md).
This directory retains a separate experimental comparison, not production
content or a new impassable-boundary contract. Historical captures in #688,
#694 and #698 are unchanged.

From the repository root:

```powershell
node tools/macro-boundary-experiment.mjs --out=test-results/my-macro-boundary
node tools/macro-boundary-experiment.mjs --out=docs/reports/issue-705 --verify
```

The first command refuses to replace an existing manifest. `--sizes=12` is
available for a bounded pilot; retained acceptance uses all three sizes.
Verification checks normalized LF source pins, immutable input-manifest and
decompressed input hashes, complete raw reports, saved experimental maps,
summary, timing artifact integrity and generated preview. It recomputes the
deterministic experiment and measurements. Timings are observations, not
equality assertions. The script takes the shared benchmark lock; run it without
competing tests or benchmarks.

## Candidate and controls

Inputs are the complete `size-{12,24,36}-1` maps and matching metrics retained in
[issue-688](../issue-688/README.md), at 12x6, 24x12 and 36x18. Each uses its
embedded library, original parameters and cell size 48. `manifest.json` pins
their exact decompressed bytes and all code/dependency inputs. One map per size
is not a population estimate or a ranking of region types.

The candidate is a four-cell strip at `floor(mapWidth/2)-2`, spanning its full
rectangular playable height. A one-cell-thick physical curtain has a four-cell
gap starting one quarter of the way down. Two two-cell-wide experimental owners
meet at the curtain centreline. Each builder places its own half-cell-thick wall
inside its own fill. A central two-cell guaranteed portal has automatic endpoint
caps covering the four-cell physical gap. A physical opening and its guaranteed
subset are deliberately distinguished.

The strip refuses core-class intersections, nonrectangular masks and identifier
collisions. No alternative site or gate is tried. Per-slot experimental designs
paint the classes and reauthor prescriptions before resolution. Outer strip
boundaries retain complete guaranteed runs of length at least two. Only the
central gate is guaranteed between the experimental owners. One deterministic
pass removes newly shortened sub-hunter-width portal remnants, recording every
segment; there is no iterative connectivity repair. Set-piece definitions and
singleton tile sets are reauthored to agree with the slot-specific designs.

Original masks and resolved classes outside the strip remain exact. Ownership
inside it changes; region splitting, changed IDs/seeds, clear-margin changes,
builder regeneration and resulting geometry/loot changes are confounders.
Unchanged derived briefs reuse exact stored results. Changed ordinary briefs
use the current `types-56` builders and their existing composition/loot filters;
the input's unchanged stored results remain `types-55`. The experimental build
identity names both. This is a controlled authored partition comparison, not
an isolated change to portal counts or proof that a wall alone caused every
route difference.

Fixed comparisons use the original gameplay and across-map world endpoints
from #688 for both live bodies. Every old loot site in affected original owners
is retained, including removed and invalid targets. Separate checks cover all
actual final loot and core sites in changed final owners. Focused crossings are
fixed at 15%, 50% and 85% of strip height, from three cells west to three cells
east of the strip; a fourth pair crosses the physical gate centre. They are
never moved to find walkable geometry. Invalid endpoints and every other
failure stay in the raw records and summary. All route searches use the
whole-map mesh, allowing any physical bypass. Mesh witnesses are not certified
shortest paths or simulated exploration.

`navigation-structure-1` keeps [51.10](../../51.10-measurement.md)'s definitions,
raw denominators and per-owner/type/portal-count breakdowns. New geometry-based
point samples in the after report are descriptive; they do not replace matched
before endpoints. Physical boundary sweeps include the new shared curtain seam;
non-guaranteed boundary share is a separate promise measure. SDK owner proofs
use 0.925-cell hunter clearance; route measurements use live clearances 14/25
world units. Neither is substituted for the other.

## Artifacts and compatibility

`size-W.json.gz` contains fixed endpoints, both conditions' full routes/statuses,
actual final targets, all changed-owner fill/thorough portal proofs and SDK core
access routes, stage checks, changed/reused/removed/new owners and the complete
after structure report. `size-W-after.json.gz` is a complete experimental save;
its briefs rederive from its embedded layout/library rather than stored overlays.
`summary.json` retains distributions, counts, denominators and an explicit
mechanics-check verdict. Failed checks can be retained as a negative experiment;
a completed capture does not mean adoption passed. `timing.json` separates
planning/changed-brief construction, reordered-input repetition, final proofs
and offline analyses.

Open `index.html` in a browser for full-map before/after geometry and fixed-route
previews, with size, body and route-category selectors. Grey is existing/themed
geometry, blue the curtain, green its portals, orange route witnesses and red
failed endpoints. This is a geometry diagram, not game art or a playtest.

The ordinary production reader refuses the unregistered experimental region
type. The low-level complete-save reader can inspect the embedded experimental
library/results and derive exact briefs. Normal engines refuse layout-only
regeneration under its distinct build identity. Reproduction uses the pinned
complete original input plus the adapter; a pure current engine cannot recreate
preserved historical results in this mixed experiment. Production defaults,
library fingerprints, macro/wire/content versions, chain baseline and frozen
gameplay fixture are unchanged. No new package or third-party asset is added.

Stop after this one candidate and a source-bound retain/adapt/defer conclusion.
There is no arbitrary p90 target, production promotion, general growth, density
tuning, builder-wide rewrite, extra crossing search or automatic successor.
