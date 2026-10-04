# Last Exit mapgen (macro)

Macro generation for Last Exit, in `map/macro/` of the game repository: the tile library, placement, resolution, layout regions, the reachability proof, region briefs and the report, as the stages of the generation chain. It reads no game files, only the map kernel in `map/kernel/`; the game lends it region strategies through `map/tools/` (root 50). [Original user notes](design_notes.txt) are the source of design intent. The later assistant proposal has been [retired to the archive](docs/archive/retired-design-proposal/README.md).

Design documentation lives in the repository's numbered docs: [50](../../docs/50-map-generation.md) (overview and ownership), [51](../../docs/51-generation-chain.md) (the generation chain and guide to individual stages), [52](../../docs/52-map-primitives-and-library.md) (the library model), [53](../../docs/53-map-artifacts-and-tools.md) (artifacts and tools), and [17.2](../../docs/17.2-map-questions.md) (map questions and answers by topic). What's next is in [41](../../docs/41-roadmap.md) and on the Forgejo tracker it names.

## Layout

- `src/chain/`: the chain's stages and views (51), the map container and its one accessor (`map.ts`), and saving in wire version 6 (`saving.ts`).
- `src/wfc.ts`: the fill's solver, over named relations, with the open-face rule's backjumping (51 step 4).
- `src/coding.ts` and `src/bson.ts`: the wire form's packing, the library fingerprint, and the in-house BSON codec (53).
- `content/chain-library.json`: the chain's library (52, "The chain's library").
- `tests/`: each stage's tests, with fixture libraries that exercise every rule.

mapgen's old generators, `generateMap` and `generatePlannedMap`, with streets, anchors, its own micro layer, its planned path, the old library, CLI, MCP and sweep, were deleted at the switch-over (51 step 10, #146). They are in git history before that change, and the [archived docs](docs/archive/pre-integration/README.md) describe them.

## Run

Node 24.15 or newer. No runtime packages are required. Sources are TypeScript,
and Node runs them directly, so there is no build step and no compiled copy to drift.

```powershell
npm test   # typecheck plus unit tests
```

The Map Lab, CLI, MCP and the chain's seed sweep are in [`map/tools/`](../tools/) (53, "Tools"). Run them from the repository root:

```powershell
npm run lab
node map/tools/cli.mts generate --seed experiment-1 --out map.json
node map/tools/cli.mts validate map.json --diagnose true
node map/tools/cli.mts batch --seed experiment --count 20
node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json
node map/tools/mcp.mts
```

`npm install` only installs development formatting tools.
