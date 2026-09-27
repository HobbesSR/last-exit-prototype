# Last Exit Map Lab

The macro-generation and 2D traversal prototype, in `mapgen/` of the game repository. The game at the repository root does not import it yet, and it reads no game files. [Original user notes](design_notes.txt) are the source of design intent. Implementation documentation describes current behavior and reversible defaults. The later assistant proposal has been [retired to the archive](docs/archive/retired-design-proposal/README.md).

## Run

Node 24.15 or newer. No runtime packages are required. Sources are TypeScript;
Node runs them directly and the dev server erases types on the way to the
browser, so there is no build step and no compiled copy to drift.

```powershell
npm start
```

Open **http://127.0.0.1:4173**. A `MAPGEN_PORT` in the repository root's untracked `.env.local` overrides that per worktree, and `npm start -- --port 0` binds any free port and prints it. Choose `game` mode for the fixed 12 x 6 zones and game set-piece quotas, or `playground` mode for the same diamond with smaller zones and no game category quotas. Change the seed, mode, zone dimensions, or exit count, then build. There is nothing to tune about connectivity: seams carry whatever the tiles beside them declare. Click tiles to inspect their design and features; click an exit to compare routes to it. Scroll to zoom, drag to pan, and use Fit map to reset the camera.

**Playtest:** start an escape run; WASD/arrows move, mouse aims, click fires, E interacts. Hold E at a charger for five stationary seconds, then reach an exit. Gold is collected by proximity. Two simple pursuers follow hunter-accessible routes; shots tag them and they respawn. The Hunter body selector tests the larger radius and permits transit between T markers. This is a single-player traversal/combat sandbox, not the game's match simulation: no multiplayer, inventory, extraction competition, closing hazard, or final combat balance.

**Authoring:** pick a tile from the gallery of previews (or the name filter beside it), then paint its cells and segments on one 6 × 6 surface.

- **Edit mode** decides what the surface responds to: _Cells + segments_, _Cells_, or _Segments_. The pointer is resolved against the grid rather than against whatever node is under it, so in _Segments_ the nearest line within half a cell wins and thin strips need no precision; in _Cells + segments_ the catch radius is a quarter cell and the middle of each cell stays with the class brush.
- **Tool** decides the gesture: _Paint_ applies the brush on click or drag, _Rectangle_ drags a box (cells fill it, segments trace its outline, and a drag with no width lays one straight line between vertices), and _Fill_ floods the connected run you clicked.
- Segments take the active segment brush — `any`, `open`, `wall` or a partial aperture — on contact, so declaring a wall is one click rather than a trip to a control below the fold. The panel under **Segments** still inspects whichever segment was last touched.
- **Right-click** opens a palette at the cursor offering only what the primitive under it can take, including whole-line, matching-run, perimeter, row, column and flood scopes. **Alt-click** picks up what is already there as the brush.
- The numbered strips beside the preview cover a whole row or column of cells, or, in _Segments_, a whole grid line. **Patterns** apply the active brush to a whole-tile shape: fill, border ring, interior block, checker and stripes for cells; perimeter, interior, room outline and _Defer all_ for segments.
- Name or duplicate tiles, declare cell classes, set coarse side ports under Topology hints, edit tile sets and set pieces, or edit the complete library JSON. Update the tile or apply JSON, then **Build map**. The generated-tile inspector links back to its design.

A tile has no weight field in the editor. The current `generate` path reads optional tile `weight` when choosing from WFC candidates (omission means 1). Set-piece slots choose a member from their tile set separately. See [docs/QUESTIONS.md](docs/QUESTIONS.md) for the remaining selection-policy question.

The active library starts from [content/default-library.json](content/default-library.json): 30 tile designs, 15 tile sets and 23 set pieces. A valid saved browser library takes precedence. The editor exposes design usage and the explicit fallback flag; `street` carries `adapter: true`, though the current WFC generator treats it as an ordinary candidate. Reset to shipped library restores the bundled corpus. Browser edits stay in browser storage; export JSON and pass it to the CLI to share the same library. See [the cleanup audit](docs/archive/editor-cleanup/EDITOR_CLEANUP.md) for the earlier selection behavior.

`generate` and `batch` read this library and compose its tiles before discovering regions. Game mode also places its required set pieces. Both expose the shared `mode` parameter: `game` is the default and requires 12 x 6 zones. Its library needs at least one start, one end, three enormous, one medium, and one small definition; each game map places 1/1/3/4/10 instances respectively, reusing medium and small definitions as needed. The resolved mode is recorded on the generated map; `playground` keeps generic generation and validation but bypasses those quotas and permits smaller zones. The browser and MCP interfaces expose the same parameter. `plan` uses a separate region-first generator and does not read the library. All 30 designs can be selected by WFC even when no tile set names them. The `filler`, `park-edges` and `park-centers` tile sets are not referenced by the shipped set pieces; their member tiles remain available to WFC. Set-piece `class` is required by validation but is not consumed by current placement. The tile `anchor` field is read for WFC placements, while set-piece placements currently use tile centers.

Every tile's 36 cells, 84 segments and 49 vertices are all addressable and all
have metadata, but only what you actually state is stored. A segment nobody
mentioned defers; a vertex nobody constrained defers; only perimeter vertices
can carry metadata at all, since only they take part in an adjacency contract.
A tile design may paint its own cells and place interior barriers.
`defaultCellClass` is the class for cells it does not paint, and every class a
design uses is declared once in the library's `cellClasses`; see
[docs/VOCABULARY.md](docs/VOCABULARY.md) for how cell classes, regions and tier
zones relate. Paint by hand in JSON, or use the 6 × 6 grid on the authoring tab,
which re-derives `cells` and `legend` for you:

```json
{
  "id": "vault-court",
  "defaultCellClass": "open",
  "legend": { "v": "vault" },
  "cells": ["......", "......", "..vv..", "..vv..", "......", "......"],
  "walls": [{ "x1": 4, "y1": 2, "x2": 4, "y2": 4, "gap": 1.5 }]
}
```

`cells` is six rows of six marks, each naming a cell class: `.` takes the
design's `defaultCellClass`, and any other mark is a `legend` key. Tiles paint
zones only; the reserved `solid` material class is laid by micro builders and a
tile may not use it. `walls` are axis-aligned barriers on cell-edge lines,
and an optional `gap` leaves a centered aperture — a `gap` of 1.5 is a
contestant-only squeeze _inside_ a tile.
Interior geometry may run to the tile edge and continue through a seam; see
[design decisions](docs/DESIGN_DECISIONS.md) for what removing the old one-cell
margin gave up.

Perimeter primitives are the adjacency contract. `edges` states a contract per
segment — an array of six a side — and `corners` states one per vertex. Tile
selection reads each `edges` entry as the class the neighbouring cell must take;
a segment is meant to carry that alongside a wall type and a passability
requirement, which issue #33 separates. `primitives` sets metadata on any individual cell,
segment or vertex and wins over the shorthands:

```json
{
  "edges": {
    "S": ["market", "market", "market", "market", "market", "market"]
  },
  "corners": { "N": ["arch", ".", ".", ".", ".", ".", "arch"] },
  "primitives": {
    "cells": { "2,2": { "class": "vault" } },
    "segments": { "h:3,2": "wall" },
    "vertices": { "0,1": { "class": "post", "height": 0 } }
  }
}
```

`any` is the deferring value: it carries no requirement and adopts
whatever the seam contract and the neighbouring tile ask for. A concrete value
is a requirement, and the design is only placed where that requirement holds.
Unmentioned primitives default to deferring, so an author writes only what they
actually care about. The shipped library states neighbour class constraints
through `edges` rather than `ports`, and no perimeter barriers.

Micro generation is a **catalogue** of region builders, documented in
[docs/MICRO_GENERATION.md](docs/MICRO_GENERATION.md). A builder takes one area
and the macro parameters in force over it and states cells, segments, vertices,
off-lattice props, spawns and features inside it -- declarations over the
lattice, never physical objects. Which builder owns an area is library data, not
code: a class rule names one.

```json
"cellClasses": {
  "yard": { "generator": "compound", "clutterChance": 0.08 },
  "hall": { "generator": "pillar-hall" }
}
```

Six ship: `loot-scatter` (the fallback, every area can take it), `open-field`,
`compound`, `pillar-hall`, `rubble` and `courtyard`. `node tools/cli.mts
builders` lists them. Body scale is stated once, in
[src/micro/scale.ts](src/micro/scale.ts): a contestant is between 1 and 1.5
segments across and a hunter between 1.5 and 2, so an opening of exactly 1.5
admits every contestant and no hunter, and that is where contestant-only
squeezes come from.

Before any builder runs, `planStreets` decides a route network out of the
composed geometry -- proven lattice paths, not straight lines -- and reserves it.
What the streets leave is a **block**, and a block is what a builder is handed:
regions span many tiles, but a building sited across a street is refused cell by
cell and the builder silently makes nothing. Two contracts then keep a builder
from breaking the map: containment, which refuses any declaration reaching
outside the area it owns, and a clearance guard that drops walls until every one
of the block's openings is mutually reachable again.

Loot density comes from the tier zone a cell sits in: `params.lootChance` in tier 1, rising by `params.lootTierStep` per tier. Micro generation receives it per candidate slot, so a region spanning two zones is richer at the end nearer the exit. A `cellClasses` entry carries only what is intrinsic to the class, such as clutter. The primitive region generator accepts safe candidate cells and a budget, then returns deterministic spawn slots and an actual-count manifest. Required-feature tiles are reserved. Agents can call `generateRegion` in `src/regions.ts` independently.

Regions are a property of cells. Once every tile is laid, a region search walks
the cell grid and joins neighbours that share a class across a clear segment, so
a region may be any shape and may span any number of tiles. Micro generation
then runs once per discovered region, except for material, which has no builder.
Candidates are offered on a sparse lattice, so the zone's loot density sets the
rate without positional bias.

## Agent interfaces

```powershell
node tools/cli.mts generate --seed experiment-1 --mode game --out map.json
node tools/cli.mts generate --seed experiment-1 --out map.bson   # or --format bson
node tools/cli.mts generate --seed quick-check --mode playground --zone-width 3 --zone-height 2 --out playground.json
node tools/cli.mts validate map.json
node tools/cli.mts batch --seed experiment --count 100 --out report.json
node tools/cli.mts library --out library.json
node tools/cli.mts generate --seed custom --library library.json --exits 3 --out custom-map.json
npm test
```

A map is written in its wire form, as JSON or as BSON; `validate` accepts either
and decides from the bytes rather than the file name. Batch reports include min,
max, mean, median and p95 for each numeric metric, plus failing seeds. Failures produce a nonzero exit status. GUI and CLI use the same ES module, library format, and validator. Reproduction requires the seed **and** parameters, library, and generator revision; a seed alone is not a permanent content identifier.

An optional stdio MCP server exposes `map_generate`, `map_validate`, `library_validate`, and `map_batch`. Launch it with `node tools/mcp.mts` from this directory, or configure an MCP client with the path to `mapgen/tools/mcp.mts` in the checkout it should serve (the primary checkout tracks `main`):

```json
{
  "command": "node",
  "args": ["C:/Users/Corey/Documents/Projects/astra_test/mapgen/tools/mcp.mts"]
}
```

The MCP server is implemented and protocol-tested but is not automatically registered in any agent client. All tool output is JSON over stdio. It provides generation/validation, not arbitrary filesystem access. Author files using normal filesystem tools, then validate/generate through CLI or MCP.

## Scale and legacy tile-edge contracts

The tile-edge selection and route-metric descriptions below were written for
`generateMapLegacy`, which remains in `src/core.ts`; shared scale, artifact and
validation details also apply to the current path. The current `generate` and
`batch` commands call `generateMap`: it places category-selected set pieces,
fills remaining slots with WFC, composes the result, and validates the map. It
does not use the `adapter` flag or `ports`. Its tuning metrics are read off the
finished map by `measureMap`, the same function the planned path uses: route
distances are tile-graph hops times the tile size and are `Infinity` when there
is no route (batch distributions skip non-finite samples), `deadEnds` is a
tile-graph leaf count, `squeezes` a seam a contestant can cross and a hunter
cannot, and `solidFraction` is zero with the shipped library because no class
is material. `templateFallbacks`, `adapterFraction`, `strandedAnchors` and
`propsReclaimed` come only from `generateMapLegacy`. The default tile and body
scales in the first bullet still apply.

- Fixed 6×6 tiles. The map is a 5×5 grid of tier zones masked to a diamond, 13 of them occupied; each zone is `zoneWidth`×`zoneHeight` tiles, 12×6 by default, giving a 60×30 slot bounding box and 936 tiles. Cells are abstract segment units, not meters. Contestant radius 0.55, hunter radius 0.90.
- **Nothing imposes a topology.** No spanning tree, no loop or squeeze budget, and no seam is walled or opened to fit a plan. A seam carries exactly what the two designs beside it declare, and an unstated boundary contributes no wall, so an open field crosses tile seams unbroken and needs no special adapter. What generation still owes is that the result is walkable, and it pays that by _choosing_ designs: slots are filled outward from the western edge, and a design is drawn from those that stay joined to the placed map and do not wall off a neighbour that has no other way in. Where no candidate can do that the slot is still filled and validation reports the map as unreachable rather than the generator cutting an opening. Walking metrics exclude transit.
- `edges` is a report, not a plan. After the tiles are laid, every neighbouring pair is measured: `width` is the widest _continuous_ opening along the seam (two separate one-cell holes are not a two-cell door), `kind` is only a coarse name for that width — squeeze under 2, door under 3, wide at 3 and over — and a pair with no opening has no edge. Passability is decided by the width and the geometry, never by the name. The artifact does not store seams at all; they are rebuilt from the primitives on read, like the wall list.
- Consequence worth stating plainly: with the shipped library nothing declares a seam barrier except `market-arcade`, so a generated map is close to an open field and the route to an exit is close to a straight line (`Route / direct` ≈ 1.05 over 200 seeds). Friction is now something a library has to author — interior geometry, sealed perimeters, set pieces — rather than something generation adds. See NEXT_TASKS item 1.
- `ports` — the four coarse side contracts `any`, `closed`, `door`, `wide`, `squeeze` — is **not consulted**. It only ever fed the tile-edge solver, and there is no longer a solver to feed: what a side carries is stated per segment and per vertex, which was always the real vocabulary. The field is still accepted, still round-trips and is still editable under Topology hints, pending the macro-structure pass that decides whether it has a consumer at all. Ordinary designs are preferred; only those explicitly marked `adapter: true` fill uncovered cases. An empty or fully deferring tile is ordinary content unless explicitly marked as fallback.
- `any` is the deferring value, and it is not a value a seam can carry: it is the absence of one. A design that defers on a seam **claims nothing there**, so the design beside it is free to state a wall, an opening or a partial aperture, and the seam carries what that one states — whichever of the two was placed first. Two deferring designs state nothing between them, so the seam is clear. Perimeter contracts are otherwise settled first-come, greedily and in placement order, with no backtracking: a concrete claim must be admitted by the second design or it is passed over, and a design that can satisfy nothing falls back to an adapter.
- A design walled on every side that has a neighbour is refused outright, the way a design that seals its own interior already was: without an imposed topology it would be an island wherever it landed. A slot with no neighbours may still be sealed.
- Templates may restrict where they are used with `eligibleTiers` / `eligibleBonus`. Tier and bonus themselves belong to the placement, not to the template.
- A template also carries interior cells and barriers. Before a template is accepted for a seam contract, its interior is checked: the tile must offer standing room strictly inside itself from which every seam it must serve is reachable on a proven route. That standing room is serialized as the tile's `anchor`, and routes, features and metrics use it rather than the geometric centre.
- Layouts select tile sets at integer offsets in eligible horizontal tiers. Each listed layout is currently required once; class IDs are metadata, not a class-selection solver. Compatible placements are considered before selection. Impossible libraries/layouts fail explicitly. There is no topology backtracking to satisfy arbitrary authored structures.
- Region search runs on cells after all tiles are laid, so regions are nonrectangular, cross tile seams, and one tile may contribute cells to several regions. A region is an area micro generation works in, not an enclosure: its boundary emits no geometry, and filled cells form material regions without a micro builder.
- Micro generation may return collidable geometry that is not grid aligned, alongside spawn slots. Validation walks each piece through the cells it crosses and rejects anything that leaves the region that produced it; the usual clearance checks then reject anything that severs a proven route. The shipped rules place none — see the clearance note in [design decisions](docs/DESIGN_DECISIONS.md).
- Navigation is a half-cell lattice of analytically checked swept-disc moves. A lattice route is a real centered route; the converse does not hold, so the check fails closed and may reject a gap a body could physically use.
- **Reachability is validated against that lattice, not against the tile graph.** One flood per body over the whole map: every tile's standing room must be reached from the spawn, the contestant must reach every exit from its spawn, and the hunter from the hunter spawn. The tile graph only ever asks whether one anchor reaches another across a single shared seam without leaving either tile, so a body that walks around through a third tile is invisible to it — an approximation that was harmless when a solved topology put a centred aperture in every seam, and is not now. The graph survives as a cached coarse view behind `findPath`, which is what route _metrics_ are measured on; it is deliberately conservative and no longer decides validity.
- Metrics are observations, not guaranteed fun: no target min-cut solver, squeeze-value/flanking constraint, balanced exit approaches, or controlled geometric dead-end budget. `deadEnds` counts degree-one nodes of the measured tile graph and is not a geometric cul-de-sac; `squeezes` counts seams a contestant can walk and a hunter cannot; `sealedSeams` counts neighbouring pairs the designs left with no opening. Two exits near the diamond tip may share their whole approach.
- The serialized artifact is not the in-memory shape. Every enumerated value — region class, template id, seam kind, feature kind — is interned once into a shared `strings` table and stored as an integer, bulk fields are packed column by column into the narrowest integer lane that holds them, and anything derivable is dropped and rebuilt on read: a tile's id and position, a region's id and area, every seam between tiles, and the entire wall list, both of which follow from the primitives. `decodeArtifact` returns a map deep-equal to the one that was generated.
- BSON carries the packed columns as binary; JSON carries the same structure with plain number arrays. A default map addressing 260,281 primitives is about 1,050 KB as the in-memory shape, 397 KB as wire JSON and 280 KB as BSON, mostly binary payload. The codec is in `src/bson.ts` and has no dependencies — it is checked against the published example documents byte for byte.
- The artifact stores cells and segments as coded grids — an interned palette of the enumerated values plus run-length codes — and everything derivable is left out: vertices appear only where something was stated about them, and cell heights only once a map stops being flat. Read them with `gridViews`, `readCell`, `cellIndexAt` and `segmentIndexAt` rather than decoding by hand; `walls` remains a plain list, holding the closed part of every segment plus any off-lattice micro geometry.
- Generated maps are treated as immutable by cached path queries. After external edits, call `validateMap` to invalidate caches and verify the artifact before using `findPath`.

Run `npm run typecheck` for types alone; `npm test` runs it first. The unit suite exercises deterministic generation, tile interiors and rotation, cell-level region search, interior-aware clearance, input rejection and CLI/MCP/HTTP behavior. `node tests/browser.mts` additionally runs a headless Chrome smoke check and saves screenshots in `test-results/`; it resolves `@playwright/test` from the repository root, so run `npm ci` there first. Runtime does not depend on Playwright. `npm install` only installs development formatting tools.

See [design decisions](docs/DESIGN_DECISIONS.md), [batch questions](docs/QUESTIONS.md), and [next tasks](docs/NEXT_TASKS.md). The latter separates work ready to implement from decisions to revisit after playtesting.
