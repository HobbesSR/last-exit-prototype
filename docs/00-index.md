# Last Exit documentation index

Status: living documentation
Prototype rules version: `last-exit-0.8-physics`; default content: `content-7`
Updated: 2026-11-13

This directory is the canonical product and engineering record for the prototype.
It is split so a task can load the two or three files it actually needs instead of
one monolithic document.

## Numbering

The first digit is the area, the second identifies a document family. A number is
a stable citation: `13` always identifies 13, and `51.7` identifies one child of
51. Decimal components are identifiers, not fractions or section positions:
`51.10` differs from `51.1`, and `2.6` is not an alias for `26`.

Large families have a short parent reading guide and separately loadable children,
for example `51-generation-chain.md` → `51.7-briefs.md`. Children may have children
(`17.2.4-contract-questions.md`). Files stay together in `docs/`, so sibling links
keep the same base. Cite the most specific number that owns the fact, preferably
as a Markdown link. Stage numbers, question IDs such as M3, and requirement IDs
such as F-01 remain separate from document numbers.

Start here, follow the relevant parent guide, then load only the parts needed for
the task. A link is a route to more context, not an instruction to read every
child or sibling. Read shared invariants when the parent guide calls for them.
Existing parent filenames and citations remain valid entry points; moved headings
have landing links there. See [33](33-maintenance.md) for allocation and migration.

| Range | Area | Load it when |
| --- | --- | --- |
| 0x | Index and conventions | Starting a session, or deciding where a new fact belongs |
| 1x | Product: what the game is and what it must do | Changing gameplay, balance, content or player-facing rules |
| 2x | Engineering: how the implementation is arranged | Changing code structure, protocol, performance or contracts |
| 3x | Process: how work is verified and handed off | Running acceptance, delegating, or updating documentation |
| 4x | Plan and history: what is next and what was measured | Choosing the next task, or citing an earlier measurement |
| 5x | Map generation: macro (`map/macro/`) and how it meets micro (`map/micro/`) | Changing the tile library, placement, zone plans, regions, the chain, or map artifacts |

## Files

### 1x — Product

| File | Holds |
| --- | --- |
| [11-product-intent.md](11-product-intent.md) | Premise, the milestone's success condition, spatial and control intent, presentation target, match loops |
| [11.1-world-and-art-direction.md](11.1-world-and-art-direction.md) | World identity, derelict urban setting, three-layer damage history, palettes, nocturnal theatrical lighting, flat 2D readability, validation criteria (#581) |
| [12-player-requirements.md](12-player-requirements.md) | P-01 – P-16, the non-negotiable player requirements, with roles and kits |
| [13-accepted-features.md](13-accepted-features.md) | F-01 – F-18, accepted direction and per-feature implementation status |
| [14-match-rules.md](14-match-rules.md) | Implemented defaults: capacities, inventory, objective, traps, timings, lifecycle |
| [15-information-rules.md](15-information-rules.md) | What each viewer may know: sight, projections, spectators, privacy |
| [16-deferred.md](16-deferred.md) | Settled decisions, and requirements deliberately postponed to later milestones |
| [17-open-questions.md](17-open-questions.md) | Guide to question records: micro (17.1), map generation (17.2, including portal cord source direction in 17.2.10 and navigation structure direction in 17.2.11), product (17.3), live service (17.4), playtests (17.5), Foundation Pass (17.6); verbatim answers stay in the relevant record |
| [19-decomposition-design.md](19-decomposition-design.md) | Accepted decomposition SDK direction: candidate assignment, generator contracts, residuals and interfaces |

### 2x — Engineering

| File | Holds |
| --- | --- |
| [20-micro-generation.md](20-micro-generation.md) | Guide to micro contracts, geometry, builders, decomposition, tools, passable margins (20.6) builder delegation (20.7: preparation/execution, hut and compound adoption implemented), placeables (20.8) and a builder's usual structure (20.9); portal cord tooling and hut handoff adoption (20.10); load the relevant 20.x part |
| [21-stack.md](21-stack.md) | Chosen components, why, and the constraints a replacement must satisfy |
| [21.1-third-party-licenses.md](21.1-third-party-licenses.md) | Third-party licence audit (#551): what the server redistributes, evidence, obligations, unresolved items, and the update process behind `THIRD-PARTY-NOTICES.txt` |
| [22-ownership.md](22-ownership.md) | Guide to ownership by subsystem and the boundaries tests enforce; load the relevant 22.x part |
| [22.6-hierarchical-navigation.md](22.6-hierarchical-navigation.md) | Guide: direction, constraints, levels and owners, compatibility. Portal graph (#420) over a free-space mesh (#422); knowledge tiles and optimistic planning (#423), adopted by bots under `content-3` (#424); sliced replanning under `content-4` (#470), local repair under `content-5` (#470 part 2); middle level and extra crossings not built (#425 closed) |
| [22.6.1-portal-graph-and-mesh.md](22.6.1-portal-graph-and-mesh.md) | The portal graph (#420) and the free-space mesh eroded per body (#422); the deferred middle level |
| [22.6.2-knowledge-and-doors.md](22.6.2-knowledge-and-doors.md) | Knowledge tiles, optimistic planning and result states (#423); doors as edge states |
| [22.6.3-bot-adoption.md](22.6.3-bot-adoption.md) | Bot adoption under `content-3` (#424), sliced replanning (`content-4`) and local repair (`content-5`, #470) |
| [22.6.4-dynamic-overlay.md](22.6.4-dynamic-overlay.md) | P8's experimental local overlay of observed dynamic bodies (#448) |
| [22.6.5-implementation-sequence.md](22.6.5-implementation-sequence.md) | The #353 stages and #470 parts: built, deferred, closed |
| [22.7-content-and-presentation.md](22.7-content-and-presentation.md) | Content/presentation and shared-rule ownership (#385, implemented in #386): display descriptors, live/replay metadata, client configuration and compatibility defaults |
| [22.8-development-tools.md](22.8-development-tools.md) | Development tools' contract (one core; lab, CLI and MCP faces; state documents, links, in-page handle, pictures), the inventory of tools by domain, and the appearance tools design (#772) |
| [23-types.md](23-types.md) | The TypeScript arrangement in `shared/`, branding policy, erasure |
| [24-networking-privacy.md](24-networking-privacy.md) | Server authority, potential visibility, field contracts, spectator delay |
| [25-pacing-and-rendering.md](25-pacing-and-rendering.md) | Tick pacing against real time, the receive buffer, presentation smoothing, shading |
| [26-recording-contract.md](26-recording-contract.md) | Replay format, integrity, bounded recording, failure and recovery, playback |
| [27-rust-path.md](27-rust-path.md) | The conditions for moving the core to Rust/WASM, the one math library both sides need, and the order of an incremental, fixture-checked port |
| [28-operational-limits.md](28-operational-limits.md) | What this build deliberately does not do, and what public hosting would need |
| [29-geometry-and-drawing.md](29-geometry-and-drawing.md) | Guide: shape descriptions, collision, sight edges, physics prerequisites |
| [29.1-physics-design.md](29.1-physics-design.md) | Rapier contracts: settings and witness gates, ownership, character contact, placement, collision matrix, constraints and the hook, physical items, height boundary |
| [29.2-physics-state-networking.md](29.2-physics-state-networking.md) | Physics tick order, state contracts, private live projections, bounded local prediction, replay compatibility and failure policy |
| [29.3-shape-construction-and-assembly.md](29.3-shape-construction-and-assembly.md) | Shape construction (union, subtraction, convex pieces) and placeable element assemblies |
| [29.4-drawing.md](29.4-drawing.md) | How drawing is cached, drawing planes, roofs and canopies, palettes (#582) and the constraints on art passes |

### 3x — Process

| File | Holds |
| --- | --- |
| [31-verification.md](31-verification.md) | Verification policy: gates and tiers, test cost, test sets, choosing checks by changed area, test arenas, CI, the frozen fixture, content batching; guide to 31.1 (test catalogue by set) and 31.2 (benchmarks and timing tools) |
| [32-delegation.md](32-delegation.md) | Cost-aware delegation, the worker brief, manual model switches |
| [33-maintenance.md](33-maintenance.md) | How to keep these documents true, and where a new fact belongs, including the archive |
| [33.1-foundation-pass.md](33.1-foundation-pass.md) | The Foundation Pass: a periodic project-wide quality and maintainability review under a freeze; its conditions, six concern tracks and how a pass ends |
| [33.2-readme-design.md](33.2-readme-design.md) | The README and audience-guide design: host/client players first, what the README holds, what moves to dedicated guides, secondary audiences |
| [34-forgejo-workflow.md](34-forgejo-workflow.md) | Forgejo as source of truth, agent accounts and worktrees, the issue-to-PR loop |

### 4x — Plan and history

| File | Holds |
| --- | --- |
| [41-roadmap.md](41-roadmap.md) | The order between efforts and the reason for each, with each one's tracker; the retired plans 41.1–41.3 are archived |
| [42-performance-history.md](42-performance-history.md) | Guide to measured baselines and their limits, from completed verification passes; children 42.1–42.45 by topic (runtime, navigation, physics stages, generation and content) |

### 5x — Map generation

19 and 20 are map generation too (the micro half), numbered before this area
existed.

| File | Holds |
| --- | --- |
| [50-map-generation.md](50-map-generation.md) | The two halves and who owns what, the SDK as a shared library, the duplication ledger, a reading guide |
| [51-generation-chain.md](51-generation-chain.md) | Pipeline and guide: invariants (51.1), individual stages (51.2–51.10), core elements (51.11), saving (51.12), reuse (51.13), build history (51.14–51.15) |
| [52-map-primitives-and-library.md](52-map-primitives-and-library.md) | Cells, segments and prescriptions, region types, tiles, set pieces and set piece classes, tier zones, scale |
| [52.1-perimeter-authoring.md](52.1-perimeter-authoring.md) | Authoring tile perimeters for obstruction: how values become portals and clear ground, today's rules against the 2026-11-06 answers, and tips for long closed seams |
| [53-map-artifacts-and-tools.md](53-map-artifacts-and-tools.md) | Compatibility domains, determinism, what is stored, the wire form and BSON, the sweep; guide to the tools (53.1) |
| [53.1-map-lab-and-tools.md](53.1-map-lab-and-tools.md) | The tools that show both halves: the shared core, the Map Lab and its tabs, retained grid and bot-mesh route methods and their limits, the CLI, the MCP server, read-only audits |
| [54-region-types.md](54-region-types.md) | The region type catalogue and guide: what every type shares, portal counts, the catalogue table, old names, material; entries in 54.1–54.4 |
| [54.1-ground-and-friction.md](54.1-ground-and-friction.md) | Entries for `open`, `cover`, `rubble`, `ruins` and `hall` |
| [54.2-structures.md](54.2-structures.md) | Entries for `checkpoint`, `park`, `hut`, `depot`, `plant` and `compound` |
| [54.3-district-and-drafted.md](54.3-district-and-drafted.md) | Entries for `block` and `market` |
| [54.4-core-element-classes.md](54.4-core-element-classes.md) | Entries for `arrival`, `departure`, `charging` and `transit` |
| [55-zone-plans.md](55-zone-plans.md) | Zone plans, starting with the diamond: the zone grid, mask, tiers, zone sizes, where placement rules anchor, and who authors what |
| [56-buildings.md](56-buildings.md) | The building library, its first milestone implemented: building designs, their realization in cells, walls from runs, and the build order |
| [56.1-roofs.md](56.1-roofs.md) | Declared roofs: cell-grid geometry, relationship to Building, invariant sight rules, versioning (#292) |
| [56.2-ground-decals.md](56.2-ground-decals.md) | Ground decals at outside doors and windows: the primitive, derivation, themes, drawing (#293) |

## Other places facts live

`AGENTS.md` at the repository root carries session start rules and project
invariants. `README.md` is the player- and operator-facing entry point: running,
controls, replays, profiling. `tests/fixtures/README.md` documents the frozen
characterization baseline. Work in progress and handoffs live on the Forgejo issue
and pull request ([34](34-forgejo-workflow.md)); they are recent state, not
requirements.

`map/macro/` is the map generator, imported with its history from the former
`last_exit_map` repository. Its design documentation was folded into 17 and 50–53
on 2026-09-29. Its former docs are archived in
`map/macro/docs/archive/pre-integration/`, where they describe the old paths
that were retired when the chain landed (51.14.5, #146). `map/macro/design_notes.txt` is the original
statement of the map's intent. `map/macro/README.md` covers running it, and
`map/macro/AGENTS.md` its commands.
