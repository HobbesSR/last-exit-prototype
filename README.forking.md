# Forking and Architecture Guide

Up: [README.md](README.md). This guide is for developers using Last Exit as the starting point for their own fork or inspecting its engineering structure, verification suite, and licensing obligations.

## Complete Repository Tree

Subsystem ownership and enforced import boundaries are documented in [docs/22-ownership.md](docs/22-ownership.md) and [docs/50-map-generation.md](docs/50-map-generation.md).

```text
├── shared/                  # Portable TypeScript core shared by server and browser (never imports map/)
│   ├── simulation/          # Fixed-tick coordinator (game.ts, tick.ts), content presets, bots, combat
│   ├── physics/             # Required Rapier 2D adapter, bodies, props, hook tether, local prediction
│   ├── navigation/          # Portal graph, discovery knowledge tiles, optimistic planner, local repair
│   ├── map/                 # World dimensions, generation context, and element-stamping layer
│   ├── shape.ts             # Dependency-free rect/circle/polygon primitives and SAT queries
│   ├── shape-construction.ts# Clipper polygon union/subtraction/erosion and constrained triangulation
│   ├── free-space.ts        # Clearance-eroded free-space navmesh and funnel corridors
│   ├── movement.ts          # Occupancy, swept movement, sight queries, and visibility polygons
│   ├── equipment.ts         # Weapon tables, 6-slot inventory operations, and item transfers
│   ├── item-instances.ts    # Persistent L0 item identity, lineage, and ground-drop allocation
│   ├── protocol.ts          # Wire format validation and client/server message contracts
│   ├── frame-layers.ts      # Keyframe and delta encoding for slow-changing live frame layers
│   ├── recording-format.ts  # Schema 17 NDJSON keyframe/delta replay encoder, reader, and checkpoints
│   └── ...                  # View projections, presentation descriptors, traps, profiler, deterministic math
├── map/                     # Procedural map generation (builds on shared/; boundaries tested)
│   ├── kernel/              # Zero-dependency shared map space: contract.ts, scale.ts, cell.ts, run.ts, margins.ts
│   ├── macro/               # Macro generator ("mapgen"): WFC solver, chain stages (src/chain/),
│   │   ├── content/         #   Bundled diamond-12x6, -24x12, -36x18 libraries and versioned modules
│   │   └── tests/           #   Standalone macro unit and slow quota suites (npm run test:mapgen)
│   ├── micro/               # Micro generation SDK (sdk.ts), region strategies, building designs, placeables
│   ├── tools/               # Shared core.ts, Map Lab (lab/), CLI (cli.mts), MCP (mcp.mts), seed sweep
│   ├── chain.ts             # Connects macro stages to bundled libraries and region engines
│   ├── engines.ts           # Lends map/micro/ region strategies to the macro chain as MapEngines
│   └── live.ts              # Runtime adapter converting built chain maps into playable GameMap arenas
├── server/                  # Authoritative 20 Hz Express/WebSocket server
│   ├── index.js             # HTTP/WebSocket composition, static/TypeScript asset serving, /dev routes
│   ├── room-service.js      # Room lifecycle, lobbies, matchmaking, reconnect tokens, tick scheduling
│   ├── map-pool.js          # Worker-thread live map generation pool
│   ├── replay-writer.js     # Bounded worker-thread gzip NDJSON replay recorder
│   └── vendor-modules.js    # Serves browser vendor directories and CJS-to-ESM wrapped dev modules
├── public/                  # Browser client and developer labs
│   ├── client.js            # Startup, WebSocket networking, prediction/reconciliation, lobby flow
│   ├── arena-scene.js       # Phaser scene: camera, visibility mask, roof cutaways, layer ordering
│   ├── static-drawing.js    # Map geometry drawing into public/tile-cache.js
│   ├── frame-drawing.js     # Per-frame dynamic actors, items, projectiles, and overlays
│   ├── snapshot-buffer.js   # Delayed interpolation buffer for remote entities
│   ├── replay-controller.js # Streamed replay playback, timeline scrubbing, and diagnostic markers
│   └── dev/                 # Shared /dev navigation bar and Physics Playtest (/dev/physics)
├── docs/                    # Numbered product (1x), engineering (2x), process (3x), plan/history (4x), map (5x) docs
├── tests/                   # Fast unit tests (*.test.js), slow suites (slow/), browser scripts (*.browser.mjs),
│   ├── fixtures/            #   Frozen physics baseline (behavior-physics-1.v8.gz) and room arena fixture
│   └── helpers/             #   Shared arena/scenario builders, room harness, browser launcher, machine lock
└── tools/                   # CLI utilities, doc link checker, third-party notice generator, perf/audit harnesses
```

## Stack and Architectural Boundaries

Read [docs/21-stack.md](docs/21-stack.md), [docs/22-ownership.md](docs/22-ownership.md), [docs/23-types.md](docs/23-types.md), and [docs/50-map-generation.md](docs/50-map-generation.md) before changing cross-cutting modules:

- **No build step:** Node.js (`>=24.15.0`) runs `.ts` and `.mts` files directly via native type stripping, and `server/index.js` strips types when serving `shared/` and `map/` modules to the browser. Keep TypeScript syntax within Node's erasable subset ([23](docs/23-types.md)).
- **Enforced module boundaries:** `map/kernel/` imports nothing outside itself; `shared/` never imports `map/`; `map/macro/` and `map/micro/` never import each other except where macro calls `map/micro/sdk.ts`; server application code never reaches into `room.game` directly. Automated boundary tests enforce these rules.
- **Simulation invariants:** Preserve fixed-tick phase order, one-input-per-tick processing, deterministic RNG and item ID allocation, and replay compatibility ([14](docs/14-match-rules.md), [26](docs/26-recording-contract.md)). The frozen characterization fixture (`tests/fixtures/behavior-physics-1.v8.gz`) guards simulation behavior across refactors—never regenerate it to make a refactor pass ([31](docs/31-verification.md#the-frozen-fixture), [tests/fixtures/README.md](tests/fixtures/README.md)).
- **Operational limits:** This repository targets local and LAN play. What a public internet deployment would require is recorded in [docs/28-operational-limits.md](docs/28-operational-limits.md).

## Verification and Benchmark Commands

Full verification policy, test sets, and area-specific check selection live in [docs/31-verification.md](docs/31-verification.md), [docs/31.1-test-catalogue.md](docs/31.1-test-catalogue.md), and [docs/31.2-benchmarks-and-timing-tools.md](docs/31.2-benchmarks-and-timing-tools.md).

```powershell
# Before-PR verification gates
npm run check                        # Parses JS modules and checks clean TypeScript type erasure
npm run typecheck                    # Strict tsc --noEmit across shared/, map/micro/, map/kernel/, map/tools/
npm test                             # Fast unit and integration suite (concurrency-capped at 4)
npm run test:mapgen                  # Typecheck and unit/quota suite in map/macro/

# Targeted test sets and link checks (use `npm run brief --` for compact output)
node tests/sets.mjs list             # List test sets (tooling, geometry, client, simulation, physics, rooms, macro, micro)
node tests/sets.mjs changed          # Show sets touched on the current branch
npm run brief -- test:set physics    # Run one set's fast unit tests
node tools/check-doc-links.mjs       # Verify all local Markdown links and anchors in docs/ and README*.md

# Slow, browser, and timing suites (run only when the changed area calls for them)
npm run test:slow                    # Slow seed sweeps and whole-match bot runs (tests/slow/)
npm run test:browser                 # All Playwright Chrome scripts (game, dev view, labs, physics)
npm run test:times -- tests/foo.test.js # Isolated per-file timing against 15s (fast) / 60s (slow) budgets

# Headless and browser performance benchmarks
npm run bench                        # Headless server simulation tick and room-capacity benchmark
npm run bench:client                 # Headless Chrome client frame and render-phase benchmark
npm run bench:stages                 # Per-stage simulation tick breakdown
```

## Licensing and Third-Party Notices

Original code and assets are under the [MIT License](LICENSE). Redistributed browser dependencies (Phaser, Rapier 2D, SAT.js, Lucide, fdlibm, and dev-tool modules PathFinding.js, Clipper, Delaunator, Constrainautor) keep their own permissive licenses in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

If you add, upgrade, or stop serving a browser dependency in a fork, update `tools/third-party/components.json`, run `npm run notices`, and verify with `node --test tests/third-party-notices.test.js` ([docs/21.1-third-party-licenses.md](docs/21.1-third-party-licenses.md)).
