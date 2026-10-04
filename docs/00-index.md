# Last Exit documentation index

Status: living documentation
Prototype rules version: `last-exit-0.7`; default content: `content-2`
Updated: 2026-10-03

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
| [17-open-questions.md](17-open-questions.md) | Guide to question records: micro (17.1), map generation (17.2), product (17.3), live service (17.4), playtests (17.5); verbatim answers stay in the relevant record |
| [18-original-prompt.md](18-original-prompt.md) | The preserved original design stream and influences. A source record, not requirements |
| [19-decomposition-design.md](19-decomposition-design.md) | Accepted decomposition SDK direction: candidate assignment, generator contracts, residuals and interfaces |

### 2x — Engineering

| File | Holds |
| --- | --- |
| [20-micro-generation.md](20-micro-generation.md) | Guide to micro contracts, geometry, builders, decomposition and tools; load the relevant 20.x part |
| [21-stack.md](21-stack.md) | Chosen components, why, and the constraints a replacement must satisfy |
| [22-ownership.md](22-ownership.md) | Guide to ownership by subsystem and the boundaries tests enforce; load the relevant 22.x part |
| [23-types.md](23-types.md) | The TypeScript arrangement in `shared/`, branding policy, erasure |
| [24-networking-privacy.md](24-networking-privacy.md) | Server authority, potential visibility, field contracts, spectator delay |
| [25-pacing-and-rendering.md](25-pacing-and-rendering.md) | Tick pacing against real time, the receive buffer, presentation smoothing, shading |
| [26-recording-contract.md](26-recording-contract.md) | Replay format, integrity, bounded recording, failure and recovery, playback |
| [27-rust-path.md](27-rust-path.md) | The conditions for moving the core to Rust/WASM, and what stays outside it |
| [28-operational-limits.md](28-operational-limits.md) | What this build deliberately does not do, and what public hosting would need |
| [29-geometry-and-drawing.md](29-geometry-and-drawing.md) | Shape descriptions, collision, sight edges, how drawing is cached, physics prerequisites |

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
| [42-performance-history.md](42-performance-history.md) | Measured baselines and their limits, from completed verification passes |

### 5x — Map generation

19 and 20 are map generation too (the micro half), numbered before this area
existed.

| File | Holds |
| --- | --- |
| [50-map-generation.md](50-map-generation.md) | The two halves and who owns what, the SDK as a shared library, the duplication ledger, a reading guide |
| [51-generation-chain.md](51-generation-chain.md) | Pipeline and guide: invariants (51.1), individual stages (51.2–51.10), core elements (51.11), saving (51.12), reuse (51.13), build history (51.14–51.15) |
| [52-map-primitives-and-library.md](52-map-primitives-and-library.md) | Cells, segments and prescriptions, region types, tiles, set pieces and set piece classes, tier zones, scale |
| [53-map-artifacts-and-tools.md](53-map-artifacts-and-tools.md) | Determinism, what is stored, the wire form and BSON, the sweep, the Map Lab, CLI and MCP |
| [54-region-types.md](54-region-types.md) | The region type catalogue, a working draft: each type's role, strategy, core elements, shape needs and material |
| [55-zone-plans.md](55-zone-plans.md) | Zone plans, starting with the diamond: the zone grid, mask, tiers, zone sizes, where placement rules anchor, and who authors what |

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
`map/macro/docs/archive/pre-integration/`, where they still describe the old paths
that retire when the chain lands (51). `map/macro/design_notes.txt` is the original
statement of the map's intent. `map/macro/README.md` covers running it, and
`map/macro/AGENTS.md` its commands.
