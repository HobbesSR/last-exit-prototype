# 53. Map artifacts, determinism and tools

Status: current for the generation chain (51), its sweep, and its Map Lab, CLI and MCP ([53.1](53.1-map-lab-and-tools.md)). mapgen's
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
| Region strategy content | `types-45` | `REGION_TYPES_VERSION` in `map/micro/region-types.ts`; changes saved build identity and sweep results |
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
The current baseline provenance is content commit `68444841d52f4787f3d6232f5b2d038e2603eca8`,
captured `2026-10-28T00:44:44.029Z` under Node v24.15.0 (#619 / #531, 42.4).
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

### Replaying one region type

A builder change can't move anything upstream of the briefs, yet the full sweep
regenerates every map to find which `built` views moved. The replay (#541,
`map/tools/sweep-briefs.mts`) is the inner check before it, for a change to one
region type's builder. It doesn't replace the full sweep, which stays the
integration check and the way to recapture.

- `node map/tools/cli.mts sweep --capture-briefs map/tools/fixtures/chain-baseline.json`
  writes every sweep map's region briefs, bucketed by region type, to a gitignored
  cache (`test-results/sweep-briefs`, or `--cache DIR`). Beside each brief it keeps what the
  baseline's builders made of it: a hash of the result and the manifest. The capture
  runs the whole sweep, so it takes as long, and it refuses a tree whose hashes differ
  from the baseline's: a cache of other builders would pin their results. Capture before
  editing a builder, or from a checkout that matches the baseline.
- `sweep --check FILE --type plant` rebuilds only that type's briefs, in parallel, and compares
  each result's hash with the cache's. `--type` takes a list, and a type bound to another's
  strategy is replayed with it (`market` is `hall`'s). It reports, per region and not per map:
  - **`drift`**: the regions whose result moved, by map and region id, with the manifest counts
    that moved (an empty set means the geometry moved and no count did);
  - **`threw`**: the regions whose builder threw on a brief it built before;
  - **`brokenPromises`**: the portal check (`diagnoseRegion`, the check behind `validate
    --diagnose`) on each region. It runs on drifted regions by default, because a region whose
    result matches the baseline's can't have a finding the change caused, and the check costs
    seconds a region for the largest types. `--reach all` checks every region, `--reach none`
    none;
  - **`features`**: the type's own manifest counts (for plant: machines, pipes, sheds,
    designed buildings, infill crates), as a total and the number of regions holding any, so a
    corpus too thin to test a feature is visible. A replay is refused, rather than reported
    clean, if the cache holds no region for any one requested strategy; one that was
    exercised can't stand in for another, though `hall` and `market` count together.

  Any drift, throw or finding exits 1.
- **The cache is valid exactly while the baseline's `briefs` and `results` hashes for each
  map are the ones it was captured against.** The chain is pure (51), so the briefs hash
  says the briefs are unchanged. The results hash says the stored result hashes are of the
  baseline's builders: a recapture after a builder change moves it though `briefs` doesn't.
  A replay against a cache the baseline has moved past is refused, naming the count of maps,
  and says to recapture. Recapture the cache after each baseline recapture.

Measurements are in [42.3](42.3-generation-and-delegation-evidence.md#brief-replay-541-2026-10-27).

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

The tools that show both halves, the Map Lab, CLI and MCP and the read-only
audits, are in [53.1](53.1-map-lab-and-tools.md#tools). They read and write
the artifacts this file specifies.

## Provenance rule

User-authored design notes and Corey's recorded answers (17) are
authoritative for intent. Numbers or proposals that appear only as assistant
recommendations aren't requirements until Corey adopts them. Examples: NFT
budgets, 750 m, 12 × 12 tiles, a trapezoid boundary, and the planned path
(50). Before building on an existing mechanism, trace whether Corey asked for
it or an agent added it.
