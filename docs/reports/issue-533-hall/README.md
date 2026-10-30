# Hall structural composition evidence (#533)

The production hall builder now composes side-connected rectangular bays after
its unchanged primary lattice. Wings retain a 2.5-cell perimeter walk, two-cell
pillar separation and open joins. `roofed` encloses each bay. Selected bays stay
reserved when routes or minimum interior size leave no pillar fit. Thin necks,
detached annexes and optimal partitioning are outside this first outcome.

## Why the library changes

The five original retained authored halls have rectangular masks. The exploratory
old-library inventory in `search.json` covers another 30 halls across 18 small,
one medium, one large and two default sweep maps, finding no visible structural
wing. A builder-only change would not demonstrate useful normal-library adoption.
Each final top library therefore adds one L-shaped `pillar-hall-winged` alongside
`pillar-hall` in its existing class: medium at 12x6, small at 24x12 and 36x18.
Its 6x5 footprint has a two-row top arm, three-column side arm and deliberately
open 3x3 field corner. All mixed/exposed prescriptions and original designs are
retained. Shared immutable modules and quotas are unchanged (52).

## Workload and provenance

`baseline.json.gz` retains 23 exact briefs and complete original-builder outputs:
five original-library authored halls, seven synthetic shapes and eleven
final-library authored briefs. Original builder source is pinned at `ae988b7`;
its imports use the current unchanged geometry/placeable dependencies. Its
normalized original source inventory is historical. `newLibrary.sourceHashes`
separately binds final-library input capture; the comparison inventory binds the
final implementation, macro inputs and shared dependencies. Hashes normalize
CRLF to LF, preserving other whitespace. The Node version is recorded.

Original named maps use `issue330-before-WxH` at all three authored sizes. The
final-library capture retains every hall of those named maps, then tries up to
ten additional `issue533-hall-new-N` seeds at a size with no visible wing,
stopping at the first positive and retaining its positive briefs. The 24x12
sample needed N=2; the other named maps already contain positives. Full selection
counts and map defects are in `baseline.newLibrary.inventory`. This is a selected
capability sample, not an unbiased density or balance estimate. Before/after
builder comparisons always use the same exact brief, isolating composition from
the separately declared library change.

## Results on the eleven final-library briefs

| Size | Briefs | Pillars | Structural bays | Envelope cells | Occupied cells | Crates | Loot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12x6 | 2 | 7 ? 8 | 2 ? 3 | 912 ? 1,092 | 84 ? 82 | 11 ? 0 | 93 ? 97 |
| 24x12 | 2 | 3 ? 4 | 1 ? 2 | 448 ? 628 | 49 ? 46 | 12 ? 0 | 93 ? 92 |
| 36x18 | 7 | 56 ? 59 | 7 ? 9 | 8,716 ? 9,076 | 344 ? 357 | 14 ? 0 | 461 ? 461 |
| Total | 11 | 66 ? 71 | 10 ? 14 | 10,076 ? 10,796 | 477 ? 485 | 37 ? 0 | 647 ? 650 |

These authored briefs are unroofed. The seven synthetic roofed cases separately
increase enclosing roof/envelope area from 1,252 to 1,936 cells, and bays from
6 to 14. The original five authored outputs and synthetic no-fit, thin-neck and
detached cases remain exactly unchanged. Some selected bays emit no pillar and
replace old crates with intentionally clear space. Increased occupation is not
the sole criterion: the new content is a connected pillar bay with protected
circulation. Route saturation and additional shapes remain later refinements.

All 23 final results pass thorough portal reach, inherited fill and final loot-disc
clearance checks. All 48 secondary perimeter hunter samples reach from their
nearest portal. A separate swept cardinal flood over integer intersections
finds no previously reachable node that remains walkable but becomes disconnected
(21,207 baseline reachable samples). These are sampled geometric diagnostics,
not an exhaustive continuous-space proof or human balance acceptance.

A two-cell initial wing inset left a narrow lane beside a hinted wall that the
half-cell search missed. The 2.5-cell inset and a retained exact-input regression
preserve that formerly reachable stand. Six-cell bays with insufficient interior
width remain clear instead of placing an out-of-inset pillar.

## Reproduction and previews

- `node tools/hall-composition-audit.mjs` reruns all geometry diagnostics and
  writes `comparison.json.gz`, readable `summary.json`, compressed paired SVG
  panels in `index.html.gz`, and `test-results/533-hall-composition.html`.
- `node tools/hall-composition-audit.mjs --verify` verifies current normalized
  sources, tool/input/result hashes and all 23 complete rebuilt outputs without
  rerunning the route searches.
- `--capture-new-library` deliberately replaces only the final-library input rows
  using the documented seed-selection policy and pinned old builder. Original
  inputs remain intact. It is a capture command, not a verification command.
- `node tools/hall-chain-diagnostics.mjs` reads retained `sweep-before.json` and
  reruns whole-map report/portal/fill diagnostics for every map with built drift.
  It writes `integration.json`, including input/sweep hashes and actual findings.

The three retained PNGs were rendered in headless Chrome at 1400px width and
visually inspected. Owned cells are pale, bay envelopes blue, collision dark and
portal seams magenta. They demonstrate collision/composition rather than art or
roof-render acceptance. The synthetic L panel shows an enclosing secondary bay;
ordinary-map panels show one and two wing pillars replacing small crates while
retaining the primary layout and open transitions.

Integration and final capture results are recorded below when complete.
