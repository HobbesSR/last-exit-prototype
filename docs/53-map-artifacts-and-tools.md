# 53. Map artifacts, determinism and tools

Status: current for the generation chain (51), its Map Lab, CLI, MCP and sweep. mapgen's
old paths were deleted at the switch-over (#146). Compatibility and evidence
routes reviewed 2026-10-20 (#381); tool descriptions include earlier milestones.

The terminology in [51.1](51.1-principles-and-names.md) applies throughout:
**chain maps** are outputs of the generation chain, and **Chain Library** is
the Map Lab tab for authoring its input library. These are engineering/tool
names; the chain of inference is the separate reachability argument.

## Current compatibility domains

These values describe separate acceptance checks as of 2026-10-20. A change to
one does not imply a change to the others. The dated capture trail is in
[42.4](42.4-chain-checkpoint-history.md); builder execution and snapshots have
their own compatibility rules in [20.7](20.7-builder-delegation.md).

| Domain | Active value | Source / scope |
| --- | --- | --- |
| Region strategy content | `types-31` | `REGION_TYPES_VERSION` in `map/micro/region-types.ts`; changes saved build identity and sweep results |
| Chain wire | `8` | `CHAIN_WIRE_VERSION` in `map/macro/src/chain/saving.ts`; wire 6 and 7 are refused for their recorded compatibility reasons below |
| Macro algorithm | `3` | `MACRO_VERSION` in `map/macro/src/chain/map.ts`; macro 2 Layouts are refused under wire 8 because derived briefs differ |
| Resolved Chain Library schema | `3` | `CHAIN_LIBRARY_VERSION` in `map/macro/src/chain/library.ts`; embedded library content and fingerprint must match |
| Library module schema | `1` | [51.4](51.4-resolution.md); optional module hints do not change the flattened library fingerprint rule |
| Region result | `region-2` | `map/kernel/contract.ts` and the wire reader; stored result format |

The wire reader checks its embedded library fingerprint; a supplied library
must match it. Layout-only regeneration also requires the saved macro and
strategy versions to match the available engines. These domains are distinct
from replay and simulation versions ([26](26-recording-contract.md)) and from
builder delegation ([20.7](20.7-builder-delegation.md)).

## One seed decides the whole map

With the same engines and library, the seed and params determine every object
in the chain (Corey, 2026-09-27):
- Randomness is drawn only from streams named for the step. A region's
  randomness comes from its own seed, keyed on the map seed and its own cells,
  so changing one region's seed changes only that region.
- Nothing draws from a stream another step shares.
- Each step is a function of the objects before it, and doesn't change them.

The chain's stages are pinned by `map/macro/tests/chain-harness.ts` (51 step
3): purity, determinism, and that a view is recomputable from saved objects. A
saved Layout alone rebuilds the same results (51 step 9), and the sweep pins
every object and view per seed.

## What is stored

Two rules apply, in order:
1. **Don't store what can be derived.** In the chain, only the Layout and the
   region results hold decisions, and every other stage output is a view (51).
2. **Pack what's left** in one shared mechanism (`map/macro/src/coding.ts`):
   a string table for enumerated values, and integer columns.

**Why packing works:** a Layout places hundreds of slots, and their content is
almost entirely enumerated values drawn from a small set: design ids,
orientations, set piece names. Stored as arrays of objects, an artifact spends
most of its bytes re-spelling key names and enum members. It stays plain,
readable JSON.

**Saving** (Corey, 2026-09-27, verbatim in 17): every stage object can be
saved alone or together, and a missing one is regenerated on read. Each saved
object records its inputs and the version of the algorithm that made it.
Regenerating a missing object with a different algorithm is refused by name,
not done silently (#70, 51 step 9).

## The wire form

The shape that is convenient in memory is the wrong shape to store.
Serialization goes through a distinct wire form, which applies the same two
rules:
- Everything derivable is dropped and rebuilt on read. Every view, and each
  result's brief, is recomputed from the Layout through the same functions
  used when generating, so nothing saved can drift from what implies it.
- Every enumerated value goes once into a shared `strings` table and travels as
  an integer.
- Every bulk field becomes a column in the narrowest integer lane that holds
  it.

A map embeds its flattened version 3 library and records its fingerprint.
Reading verifies the embedded content against that fingerprint; no module files
or external library are needed. An optional supplied library must match too.

**Chain-map saves** use wire version 8 (`map/macro/src/chain/saving.ts`, #286).
Version 7 is refused by name because macro version 2 derives `any`+`any`
passability guarantees; old saved views must not be silently reinterpreted.
Macro version 3 (20.6) derives fill cells, known-clear access context and
internal guaranteed runs. The wire format remains version 8; its macro field
refuses version 2 Layouts because their derived briefs would differ.
Library schema 3 and module schema 1 are retained for the optional hint value
([51.4](51.4-resolution.md)); fingerprints still cover all authored content.
Version 6 is refused by name because it lacks the embedded resolved library
and authored-size metadata. Version 5 is refused by name: its params have no `contestantCount` or
`hunterCount` (#124).
- Its Layout goes through this form: slot positions, designs and
  orientations, and each set piece instance with its slots, as columns, with
  names in the string table. It records `MACRO_VERSION`.
- Region results are stored as the game's own `region-2` data, less their
  briefs, which are derived from the Layout on read. Macro can't read the
  game's geometry, so it doesn't pack it.
- `decodeChainMap` rebuilds a map deep-equal to the generated one. A save of
  the Layout alone rebuilds its results with the game's engines, refused by
  name if their version isn't the one the save records.
- Versions 1–4 are refused by name. Version 4 held mapgen's old generators'
  maps; its reader, `decodeArtifact`, was deleted with them (#146), and no
  legacy reader remains.

## BSON

BSON can carry raw binary, so the packed columns travel as bytes. BSON encodes
an array as a document keyed "0", "1", "2", …, so every bulk field is a typed
array that the writer stores as a binary element. Only small, heterogeneous
things stay documents.

- **The codec** (`map/macro/src/bson.ts`) is written in-house, because the
  runtime has no other dependencies. It's checked against the published
  example documents byte for byte.
- **A closed segment** is the sentinel `-1` in both encodings, because JSON
  can't carry `NaN`.
- **Sizes**, for a game map: about 190 KB as wire JSON and 180 KB as BSON,
  or 11 KB and 5.5 KB for the Layout alone. Region results are the game's own
  `region-2` data and aren't packed, so BSON saves little on them.

## Proving a change: the sweep

`node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json`
(from the repository root, about 25 s) reruns the pinned seed set and compares
per-view content hashes: 224 entries, including 161 game-mode cases (120
default game sweep seeds, 20 crowded, 20 sparse, and one quick game case) and
63 playground cases (20 each at default, 4 × 2, and 6 × 3, plus three quick
2 × 1 cases). These are the stored case groups, not a new zero-drift run.
They span spawn and exit counts and playground sizes (`map/tools/sweep.mts`).
The current baseline provenance is content commit `7a19694184c07d846833b045488773c3fc12960c`,
captured `2026-10-22T19:53:32.180Z` under Node v24.15.0.
- Each map's two objects, the Layout and the region results, and every view
  `mapViews` gives (the declared grid, the resolved layout, the regions, the
  proof, the zones, the briefs, the built map and the report) get one hash
  each, so a moved hash names the stage that moved. Hashing refuses a map
  field the sweep doesn't name.
- `npm test` pins the quick cases against the same baseline
  (`tests/map-sweep.test.js`).
- **A behaviour-preserving change** must leave every hash unchanged. A moved
  hash is a stop-and-escalate.
- **A deliberate content change** says so in its PR, and recaptures the
  baseline last (`--out`), after the report shows no defects and maps play
  acceptably. The capture refuses uncommitted changes to the chain's inputs
  and records the last commit that touched them.

Historical recaptures from #361 through the first baseline have moved to [42.4](42.4-chain-checkpoint-history.md). The entries below retain their former 53 landing anchors.

### #407's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#407s-re-capture).

### #361's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#361s-re-capture).

### #347's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#347s-re-capture).

### #293's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#293s-re-capture).

### #348's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#348s-re-capture).

### #230's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#230s-re-capture).

### L5's re-capture (#192)

See [the dated capture record](42.4-chain-checkpoint-history.md#l5s-re-capture-192).

### #218's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#218s-re-capture).

### #219's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#219s-re-capture).

### #220's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#220s-re-capture).

### #221's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#221s-re-capture).

### #241/#243/#298's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#241243298s-re-capture).

### #313's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#313s-re-capture).

### The #318 review's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#the-318-reviews-re-capture).

### #214's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#214s-re-capture).

### #325's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#325s-re-capture).

### #330's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#330s-re-capture).

### #338's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#338s-re-capture).

### #340's authored correction checkpoint

See [the dated capture record](42.4-chain-checkpoint-history.md#340s-authored-correction-checkpoint).

### #292's re-capture

See [the dated capture record](42.4-chain-checkpoint-history.md#292s-re-capture).

### S3 schema migration (#168).

See [the dated capture record](42.4-chain-checkpoint-history.md#s3-schema-migration-168).

### The first baseline

See [the dated capture record](42.4-chain-checkpoint-history.md#the-first-baseline).

## Language and build

mapgen's sources are TypeScript, and Node 24 runs them by erasing types. The dev
server erases types when serving modules to the browser. There's deliberately
no build step and no compiled output tree, because a `dist/` copy drifts from
the source the CLI and MCP execute. `tsc` is only a checker, with
`erasableSyntaxOnly`. The game's `shared/` follows the same arrangement (23).

## Tools

- **The tools live in `map/tools/`,** since they show both halves (17, "Where
  the tools live"). `engines.ts` is the one place the game's strategies are
  lent to macro as `MapEngines`. `core.ts` is what the Map Lab, CLI and MCP
  share: params over `DEFAULT_CHAIN_PARAMS`, the chain's libraries (imported
  as JSON, so they run in Node and the browser alike), the report, and
  `diagnoseBuiltMap` beside it on request, since it takes about a minute on a
  game map. Without a library of its own, a map takes the bundled one
  authored for its zone size (52). A 12 × 6 game map generates in about
  0.25 s, and saves to about 200 KB of wire JSON, or 11 KB as the Layout
  alone; 24 × 12 takes about 1.3 s and 36 × 18 about 4.5 s (42).
- **Map Lab** (`map/tools/lab/`, `/dev/map` from the game server's `/dev` portal).
  It's the primary review surface for the chain.
  - **World:** seed, mode, zone size and spawn counts; the chain's library
    for the zone size or the Chain Library tab's draft. A size menu lists
    the authored sizes and sets the zone size. Every view comes through `mapViews`.
  - **Layers:** one registry in `app.ts`, in chain order (51): the Layout,
    declared and resolved classes, regions, boundaries and portals, proof
    components, zone tiers and bonus, region types, loot chance, briefs, the
    region drill-down (block lots, spaces and allocation, spans, openings and
    the design graph), the built map's parts, loot, core element sites,
    contestant and hunter routes, defect regions and defect sites. Each layer names what it reads (the Layout, the stored region results,
    or a `mapViews` key), can be
    turned on or off, has an opacity, and contributes its own legend
    entries and inspector lines. Any number can be on at once, so an
    earlier stage shows under a later one. Each layer is either areas (a
    cell field, painted once per map into a canvas, or a fill) or marks
    (lines and dots). Drawing takes every areas layer, then every marks
    layer, each in registry order, so lines stay readable over areas. A
    layer belongs to one pass, so it is laid on once at its opacity: at every
    opacity it is drawn whole on the same scratch canvas first, and its own
    parts don't fade unevenly where they overlap. A new layer is one
    registry entry. A layer can also give the inspector buttons that open
    something elsewhere: in the Chain Library tab, or in a new tab. On by
    default: regions, boundaries and portals, the drill-down's lots,
    allocation and openings, the built map's parts other than roofs, core
    element sites, routes, and the defect layers.
  - **Macro layers** read the Layout and `mapViews` only. The Layout layer
    outlines each placed tile and, in its set piece class's colour, each set
    piece instance; zoomed in far enough, it labels tiles with design and
    orientation, and instances with set piece and class. It replaces the
    old lab's tile templates view. Zone bonus sits beside zone tiers. Region
    types colour each region by `brief.type`, one colour per region type of
    the map's library, steady across its maps. Loot chance is a heat field
    from each brief's zone contexts, blue to red across the map's range,
    with the percentages in the legend. Briefs draw each region's portals as
    its brief states them, a little inside the region, so a shared portal
    shows both statements, and label each region with the core elements
    assigned to it. The inspector names the cell's tile and set piece, and
    gives the brief's type, portal ids, assigned core elements, parameters
    and loot chance. The reduced-fill layer highlights owned cells excluded
    from geometry fill, and the internal-guarantees layer draws preserved
    same-owner runs. The inspector gives their counts and the known-clear
    access count. Its buttons open the tile design or set piece in the
    Chain Library tab; where the draft lacks it or differs, it asks before
    replacing the draft with the map's library.
  - **Region drill-down** (#203): selecting a cell rebuilds its region in
    the worker with `buildRegion`'s observer (56 L4), and compares the
    rebuild with the stored result. Only when they're equal are the traces
    drawn, because they describe the rebuild. A difference is a defect: the
    inspector names the first differing path and the defect regions layer
    marks the region. Five layers on the stored results draw the selected
    region's traces in world units through `map/micro/building/draw.ts`,
    the drawing the micro lab uses: a `block`'s lots (`planBlock`), each
    building's spaces and allocation, spans, openings and design graph. The
    inspector summarises each building and names any designs its strategy
    tried first and didn't use, with why (a trace's `rejected`, such as a
    `depot` warehouse that fell back to one room). It also lists the guidance
    the building didn't meet, as warnings. Its buttons open the region's brief in the micro lab,
    and a `block`'s in the generation demo too, on the game server that
    serves the lab (20.5). They also save the brief as
    JSON, which the micro lab imports.
  - **Routes** (#204): on request, the worker measures the routes a
    contestant and a hunter take between two points of the built map:
    any two core element sites, or the selected cell. It's a lab
    measurement, and feeds neither the report nor the sweep
    (`map/tools/routes.ts`). Both use the game's own route search
    (`gridRoute` in `shared/map/route.ts`, which bots use too) on
    `builtMapCollision`, with doors openable, as for a mover without keys.
    - **Lengths:** each body's length is its grid route's, through each
      40-unit navigation tile, and the ratio compares those. Ends snap to
      the nearest walkable tile within five, as a bot's do, so lengths
      differ by up to a tile or two of sampling. The panel also gives the
      length walked along the straightened route the layer draws. That
      straightening is greedy, so it isn't comparable between bodies.
    - **Squeezes:** a squeeze is each run of the contestant's route that
      the hunter's walkability grid blocks.
    - **Unreachable:** a body without a route is stated as such in the
      panel, and the layer draws a dashed line straight to the target.
    - In effect, the layer draws the portal promise (56, M29) at map
      scale. On a 12 × 6 game map a measurement takes about 70 ms.
  - **Play in the game** (#205): a room generates its map from its integer
    seed with the live recipe (`liveChainParams` in `map/live.ts`: game
    mode, one exit, the default content's roster counts, everything else
    the default), the bundled library, the game's cell size and the
    server's strategies. When the shown map is exactly that, the Play panel links to `?seed=<seed>` on the game's
    dev server (20.5), and the game page creates a room with that seed
    through `POST /api/rooms`, as its own seed field does. Otherwise the
    panel lists why not. The worker decides. A map it generates is checked
    by its recipe (`liveRecipeMismatch`). A loaded save is also compared
    with a fresh generation from its seed (`liveMismatch`), since a save
    can keep its seed and recipe and still carry an edited layout or
    results. "Use a room's recipe" sets the recipe, the bundled
    library and, if needed, a random room seed, and generates. The chain's
    seed is text, so only a seed that spells its number exactly (`"42"`,
    not `"042"`) is a room's. Loading other maps (drafts, other params)
    into a room isn't supported: it would change where a room's map comes
    from and what its replay records (26).
  - **The built map's parts** are six layers on `built`, one colour each:
    building walls, ruin walls and rubble, cover, windows, doors and roofs.
    Obstacles go by their `ObstacleKind` (`building`, `ruin-wall`,
    `container` and `crate`, `window`), and a new kind must be given a
    layer before the lab compiles. Doors are the gates; chain maps place
    every door closed and unlocked, so they have one colour. A roof is an
    enclosing element's footprint, at 60% opacity. The inspector gives the
    selected region's part counts and its elements by name, numbers
    folded together.
    The obstacle-kind sorting and part colours live in `lab/parts.ts`, which
    the Placeables tab draws with too.
  - **Inspecting:** clicking a cell fills the inspector, and hovering shows
    its first lines. Zoom with the wheel or the buttons; Reset fits the
    map, which the readout calls 100%.
  - **The report** shows beside `diagnoseBuiltMap` in a bottom pane that can be
    resized or collapsed by clicking its top border. Generation, reading a
    save and the diagnostic run in a worker, and the diagnostic runs only on
    request and can be cancelled.
  - **Saving:** wire 8 as JSON or BSON, or the Layout alone. A save loads
    with its embedded library, independently of the current Lab selection. Its bytes equal the CLI's for the same
    seed, which the browser test checks.
  - **The Chain Library tab** ([51.1](51.1-principles-and-names.md); 51 B1)
    authors the generation chain's version 3 library schema, validates
    import and export, and previews tile-local derived portals and invalid
    passable prescriptions. Its perimeter preview is provisional until
    placement resolves neighboring tiles. It can load the chain's library for
    the World tab's zone size to edit it. Tile design authoring features an
    interactive canvas stage with row and column gutters, swatches for declared
    cell classes, continuous drag-painting, flood fill, rectangle fill,
    Alt-click eyedropper sampling, quick patterns, and a right-click context palette (#303);
    on-stage segment passability overlays and drag stamping (#304); a visual tile
    thumbnail gallery with search/filtering, template cloning, and World view inspection links (#305);
    a visual tile sets manager with split member and searchable available tile thumbnail galleries
    and non-empty validation enforcement (#306); an interactive 2D layout blueprint grid
    and palette editor for set pieces with member tile slot thumbnails, rotation controls,
    tier eligibility checkboxes (tiers 1–5), referencing set piece classes binding with
    placement rules derived from `PLACEMENT_RULES` in the schema (`transit` included) and
    quotas (#307, #315);
    and canvas tool hotkeys (D, F, R, S, E), numeric brush switching (1-9 for cell classes starting with any in tiles, and visible tile sets in set pieces), stable ID and test coverage for the stage hover readout (#chainHoverReadout), and '/' search focus shortcut (#317).
    **Saved drafts (#390):** reopening browser storage uses an editor safety
    check, separately from `validateLibrary`. A resolved version 3 draft can
    retain empty collections (including orientations, members and slots),
    unresolved references, invalid quotas/rule values and unknown fields. Loading
    and browsing do not normalize, remove or save those values; validation issues
    remain visible. Known fields must have their expected scalar/container types;
    supplied cell grids must be six rows of six marks with a legend entry for
    each non-dot mark, and segment keys/prescriptions must be structurally readable.
    Unsupported versions, malformed JSON and unsafe nested structures load the
    starter library with a warning. The gate lives in `map/tools/lab/draft-safety.ts`
    and is never stricter than `validateLibrary`, which
    `tests/map-lab-draft-safety.test.js` holds. This is a local editor contract, not a change
    to library validity in [52](52-map-primitives-and-library.md).

    Rejected saved text stays byte-for-byte at `last-exit-chain-library-v3` until
    the first edit saves a recovery copy under a new
    `last-exit-chain-library-v3:rejected:<unique suffix>` key. The status after
    that save names the key (later saves clear it); browser developer tools' local-storage view can retrieve its raw
    value for repair. Recovery copies are never overwritten or automatically
    deleted. If that backup fails, autosave does not replace the original and
    reports that edits were not saved. Safe incomplete drafts save and reopen
    without requiring publication validity. A blueprint exceeding 10,000 grid
    cells shows a notice instead of building the grid; its exact coordinate
    editor remains usable and the stored layout is unchanged.

    Apply JSON, file import and export still require full library validation;
    imports also pass the editor safety gate before replacing the active draft.
    Refused imports preserve the active library and saved draft; refused Apply
    leaves the submitted source text available to correct. World generation
    retains its full library and strategy checks. A safely reopened draft is not
    a publishable library or a promise that its region strategies exist.
  - **The Placeables tab** (#433; `lab/placeables.ts`) lists `PLACEABLES`
    (20.8) with each one's version and summary, and previews every example
    at the brief's default cell size (`DEFAULT_CELL_SIZE`, 48): the demand's
    body and clear boxes (`demandShapes`), and the elements' parts in the
    World tab's colours. Its parameters are edited by their specs (a number
    input with the spec's bounds, a checkbox, or a menu) and built through
    `buildPlaceable`, as a tool's unchecked input is. Out-of-spec values
    aren't clamped: the readout shows `placeableErrors`, the placeable's
    `check`, or a refusal's reason in place of a preview. A building
    placeable's `details` (design, allocation, realization) are drawn and
    summarised as the drill-down's trace: spaces, openings, designs not
    used and guidance not met.
  - **Serving:** The game server (`server/index.js`) serves the lab at `/dev/map` when `devTools` is enabled, alongside macro's `content/`, `map/micro/`, `map/kernel/`, `shared/`, the map-level
    modules `map/chain.ts`, `map/engines.ts` and `map/live.ts`, and the
    tools' `core.ts`, `engines.ts` and `routes.ts`, at their repository
    paths. It erases types on the way out, and resolves
    the bare `sat` and `pathfinding` imports for the page and its worker
    alike. Each is its CommonJS package wrapped as one ES module.
  - The old generators' map view, tile editor and playtest sandbox retired
    with the move (#145). Play in the game replaces the sandbox.
- **CLI** (`node map/tools/cli.mts`, from the repository root): `generate`
  (JSON or BSON, or `--layout-only true`), `validate` (a saved map, read with
  the library it was made from, or a library; `--diagnose true`), `batch`
  (sample size, metric distributions with generation time, set piece share
  and loot per tile, defects and failures), `library` (for
  `--zone-width` and `--zone-height`, by default 12 × 6) and `sweep` (above).
  Module files use `name@version.json`; all includes, including nested ones,
  resolve beside the top library file, not relative to the including module.
- **MCP** (`node map/tools/mcp.mts`): bounded stdio tools `map_generate`,
  which returns the wire map with its report, `map_validate`,
  `library_validate`, `map_batch` (at most 5 maps when diagnosed) and
  `library_get` (for the zone size in its `params`). It is registered in the workspace `.agents/mcp_config.json` for agent use.
- **The game's micro tools** (the micro lab, the decomposition lab, the
  generation demo, and the `micro-region` and `decompose-region` CLIs) are
  in 20. All the browser tools share one navigation bar.
- **Delegation candidate audit** (`node tools/delegation-adoption-audit.mjs
  --seeds=20 --maps=1 --out=test-results/331-audit`) measures current compound
  and depot output, separates a diagnostic compound exterior mask from the
  intentional court, tries explicit cover witnesses through the SDK, and writes
  JSON plus collision-geometry SVG previews. This is a read-only investigation,
  not production patch authorship, an admission check or a baseline capture.
  Workload, findings and limits are in [42](42-performance-history.md).
- **Compound adoption audit** (`node tools/compound-delegation-audit.mjs
  --seeds=20 --maps=1 --out=test-results/338-after`) compares production
  compound decisions against the preserved `test-results/331-audit/report.json`
  from `types-24` (before-source checkpoint `ff9fd1b`). Reproduce that before
  directory with the candidate audit at the old source, before changing content;
  do not overwrite it by running the old audit on the current adopter. The new
  audit refuses a before report from another content version. It writes
  per-region diagnostic, protected, offered, accepted and rejected footprints,
  reasons, stopping/version traces, fill and sequential build timings, full and
  omitted-result snapshot recovery, final containing/leaf/crossing geometry and
  sampled hunter routes to the rooms, court and gate yard stands. It also
  inspects nested block compound lots. Previewed cases also write complete
  owning snapshots and omitted-result snapshots for independent inspection.
  SVGs compare retained ring-only geometry
  with combined output; they are collision previews, not roofs or movement.
  Failed geometry/access/recovery checks produce a nonzero exit. Workload,
  uptake, siting corrections and limits belong in [42](42-performance-history.md).

The GUI, CLI and MCP call one shared core and must agree on seed, parameters,
library, validation and serialized output. Verification gates for both halves
are in 31.

The read-only `tools/compound-siting-audit.mjs` captures the exact #340 compound
input, the bounded production siting trace and emitted collision/access preview.
It can regenerate the current map or load the original checked-in focused brief, requiring
no earlier audit reports. Reproduction, diagnosis and limits are in
[42](42-performance-history.md). `tools/compound-siting-solution-audit.mjs`
compares the preserved original input with the authored correction, validates
room/court/actual gate and original portal access, and emits before/after collision
previews. The tools themselves are read-only; the subsequent library correction
is a deliberate content change, with baseline provenance recorded separately.
Both are evidence for that record, not maintained tooling: they pin #340's seed
and counts, and later content or builder changes may legitimately break them.

## Provenance rule

User-authored design notes and Corey's recorded answers (17) are
authoritative for intent. Numbers or proposals that appear only as assistant
recommendations aren't requirements until Corey adopts them. Examples: NFT
budgets, 750 m, 12 × 12 tiles, a trapezoid boundary, and the planned path
(50). Before building on an existing mechanism, trace whether Corey asked for
it or an agent added it.
