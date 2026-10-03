# 53. Map artifacts, determinism and tools

Status: current for mapgen's old paths and the chain's Map Lab, CLI and MCP; the
rules carry into the chain (51). Updated 2026-10-03.

## One seed decides the whole map

With the same engines and library, the seed and params determine every object
in the chain (Corey, 2026-09-27):
- Randomness is drawn only from streams named for the step. A region's
  randomness comes from its own seed, keyed on the map seed and its own cells,
  so changing one region's seed changes only that region.
- Nothing draws from a stream another step shares.
- Each step is a function of the objects before it, and doesn't change them.

`map/macro/tests/generation-chain.test.ts` pins this for the old paths: the same
seed gives deep-equal maps, and a saved layout alone regenerates the stored
interiors. The chain's stages get the same pins from
`map/macro/tests/chain-harness.ts` (51 step 3): purity, determinism, and that a
view is recomputable from saved objects.

## What is stored

Two rules apply, in order:
1. **Don't store what can be derived.** In the chain, only the Layout and the
   region results hold decisions, and every other stage output is a view (51).
2. **Pack what's left** as an interned palette plus run-length codes, in one
   shared mechanism (`map/macro/src/coding.ts`).

**Why packing works:** a map addresses tens of thousands of each primitive,
and their metadata is almost entirely enumerated values drawn from a small
set. Stored as arrays of objects, an artifact spends most of its bytes
re-spelling key names and enum members. The values are strongly coherent in
space, so runs are long: a default map's 130,140 segments draw on a palette of
eight spans. It stays plain, readable JSON.

**Saving** (Corey, 2026-09-27, verbatim in 17): every stage object can be
saved alone or together, and a missing one is regenerated on read. Each saved
object records its inputs and the version of the algorithm that made it.
Regenerating a missing object with a different algorithm is refused by name,
not done silently (#70, 51 step 9).

## The wire form

The shape that is convenient in memory is the wrong shape to store.
Serialization goes through a distinct wire form, which applies the same two
rules:
- Everything derivable is dropped and rebuilt on read. Wall lists come from
  the primitives through the one function used when generating, so geometry
  can't drift from what implies it.
- Every enumerated value goes once into a shared `strings` table and travels as
  an integer.
- Every bulk field becomes a column in the narrowest integer lane that holds
  it.

**Today:** wire version 4 carries mapgen's old paths.
- A V2 map stores its layout (each slot's design, orientation and set piece;
  the class grid with `any` kept; its own segment grid; feature slots; the
  library fingerprint) and its interiors.
- A planned map stores its planned layout instead.
- `decodeArtifact` rebuilds a map deep-equal to the generated one, less the
  metrics that count the generator run.
- Versions 1–3 are refused by version, with no migration and no legacy
  reader.

A map records the fingerprint of its library and is read back only with that
library.

**The chain** is wire version 6 (51 step 9, `map/macro/src/chain/saving.ts`).
Version 5 is refused by name: its params have no `contestantCount` or
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
- Versions 1–4 are refused by name. `decodeArtifact` keeps reading 4 until
  the switch-over (step 10), and names version 5 as a chain map.

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
- **Sizes**, for a default map of 936 tiles and 260,281 addressed primitives:
  about 1,050 KB in memory, 397 KB as wire JSON, and 280 KB as BSON.

## Proving a change: the sweep

`node tools/cli.mts sweep --check tests/fixtures/layer-baseline.json` (run
from `map/macro/`) reruns the pinned seed set and compares per-layer content
hashes: 329 maps across both old generators, several sizes and a builder-bound
library.
- `LAYER_FIELDS` in `tools/sweep.mts` is the only code that knows where each
  field lives, and hashing refuses a field no entry claims.
- **A behaviour-preserving change** must leave every hash unchanged. A moved
  hash is a stop-and-escalate.
- **A deliberate content change** says so in its PR, and recaptures the
  baseline last, after validation and playability pass unmodified.

The chain changes content by design. Its first baseline is captured at the
switch-over (51 step 10), and the old baseline is no reference for it.

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
  share: params over `DEFAULT_CHAIN_PARAMS`, the chain's library (imported as
  JSON, so it runs in Node and the browser alike), the report, and
  `diagnoseBuiltMap` beside it on request, since it takes about a minute on a
  game map. A game map generates in about 0.6 s, and saves to about 200 KB of
  wire JSON, or 11 KB as the Layout alone.
- **Map Lab** (`map/tools/lab/`, `npm run lab` from the repository root, port
  4173 or the worktree's `MAPGEN_PORT`). It's the primary review surface for
  the chain.
  - **World:** seed, mode, zone size and spawn counts; the chain's library or
    the Chain Library tab's draft. Every view comes through `mapViews`: the
    cells coloured by declared or resolved class, region, proof component or
    zone tier, with boundaries and portals, the built map's geometry, core
    element sites, loot and defects over them, and an inspector per cell.
  - **The report** shows beside `diagnoseBuiltMap`. Generation, reading a
    save and the diagnostic run in a worker, and the diagnostic runs only on
    request and can be cancelled.
  - **Saving:** wire 6 as JSON or BSON, or the Layout alone. A save loads
    with the library chosen in the lab. Its bytes equal the CLI's for the same
    seed, which the browser test checks.
  - **The Chain Library tab** (51 B1) authors the version 2 schema, validates
    import and export, and previews tile-local derived portals and invalid
    passable prescriptions. Its perimeter preview is provisional until
    placement resolves neighboring tiles. It can load the chain's library to
    edit it.
  - **Serving:** `map/tools/server.mts` serves the lab, macro's `src/` and
    `content/`, `map/micro/`, `map/kernel/` and `shared/` at their repository
    paths, and nothing else. It erases types on the way out, and resolves
    the bare `sat` import for the page and its worker alike.
  - The old generators' map view, tile editor and playtest sandbox retired
    with the move (#145).
- **CLI** (`node map/tools/cli.mts`, from the repository root): `generate`
  (JSON or BSON, or `--layout-only true`), `validate` (a saved map, read with
  the library it was made from, or a library; `--diagnose true`), `batch`
  (sample size, metric distributions, defects and failures) and `library`.
- **MCP** (`node map/tools/mcp.mts`): bounded stdio tools `map_generate`,
  which returns the wire map with its report, `map_validate`,
  `library_validate`, `map_batch` (at most 5 maps when diagnosed) and
  `library_get`. It is not registered in any agent client by default.
- **mapgen's old CLI and MCP** (`map/macro/tools/`) still drive the old
  generators, with the sweep, until they are deleted (#146). They have no
  browser view any more.
- **The game's micro tools** (the micro lab, the decomposition lab, the
  generation demo, and the `micro-region` and `decompose-region` CLIs) are
  in 20. All the browser tools share one navigation bar.

The GUI, CLI and MCP call one shared core and must agree on seed, parameters,
library, validation and serialized output. Verification gates for both halves
are in 31.

## Provenance rule

User-authored design notes and Corey's recorded answers (17) are
authoritative for intent. Numbers or proposals that appear only as assistant
recommendations aren't requirements until Corey adopts them. Examples: NFT
budgets, 750 m, 12 × 12 tiles, a trapezoid boundary, and the planned path
(50). Before building on an existing mechanism, trace whether Corey asked for
it or an agent added it.
