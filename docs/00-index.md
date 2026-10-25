# Last Exit documentation index

Status: living documentation
Prototype rules version: `last-exit-0.7`; default content: `content-5`
Updated: 2026-10-25

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
| [11-product-intent.md](11-product-intent.md) | Premise, the milestone's success condition, spatial and control intent, match loops |
| [12-player-requirements.md](12-player-requirements.md) | P-01 – P-16, the non-negotiable player requirements, with roles and kits |
| [13-accepted-features.md](13-accepted-features.md) | F-01 – F-18, accepted direction and per-feature implementation status |
| [14-match-rules.md](14-match-rules.md) | Implemented defaults: capacities, inventory, objective, traps, timings, lifecycle |
| [15-information-rules.md](15-information-rules.md) | What each viewer may know: sight, projections, spectators, privacy |
| [16-deferred.md](16-deferred.md) | Settled decisions, and requirements deliberately postponed to later milestones |
| [17-open-questions.md](17-open-questions.md) | Guide to question records: micro (17.1), map generation (17.2, including delegation decisions in 17.2.9), product (17.3), live service (17.4), playtests (17.5); verbatim answers stay in the relevant record |
| [18-original-prompt.md](18-original-prompt.md) | The preserved original design stream and influences. A source record, not requirements |
| [19-decomposition-design.md](19-decomposition-design.md) | Accepted decomposition SDK direction: candidate assignment, generator contracts, residuals and interfaces |

### 2x — Engineering

| File | Holds |
| --- | --- |
| [20-micro-generation.md](20-micro-generation.md) | Guide to micro contracts, geometry, builders, decomposition, tools, passable margins (20.6) builder delegation (20.7: preparation/execution, hut and compound adoption implemented), placeables (20.8) and a builder's usual structure (20.9); load the relevant 20.x part |
| [21-stack.md](21-stack.md) | Chosen components, why, and the constraints a replacement must satisfy |
| [22-ownership.md](22-ownership.md) | Guide to ownership by subsystem and the boundaries tests enforce; load the relevant 22.x part |
| [22.6-hierarchical-navigation.md](22.6-hierarchical-navigation.md) | Portal graph (#420) over a free-space mesh (#422); knowledge tiles and optimistic planning (#423), adopted by bots under `content-3` (#424); sliced replanning under `content-4` (#470), local repair under `content-5` (#470 part 2); middle level and extra crossings not built (#425 closed) |
| [22.7-content-and-presentation.md](22.7-content-and-presentation.md) | Content/presentation and shared-rule ownership (#385, implemented in #386): display descriptors, live/replay metadata, client configuration and compatibility defaults |
| [23-types.md](23-types.md) | The TypeScript arrangement in `shared/`, branding policy, erasure |
| [24-networking-privacy.md](24-networking-privacy.md) | Server authority, potential visibility, field contracts, spectator delay |
| [25-pacing-and-rendering.md](25-pacing-and-rendering.md) | Tick pacing against real time, the receive buffer, presentation smoothing, shading |
| [26-recording-contract.md](26-recording-contract.md) | Replay format, integrity, bounded recording, failure and recovery, playback |
| [27-rust-path.md](27-rust-path.md) | The conditions for moving the core to Rust/WASM, and what stays outside it |
| [28-operational-limits.md](28-operational-limits.md) | What this build deliberately does not do, and what public hosting would need |
| [29-geometry-and-drawing.md](29-geometry-and-drawing.md) | Shape descriptions, collision, sight edges, shape construction (union, subtraction, convex pieces), how drawing is cached, physics prerequisites |
| [29.1-physics-design.md](29.1-physics-design.md) | Proposed rigid bodies, character contact, middleware evaluation, springs/hooks and physical item contracts |
| [29.2-physics-state-networking.md](29.2-physics-state-networking.md) | Experimental physics tick/state contracts, private live projections, engine-free playback and bounded local prediction (#441); default rollout remains proposed |

### 3x — Process

| File | Holds |
| --- | --- |
| [31-verification.md](31-verification.md) | Verification gates, what each suite covers, the frozen fixture rule |
| [32-delegation.md](32-delegation.md) | Cost-aware delegation, the worker brief, manual model switches |
| [33-maintenance.md](33-maintenance.md) | How to keep these documents true, and where a new fact belongs |
| [34-forgejo-workflow.md](34-forgejo-workflow.md) | Forgejo as source of truth, agent accounts and worktrees, the issue-to-PR loop |

### 4x — Plan and history

| File | Holds |
| --- | --- |
| [41-roadmap.md](41-roadmap.md) | Completed boundaries, the next implementation boundaries, and sequencing |
| [41.1-physics-plan.md](41.1-physics-plan.md) | Physics/equipment issue sequence, comparison workloads, provisional tuning and rollout gates |
| [42-performance-history.md](42-performance-history.md) | Measured baselines and their limits, from completed verification passes |
| [42.1-navigation-experiment.md](42.1-navigation-experiment.md) | Safe local graph experiment (#364), passage failures and measured hierarchy costs |
| [42.2-runtime-performance.md](42.2-runtime-performance.md) | Runtime, privacy, crowd, rendering and live-match measurements, with historical checkpoint routes |
| [42.3-generation-and-delegation-evidence.md](42.3-generation-and-delegation-evidence.md) | Generation, delegation, catalogue samples and verification-cost evidence, with retained raw reports |
| [42.4-chain-checkpoint-history.md](42.4-chain-checkpoint-history.md) | Dated chain captures and their input provenance; active compatibility remains in 53 |
| [42.5-portal-graph.md](42.5-portal-graph.md) | Portal graph stage 1 (#420): swept promise confirmation, table and query costs, route stretch |
| [42.6-physics-comparison.md](42.6-physics-comparison.md) | Physics P0 (#437): common witnesses, solver comparison, failed gates and integration limits |
| [42.7-navigation-mesh.md](42.7-navigation-mesh.md) | Free-space mesh as navigation's bottom level (#422): promise confirmation against the grid, build time and memory, table and route costs |
| [42.8-bot-adoption.md](42.8-bot-adoption.md) | Bots planning over free-space tiles under `content-3` (#424): whole-match stalls, escapes and tick cost against `content-2`, route quality, tiles built ahead in the map worker |
| [42.9-physics-remediation.md](42.9-physics-remediation.md) | Rapier remediation (#451): revised gates, native springs, bounded speed and capacity proposal; P1 review prerequisites |
| [42.10-sliced-replanning.md](42.10-sliced-replanning.md) | Repaths spread over ticks under `content-4` (#470 part 1): budget exhaustion gone, tick cost against `content-3`, why bots share one allowance a tick |
| [42.12-physics-p2.md](42.12-physics-p2.md) | Experimental P2 (#439): narrower actor profiles, motor surfaces, contact and lifecycle witnesses |
| [42.11-physics-p1.md](42.11-physics-p1.md) | Experimental P1 (#438): room-owned worlds, paired phase traces, gameplay state and integration validation |
| [42.13-local-repair.md](42.13-local-repair.md) | Local route repair under `content-5` (#470 part 2): reaction to nearby changes, repairs and their cost against `content-4`; whether #425 is needed for latency |
| [42.14-physics-p3.md](42.14-physics-p3.md) | Physics privacy, engine-free body/tether playback and body-heavy serialization evidence (#440) |
| [42.15-physics-p4.md](42.15-physics-p4.md) | Bounded local prediction, scheduled network witnesses and correction/cost evidence (#441) |
| [42.16-physics-p5.md](42.16-physics-p5.md) | Opt-in physical loot/crates, floor drag and covered blast impulses; body-heavy serialization and current baseline evidence (#445) |
| [42.17-physics-p6.md](42.17-physics-p6.md) | Experimental capped springs/ropes and hook: swept attachment, cancellation, privacy, replay and browser evidence (#446) |
| [42.18-physics-p7.md](42.18-physics-p7.md) | Lab-only thrown cube: analytic height sweep, event ties, explicit roof/window intervals, mask containment and engine-free retained playback (#447) |
| [42.19-physics-p8.md](42.19-physics-p8.md) | Experimental local body detours, drop occupancy, privacy and crowd evidence (#448) |
| [42.20-physics-p9.md](42.20-physics-p9.md) | Staged integration gates, local playtest tooling, measured envelopes and promotion limits (#449) |
| [42.21-jelly-squish.md](42.21-jelly-squish.md) | Lab-only native-spring jelly, fixed-core compression signals and engine-free playback (#455); gameplay decisions remain open |

### 5x — Map generation

19 and 20 are map generation too (the micro half), numbered before this area
existed.

| File | Holds |
| --- | --- |
| [50-map-generation.md](50-map-generation.md) | The two halves and who owns what, the SDK as a shared library, the duplication ledger, a reading guide |
| [51-generation-chain.md](51-generation-chain.md) | Pipeline and guide: invariants (51.1), individual stages (51.2–51.10), core elements (51.11), saving (51.12), reuse (51.13), build history (51.14–51.15) |
| [52-map-primitives-and-library.md](52-map-primitives-and-library.md) | Cells, segments and prescriptions, region types, tiles, set pieces and set piece classes, tier zones, scale |
| [53-map-artifacts-and-tools.md](53-map-artifacts-and-tools.md) | Compatibility domains, determinism, what is stored, the wire form and BSON, the sweep; guide to the tools (53.1) |
| [53.1-map-lab-and-tools.md](53.1-map-lab-and-tools.md) | The tools that show both halves: the shared core, the Map Lab and its tabs, the CLI, the MCP server, read-only audits |
| [54-region-types.md](54-region-types.md) | The region type catalogue and guide: what every type shares, portal counts, the catalogue table, old names, material; entries in 54.1–54.4 |
| [54.1-ground-and-friction.md](54.1-ground-and-friction.md) | Entries for `open`, `cover`, `rubble`, `ruins` and `hall` |
| [54.2-structures.md](54.2-structures.md) | Entries for `checkpoint`, `park`, `hut`, `depot`, `plant` and `compound` |
| [54.3-district-and-drafted.md](54.3-district-and-drafted.md) | Entries for `block` and the drafted `market` |
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
