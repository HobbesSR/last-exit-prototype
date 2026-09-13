# Editor cleanup and design provenance

The source of intent is [Corey's original brain dump](../design_notes.txt).
The appended assistant architecture proposal was moved intact to
`archive/retired-design-proposal/`; it is historical, not an accepted spec.
Implementation notes must distinguish current behavior from the intended design.

## What a tile means

- A tile is a predefined 6 × 6 patch of cells, segments and vertices. A uniform
  patch is valid ordinary content. Empty geometry does not make it a fallback.
- A tile set supplies choices; a layout arranges tile sets, including singleton
  sets, to create structure larger than a tile. A layout is not a region.
- Regions are discovered from compatible adjacent cell metadata after placement.
  They can span tiles; one tile can contribute to several regions. A class
  boundary does not itself imply a wall.
- Unstated segments defer and should settle empty unless another requirement
  constrains them. Explicit open segments constrain that result. Perimeter
  metadata is part of adjacency, not merely a drawing on a tile preview.

## What the live generator actually uses

`src/core.ts` imports `content/default-library.json`. The shipped corpus has ten
tile designs, three tile sets and two layouts. Only `plain` is explicitly marked
as fallback. Both layouts are currently required once. Filler chooses from
`library.tiles`; the set called `all` is an ordinary named set, not a global
enable/disable switch. A set affects selection when a layout references it.

The browser starts from that corpus unless `last-exit-library-v1` in local
storage contains a valid saved library. It passes the active library directly to
the same `generateMap` used by CLI/MCP. Browser edits do not modify the shipped
JSON file. Export the library and supply it to the CLI to reproduce those edits.
Updating a tile or applying JSON changes the library; rebuilding produces a new
map. A selected design is a candidate, not a command to place that design.

Fallback is now explicit: only `adapter: true` lowers a design to fallback
priority. Previously a uniform tile with all four ports set to `any` was
implicitly demoted, whereas omitting those equivalent ports was not. Libraries
that relied on that inference should explicitly mark their fallback designs.
The shipped corpus now omits redundant all-`any` coarse port blocks; omission
already has the same adjacency meaning. Its authored cells and fine edges remain.

## Remaining architectural mismatch

The live generator still builds a coarse tile-edge maze before selecting tiles.
Fine perimeter declarations must match its preselected apertures; they cannot
ask it to open an arbitrary seam. Restrictive designs can therefore be unused,
and restrictive required layouts can fail. The one-cell interior margin is a
limitation of that local-fit algorithm, not a permanent tile-design requirement.

`composeMacro` is a separate experimental composition API with geometry and
route tests. It is not connected to library generation or the editor. Keep its
useful shared geometry checks, but do not mistake its separate authoring format
for a replacement for the brain dump's tiles, sets and layouts.

The next generator change must compile tile/layout declarations into composed
geometry, let that geometry determine traversal, and retain the same library
across GUI/CLI/MCP. It needs artifact migration and end-to-end checks; connecting
the experimental API alone would not complete that change. See
[next tasks](NEXT_TASKS.md) and [macro experiments](MACRO_STRUCTURES.md).

## Other cleanup

The editor now shows all 84 segments directly on its cell grid and edits both
perimeter and supported interior segments. Each edit writes a targeted
`primitives.segments` override; unrelated walls, edge shorthands and vertex
metadata survive. Deferred, open, wall and fractional aperture states remain
distinct. Disabled interior lines expose the legacy margin restriction.
Painting uses resolved cell metadata, so hidden overrides cannot defeat edits.

Removed active documentation claims inherited from the proposal about a
module-versus-tile distinction and deliberate jagged boundaries. Corrected
material-region descriptions and the README's invalid interior-vertex example.
Archived the obsolete validation report and handoff before replacing their
active copies. Moved a stray generated artifact named `nul` to
`test-results/legacy-cli-zone-check.json`; no authored content was deleted.
