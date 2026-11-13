# Map Lab route comparison — #986, stage 1

Captured 2026-11-13 from `codex/986-mesh-routes`, based on `3b1afd3`.
These are one-off adoption evidence, not a generation baseline. The current
tool contract is [53.1](../../53.1-map-lab-and-tools.md).

Each pair measures **spawn 1 → exit 1** on one unchanged game map, using the
bundled 12 × 6 library, default recipe, Fit camera and identical layers. Left
is the grid baseline; right is the bot mesh preview. Captures used isolated
headless Chrome through the project's existing Playwright dependency. Terra
inspected all six views and the three side-by-side sheets.

| Seed / side-by-side view | Grid contestant / hunter | Mesh contestant / hunter | Grid squeezes / mesh blocked-leg runs |
| --- | --- | --- | --- |
| [last-exit-001](last-exit-001-comparison.png) | 17,618 / 18,179 | 16,619 / 16,953 | 13 / 1 |
| [exit-3](exit-3-comparison.png) | 17,512 / 18,064 | 17,031 / 17,113 | 34 / 2 |
| [exit-1](exit-1-comparison.png) | 17,674 / 18,153 | 16,989 / 17,123 | 9 / 3 |

Lengths are rounded world units. [routes.json](routes.json) retains the raw
measurements and drawing counts. The screenshot timings include concurrent
checks and are not a performance comparison.

The mesh preview calls `createKnowledgePlanner` for both roles with all cells
known, all doors known/openable, zero keys and the normal search budget. This
is static full-knowledge planning, without discovery or dynamic-body avoidance.
It reports the taut route's length, whereas grid length follows tile centres
before greedy straightening. Both views also report the drawn length.

Mesh highlights contiguous whole contestant-route legs that fail a sweep at
hunter navigation clearance. These are not precise bottleneck extents and
their counts are not comparable to grid squeeze counts. The paths and markers
visibly change on all three seeds; both bodies complete every sampled route.
No page or route errors were observed. Shared route segments can obscure one
trace at this full-map scale.

Stage 1 keeps grid as the default and preserves its algorithm and numeric
expectations. Adoption and retirement remain gated on Corey's review on #986.
That later stage owns the reports, grid implementation, dependency/vendor and
licence removal, tile vocabulary, and the handed-on profiler/span cleanup.
Corey's decisions in this session: remove report grid reference columns; rename
`TILE` unless it explicitly refers to or maps one-to-one to macro generation
tiles (6 × 6 cells). No simulation/content, saved-map or replay version changes
are required for this optional Lab-only measurement.
