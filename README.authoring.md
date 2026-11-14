# Content Authoring and Developer Labs Guide

Up: [README.md](README.md). This quick-start guide is for content authors building tile and set-piece libraries, region strategies, placeable assemblies, or content presets with Last Exit's procedural generation tools.

## Starting the Developer Portal

Start the dev server from the repository root:

```powershell
npm run dev
```

Open `http://127.0.0.1:3100/dev` (or your worktree's configured `PORT` in `.env.local`). All browser labs share a top navigation bar and run directly against the TypeScript source without a separate build step.

## Browser Labs Catalog

Owned by [docs/53.1-map-lab-and-tools.md](docs/53.1-map-lab-and-tools.md) and [docs/20.5-tools-and-next-boundaries.md](docs/20.5-tools-and-next-boundaries.md); shared tool architecture is in [docs/22.8-development-tools.md](docs/22.8-development-tools.md).

| Lab route | Purpose | Owning docs |
| --- | --- | --- |
| **`/dev/map` — Map Lab** | Whole-map generation-chain inspector and editor. **World** previews every pipeline stage (`Layout`, resolved classes, regions, portals, reachability proofs, zone tiers, loot heatmaps, region building drill-downs, and grid vs. bot-mesh routes) and launches matching seeds into a live room. **Placement** records and scrubs WFC placement traces and open-face refusals. **Chain Library** edits and validates version 3 tile designs, segment prescriptions, tile sets, and set pieces. **Placeables** previews parameterized element assemblies. | [53.1](docs/53.1-map-lab-and-tools.md), [51](docs/51-generation-chain.md), [52](docs/52-map-primitives-and-library.md) |
| **`/dev/micro` — Region Builder Explorer** | Interactive workbench for individual micro region strategies (`depot`, `compound`, `block`, `hut`, `park`, `plant`, `ruins`, `market`, etc.) over example shapes or `#brief=` links exported from the Map Lab. Inspect building design graphs, space allocations, spans, roofs, and portal clearance routes, and walk the collision geometry as either role (`WASD`, `E` for doors). | [20.5](docs/20.5-tools-and-next-boundaries.md), [54](docs/54-region-types.md), [56](docs/56-buildings.md) |
| **`/dev/micro/decomposition` — Decomposition Inspector** | Visualizes polyomino region partitioning, neck cuts, candidate footprints, residual scoring, and bounded recursive allocation trees in **Flat** and **Tree** modes. | [19](docs/19-decomposition-design.md), [20.4](docs/20.4-hierarchical-generation.md), [20.5](docs/20.5-tools-and-next-boundaries.md) |
| **`/dev/micro/generation` — Generation Trace** | Step-by-step walkthrough of a decomposing `block` region across *Region → Decomposition → Generated → Walk* stages. | [20.5](docs/20.5-tools-and-next-boundaries.md), [20.3.5](docs/20.3.5-district-and-core-element-builders.md) |
| **`/dev/physics` — Physics Playtest** | Local browser workbench for character contact and doorway crowd squeezes, pushable rotated crates and physical loot, the gladiator hook tether, and isolated squish/jelly prototypes, with solver overlays and deterministic JSON trace export/rerun. | [42.20](docs/42.20-physics-p9.md), [29.1](docs/29.1-physics-design.md) |

## Command-Line and MCP Tools

Run from the repository root (full options in [53.1](docs/53.1-map-lab-and-tools.md) and [20.5](docs/20.5-tools-and-next-boundaries.md)):

```powershell
New-Item -ItemType Directory -Force -Path test-results | Out-Null

# Macro-to-micro generation chain CLI (map/tools/cli.mts)
node map/tools/cli.mts generate --seed experiment-1 --out test-results/map.json
node map/tools/cli.mts validate test-results/map.json --diagnose true
node map/tools/cli.mts batch --seed experiment --count 20
node map/tools/cli.mts navigation test-results/map.json --out test-results/nav-report.json
node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json

# Micro region and decomposition CLIs
node tools/micro-region.mjs --type=compound --shape=hole --width=36 --height=30 --seed=42 --out=test-results/region.json
node tools/micro-region.mjs --validate=test-results/region.json
node tools/decompose-region.mjs --shape=neck --out=test-results/decomposition.json
npm run fill

# Stdio MCP server for map generation and library validation (.agents/mcp_config.json)
node map/tools/mcp.mts
```

Before editing one region builder, capture the baseline briefs from a checkout whose builders match the baseline. This runs the full sweep and stores a local cache; see [Replaying one region type](docs/53-map-artifacts-and-tools.md#replaying-one-region-type). The replay is an inner-loop check, not the full sweep required before a PR ([The replay or the full sweep](docs/31-verification.md#the-replay-or-the-full-sweep)).

```powershell
node map/tools/cli.mts sweep --capture-briefs map/tools/fixtures/chain-baseline.json
# Edit the depot builder, then replay its cached briefs while iterating:
node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json --type depot
```

## Authoring Workflow and Content Rules

1. **Understand the two halves:** Macro generation (`map/macro/`, [map/macro/README.md](map/macro/README.md)) places tiles, resolves regions, proves macro reachability, and emits `RegionBrief` records. Micro generation (`map/micro/`) fills each region brief and keeps its portal passability promises. What both share lives in `map/kernel/` ([50](docs/50-map-generation.md)).
2. **Edit authored data as files or export from the labs:** Bundled tile and set-piece libraries live in `map/macro/content/` (`diamond-12x6.json`, `diamond-24x12.json`, `diamond-36x18.json`, and their versioned `@version.json` modules; [52](docs/52-map-primitives-and-library.md), [52.1](docs/52.1-perimeter-authoring.md), [55](docs/55-zone-plans.md)). Region strategies live in `map/micro/strategies/`, building designs in `map/micro/building/`, and placeables in `map/micro/placeables/` ([54](docs/54-region-types.md), [56](docs/56-buildings.md), [20](docs/20-micro-generation.md)). Match tuning presets (`content-7` default, `content-8`–`12`, `content-loot-1`, `content-ammo-1`) live in `shared/simulation/content.ts` ([14](docs/14-match-rules.md)).
3. **Verify and batch content changes:** While iterating on one region builder, follow the [brief-cache capture and replay steps](docs/53-map-artifacts-and-tools.md#replaying-one-region-type). Changes that move generated maps by default follow the one-bump-per-batch policy in [docs/31-verification.md](docs/31-verification.md#content-changes-one-bump-per-batch) and [docs/53-map-artifacts-and-tools.md](docs/53-map-artifacts-and-tools.md).
