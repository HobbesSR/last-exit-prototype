# Last Exit mapgen (macro)

Macro generation for Last Exit, in `map/macro/` of the game repository: the tile library, placement, resolution, layout regions, the reachability proof, region briefs and the report, as the stages of the generation chain. It reads no game files, only the map kernel in `map/kernel/`; the game lends it region strategies through the map-level assembly in `map/engines.ts` and `map/chain.ts`, which the tools reuse (root [50](../../docs/50-map-generation.md), [22.2](../../docs/22.2-map-generation.md)). The [archived original user notes](../../docs/archive/2026-11-14-mapgen-intent/design_notes.txt) preserve historical design intent. The later assistant proposal has been [retired to the archive](docs/archive/retired-design-proposal/README.md).

Design documentation lives in the repository's numbered docs: [50](../../docs/50-map-generation.md) (overview and ownership), [51](../../docs/51-generation-chain.md) (the generation chain and guide to individual stages), [52](../../docs/52-map-primitives-and-library.md) (the library model), [53](../../docs/53-map-artifacts-and-tools.md) and [53.1](../../docs/53.1-map-lab-and-tools.md) (artifacts and tools), and [17.2](../../docs/17.2-map-questions.md) (map questions and answers by topic). What's next is in [41](../../docs/41-roadmap.md) and on the Forgejo tracker it names.

## Layout

- `src/chain/`: the chain's stages and views ([51](../../docs/51-generation-chain.md)), the map container and its one accessor (`map.ts`), and saving (`saving.ts`; active compatibility domains in [53](../../docs/53-map-artifacts-and-tools.md)).
- `src/wfc.ts`: the fill's solver, over named relations, with the open-face rule's backjumping (51 step 4).
- `src/coding.ts` and `src/bson.ts`: the wire form's packing, the library fingerprint, and the in-house BSON codec (53).
- `content/`: the chain's libraries, one top-level `diamond-*.json` per authored zone size (12 × 6 is the default), with the versioned modules they resolve ([52](../../docs/52-map-primitives-and-library.md), [55](../../docs/55-zone-plans.md)). `map/chain.ts` lists the bundled ones.
- `tests/` (and `tests/slow/`): each stage's unit and larger-size quota tests, with fixture libraries that exercise every rule.

Pre-chain generators retired at the switch-over (#146) are described in the [archived docs](docs/archive/pre-integration/README.md).

## Run

Node 24.15 or newer. No runtime packages are required. Sources are TypeScript,
and Node runs them directly, so there is no build step and no compiled copy to drift.

```powershell
npm test   # typecheck plus unit and slow quota tests
```

The Map Lab (`/dev/map`), CLI, MCP and the chain's seed sweep are in [`map/tools/`](../tools/) ([53.1](../../docs/53.1-map-lab-and-tools.md), [README.authoring.md](../../README.authoring.md)). Run them from the repository root:

```powershell
node map/tools/cli.mts generate --seed experiment-1 --out map.json
node map/tools/cli.mts validate map.json --diagnose true
node map/tools/cli.mts batch --seed experiment --count 20
node map/tools/cli.mts navigation map.json --out nav-report.json
node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json
node map/tools/mcp.mts
```

`npm install` only installs development formatting tools.

## License

Original map generator code and assets are licensed under the repository's [MIT License](../../LICENSE).
