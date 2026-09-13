# Validation checkpoint — 2026-09-12

- `npm run typecheck` (`tsc --noEmit`, strict, `erasableSyntaxOnly`): clean across `src`, `tools`, `tests` and `public`.
- `npm test`: 53 tests passed, zero failures. Adds the primitive model (all three sets present implicitly, perimeter deference and refusal, rotation of perimeter declarations, explicit overrides winning over shorthands, vertex class propagation), coded-grid round-trip and validation, artifact size, and per-seam aperture agreement, on top of tile interior rotation and emission, interior authoring rejection, cell-level region aggregation, sealed-interior rejection, anchor validity, interior-aware seam blocking, deterministic maps, odd dimensions/seeds, both actor graphs, squeeze clearance, near-tangent obstacles, collinear geometry, malformed imports, region spawn accounting, five exits, region determinism/budgets, CLI export/validate, HTTP paths and MCP protocol calls.
- `node tests/browser.mts`: passed on installed headless Chrome using the sibling's Playwright dependency. Checked initial generation/rendering, both region overlays, movement, shooting input, ending a run, template duplication/editing, invalid JSON feedback, regeneration and small-screen layout. Screenshots in `test-results/` were visually inspected. This smoke test does not assert a full escape or combat balance.
- `node tools/cli.mts batch --seed regression --count 200 --out test-results/batch.json`: 200 default maps passed, no failed seeds. This is a bounded regression sample, not a proof across all custom libraries or seeds.

## What the sample says

| Metric                                    |   Mean |     Range |
| ----------------------------------------- | -----: | --------: |
| Tiles                                     |    153 |       153 |
| Dead-end tiles                            |  30.04 |     18–41 |
| Squeeze edges                             |  14.13 |      3–24 |
| Regions                                   | 152.95 |   129–174 |
| Largest region (cells)                    | 175.62 |   108–432 |
| Interior wall runs                        | 1031.9 |  808–1206 |
| Solid cell fraction                       |   4.8% |      4–6% |
| Loot slots                                | 126.81 |    87–170 |
| Contestant walking distance to first exit | 177.24 |   156–216 |
| Hunter walking distance to first exit     | 183.06 |   156–228 |
| Route/direct ratio                        |  1.231 | 1.08–1.50 |
| Generic adapter fraction                  |   0.0% |      0–0% |

Distances use abstract segment units and anchor-to-anchor paths, excluding
transit. Over five default seeds (765 tiles, 1,458 regions): 52.4% of tiles
contribute cells to more than one region, 23.1% of regions are nonrectangular,
and 8.8% cross a tile seam.

A default map addresses 47,257 primitives — 11,700 cells, 23,628 segments and
11,929 vertices — in about 145 KB of JSON, against 1,010,254 bytes for the
earlier artifact that had no segments at all. Two things account for it. Nothing
derivable is stored: the 11,929 vertices produce no entries, cell heights none
while the map is flat, and a cell's filled flag is the only record of that fact.
What remains is coded against a palette: nine region classes and eight distinct
open spans, the segment grid collapsing to about 2,845 runs.

The region count fell from about 306 to 153 because filled cells no longer form
regions of their own; they are material, and no region claims them.

Serialized, the same map is 56,923 bytes as wire JSON and 34,876 as BSON,
against 137,276 for the in-memory shape. 96% of the BSON is binary payload
rather than keys or punctuation. Both encodings round-trip deep-equal to the
generated map, checked on three seeds, and the BSON writer is checked against
the two published example documents byte for byte.

Adapter fraction fell from 92.0% to 0.0% because the default library now carries
interiors and every template is authored; the one adapter, `plain`, was not
needed to cover any seam contract in this sample. That measures template
coverage, not quality — it says the library can satisfy the topologies this
generator produces, not that the results play well. The macro topology itself is
unchanged and still relatively direct: squeezes often do not improve the shortest
spawn-to-exit route, and similar exit path costs do not prove independent
approaches, since tip exits still share a funnel.

## Limits of the guarantee

For the current flat geometry, each declared walking connection has an
analytically checked swept-disc route: anchor to seam midpoint inside each of the
two tiles, composed across the seam. Every lattice edge on those routes is
verified against real wall geometry, so a connected graph supplies a physically
valid path between tile anchors and anchor-placed features.

The lattice samples at half-cell steps. It is sufficient, not necessary: a body
may physically fit through a gap the lattice cannot sample, so the check fails
closed and can reject a usable template. It does not prove that every point of a
cell is occupiable by a large body, nor validate future arbitrary interiors,
layers, visibility or dynamic mechanics.

Template fitting is local by construction, resting on the one-cell interior
margin and on both agent radii being below 1; `generateMap` refuses authored
interiors outside that range rather than silently weakening the argument. Region
output still cannot add blockers. Cached graphs assume immutable artifacts;
validation clears caches after an edit.

Layout placement is ordered largest-footprint-first, which removed the small-map
failures a 2 × 2 set piece caused, but it is a heuristic and not topology
negotiation: a sufficiently restrictive authored layout can still fail explicitly.

Micro geometry is validated, not budgeted. The contract admits collidable
off-lattice props and validation walks each through the cells it crosses, but the
shipped rules place none. Enabling them on the `vault` class produced invalid
maps: a prop well inside a vault came within a hunter radius of a body standing
outside it, through the vault's own squeeze. Containment is not sufficient for
safety where a region has an open boundary.

The perimeter contract filters rather than negotiates. Topology is solved before
tile selection, so a per-segment declaration selects among the apertures topology
produced and cannot propose a different one. Vertex requirements do propagate to
neighbours, but greedily in placement order and without backtracking; a tile that
cannot meet what a neighbour already claimed falls back to an adapter. The
mechanism is unit-tested, but the shipped library declares no vertex classes, so
nothing in the batch sample exercises propagation end to end.
