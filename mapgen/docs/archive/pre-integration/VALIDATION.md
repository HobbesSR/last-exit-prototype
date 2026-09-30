# Validation checkpoint: emergent seams and the editing surface

This checkpoint measured `generateMapLegacy`, which #38 removed. The tile
selection rules below (outward fill, refusing walled designs, the adapter
fraction) went with it; `generateMap` does not have them. See the README
section "Scale and the current generator" for what it does.

- `npm test`: 82 tests passed. Typecheck runs as part of this command. New
  coverage: tile weight optional and defaulting to 1; seams stating exactly what
  the tiles declare, with an open field producing zero walls and no sealed seam;
  an authored 1.5-cell aperture measured back off the seam as a squeeze that
  admits a contestant and rejects a hunter; every tile reachable and the run
  walkable from both spawns to every exit across three seeds.
- `node tests/browser.mts`: passed. Generation, region overlays, movement and
  shooting input, the tile gallery and its filter, the three edit modes with the
  widened segment catch radius (a point four tenths of a cell from a line
  resolves to that line when only segments are live, and to a cell when they are
  not), rectangle drags for both cells and segment outlines, the row strip and
  the cursor palette, cell and perimeter editing, invalid aperture rejection
  across edge selection, shared-library rebuild, exported rotated edge geometry,
  invalid JSON feedback. Desktop and small-screen screenshots were inspected.
- `node tools/cli.mts batch --seed regression --count 200 --out test-results/batch-emergent.json`:
  200 of 200 default maps valid, zero failed seeds, 936 tiles per map. Measured
  distributions, all of them observations rather than targets:

  | metric                | min  | p50  | max  |
  | --------------------- | ---- | ---- | ---- |
  | sealed seams          | 96   | 134  | 172  |
  | tile-graph leaves     | 1    | 8    | 18   |
  | contestant-only seams | 0    | 0    | 0    |
  | route / direct        | 1.05 | 1.05 | 1.05 |
  | interior walls        | 4201 | 4604 | 5009 |
  | adapter fraction      | 0    | 0    | 0    |

  This bounded sample is not a guarantee for all seeds or custom libraries.

The contestant-only and route/direct rows are the point of the checkpoint. Only
`market-arcade` states a seam barrier and nothing states a seam aperture, so
there are no contestant-only seams at all and the route to an exit is 1.05 times
the direct distance on every sampled seed. That is the honest consequence of
removing the maze, not a regression to fix in the generator: friction has to
come from the macro-structure pass (NEXT_TASKS item 1) or be authored into the
library. `npm test` is now 84 tests.

Two corrections since the maze came out, both found from a reported failure:

- `any` claimed the clear span it happened to settle at, which turned silence
  into a demand — no design beside a deferring one could ever state a wall, and
  the pair was rejected instead. A deferring design now claims nothing, and a
  seam where one tile defers carries whatever the other states. This is visible
  in the numbers: sealed seams rose from a median of 5 to 134 and tile-graph
  leaves from 0 to 8, because `market-arcade` can finally wall the seams it
  declares. Route/direct is unchanged at 1.05 — there is still no shortage of
  other ways around.
- Reachability was checked over the tile graph, which asks only whether one
  anchor reaches another across a single shared seam without leaving either
  tile. With openings no longer centred, that reported dozens of false
  "geometry blocks" faults on maps whose space was in fact fully connected.
  Validation now floods the lattice per body over the whole map.

A design walled on every side that has a neighbour is refused outright, the way
a design that seals its own interior already was. Without the maze such a tile
would be an island wherever it landed, and the segment editor makes walling a
whole perimeter a two-click gesture, so a saved library could otherwise make
every build fail. If a slot has no enterable candidate at all, generation fails
with a message that says which of the two causes it is.

Reachability is otherwise enforced by selection rather than by construction. Slots are
filled outward from the western edge, and a design is drawn from those that stay
joined to the placed map and do not seal a neighbour that has no other way in.
Where no candidate can do both the slot is still filled and validation reports
the map invalid; no seam is ever cut open to repair one. Validation checks every
tile for both bodies, plus a contestant route from the spawn and a hunter route
from the hunter spawn to every exit, and re-measures every seam against the
segment grid so a reported edge cannot drift from the geometry.

Geometry checks use swept-disc moves on a half-cell lattice: a found route is
physical, while a missing sampled route is not proof no continuous route exists.
The one-cell interior margin has been removed (NEXT_TASKS item 6), so tile
selection is not a local decision and only whole-map validation settles
walkability. Micro blockers are validated against containment and routes, but
shipped classes place none. The experimental macro composer has separate
composition and post-edit revalidation tests; this seed batch does not exercise
randomized macro-structure placement, which is not implemented.

Earlier reports are archived in `archive/pre-editor-cleanup/VALIDATION.md`, whose
153-tile maps and storage figures describe an older schema and older defaults.
