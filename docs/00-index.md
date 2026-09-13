# Last Exit documentation index

Status: living documentation
Prototype version: `last-exit-0.6`
Updated: 2026-09-13

This directory is the canonical product and engineering record for the prototype.
It is split so a task can load the two or three files it actually needs instead of
one monolithic document.

## Numbering

The first digit is the area, the second is the file within it. A number is a stable
citation: "13" and "2.6" mean the same file for the life of the project, so briefs
and handoffs should cite the number, not a heading.

| Range | Area | Load it when |
| --- | --- | --- |
| 0x | Index and conventions | Starting a session, or deciding where a new fact belongs |
| 1x | Product: what the game is and what it must do | Changing gameplay, balance, content or player-facing rules |
| 2x | Engineering: how the implementation is arranged | Changing code structure, protocol, performance or contracts |
| 3x | Process: how work is verified and handed off | Running acceptance, delegating, or updating documentation |
| 4x | Plan and history: what is next and what was measured | Choosing the next task, or citing an earlier measurement |

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
| [17-open-questions.md](17-open-questions.md) | Undecided product and live-service policy, with the user's verbatim answers |
| [18-original-prompt.md](18-original-prompt.md) | The preserved original design stream and influences. A source record, not requirements |

### 2x — Engineering

| File | Holds |
| --- | --- |
| [21-stack.md](21-stack.md) | Chosen components, why, and the constraints a replacement must satisfy |
| [22-ownership.md](22-ownership.md) | Which module owns which decision, and the boundaries tests enforce |
| [23-types.md](23-types.md) | The TypeScript arrangement in `shared/`, branding policy, erasure |
| [24-networking-privacy.md](24-networking-privacy.md) | Server authority, potential visibility, field contracts, spectator delay |
| [25-pacing-and-rendering.md](25-pacing-and-rendering.md) | Tick pacing against real time, input latching, presentation smoothing, shading |
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

### 4x — Plan and history

| File | Holds |
| --- | --- |
| [41-roadmap.md](41-roadmap.md) | Completed boundaries, the next implementation boundaries, and sequencing |
| [42-performance-history.md](42-performance-history.md) | Measured baselines and their limits, from completed verification passes |

## Other places facts live

`AGENTS.md` at the repository root carries session start rules and project
invariants. `README.md` is the player- and operator-facing entry point: running,
controls, replays, profiling. `tests/fixtures/README.md` documents the frozen
characterization baseline. `FRESH_SESSION.md`, when present, is an untracked
checkpoint handoff; it is the most recent state, not a requirement.
