# Last Exit Design and Requirements

Status: living document  
Updated: 2026-09-09  
Prototype version: `last-exit-0.3`

This is the canonical product and engineering requirements document for the prototype. `DESIGN.md` is the shorter design working draft; `ARCHITECTURE.md` records implementation ownership and technical tradeoffs. When implementation and this document disagree, update the document and the relevant tests in the same change.

## 1. Product Intent

Last Exit is an asymmetric top-down escape game. Many contestants move through a large, elongated diamond arena while a small number of gladiators hunt them. A left-to-right hazard forces the whole match forward. Contestants are trying to reach a small number of extraction places; gladiators are trying to claim kills and improve their kits.

The first milestone is a playable proof of the pursuit-and-escape loop. It is successful when a player can understand the space, make route and information decisions, outplay or be outplayed by another role, and explain the outcome afterward through a perfect replay.

## 2. Non-Negotiable Player Requirements

| ID | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| P-01 | The arena is elongated left-to-right, diamond-shaped, and larger than one camera view. | World is 6,720 x 2,880; live camera width is less than one third of the world width; generated boundary is diamond-shaped. | Implemented |
| P-02 | “Tile-based” means procedurally generated modular sections, never grid movement or visible square-grid corridors. | `shared/map.js` generates yards, depots, gardens, cover, structures, and checkpoints in continuous world coordinates; player positions are fractional world coordinates. | Implemented |
| P-03 | The hazard advances from contestant entry toward extraction and pressures both roles. | `hazardX` advances against real time; actors behind it take damage; the match has a fixed duration. | Implemented |
| P-04 | Contestants are smaller/faster and can use passages that block gladiators. | Continuous circle collision uses contestant radius 12 and gladiator radius 23; generated gaps and tests verify clearance. | Implemented |
| P-05 | Contestants collect environmental items that affect the current match. | Access charges, weapons, shields, and healing are generated in sections and collected authoritatively. | Implemented |
| P-06 | Contestants need access charges for barriers, with exposed/hazardous alternatives. | Closed checkpoint gates consume charges; bypasses and hazard strips remain available. | Implemented |
| P-07 | There are few escape places. | The match begins with three extraction slots; each successful extraction consumes one. | Implemented |
| P-08 | Gladiators have distinct kits and improve after kills. | Warden, Specter, and Striker have separate abilities; kills raise level, health, damage, and recovery. | Implemented |
| P-09 | Gladiators have movement options contestants do not. | Transit stations relocate gladiators with cooldown; contestants cannot use them. | Implemented |
| P-10 | Stealth and detection are legible. | Sensors reveal running contestants; sneak avoids sensors; smoke and scan interact with reveal state. | Implemented |
| P-11 | Obstacles block vision and projectile travel. | SAT geometry supplies line-of-sight tests; renderer uses a visibility polygon and shaded cover. | Implemented |
| P-12 | Desktop controls separate movement and aim. | WASD/arrow movement and pointer aim; left mouse fires. | Implemented |
| P-13 | Touch controls support simultaneous movement and aim/fire. | Independent virtual sticks are tested with two concurrent touch contacts. | Implemented |
| P-14 | A player cannot see the whole live battlefield. | Camera follows the player; full-map view is reserved for completed replays. | Implemented |
| P-15 | A player can replay exactly what the authoritative server recorded. | Every simulation tick is stored in a compressed replay with commands, map, metadata, and SHA-256. | Implemented |
| P-16 | Server authority prevents client-side state injection. | Inputs are bounded, sequenced, rate-limited, and validated; clients cannot set position, health, inventory, or outcomes. | Implemented |

## 3. Match Rules

The default match contains eight contestant slots, two gladiator slots, three extraction slots, a seeded generated map, and bot occupants for unclaimed player slots. A connection is a viewer until it explicitly claims a contestant or gladiator slot. Spectators consume no slot, start no recording, and have no input authority.

The server advances the simulation at 20 Hz based on elapsed real time rather than trusting the operating-system timer interval. It can catch up a bounded number of ticks after a wake-up. Every simulated tick is recorded; only the latest state in a catch-up batch is broadcast.

The match finishes when all extraction slots are used, no active contestants remain, or the time limit expires. Active contestants left at time expiry become stranded. The exact numbers are tuning defaults and must stay named in code and docs when changed.

## 4. Information Rules

The server sends each player the state that could become relevant within the configured visibility radius, plus revealed information. The client applies actual line of sight using the same shared obstacle geometry. Static terrain remains drawn and falls into shadow; actors, pickups, projectiles, and transient effects are withheld when they are not visible. A directed spectator/presenter view is intentionally unfogged and must not be available to a player holding a slot.

Player projections must not include private inventory, ability timers, bot status, path state, input bookkeeping, RNG state, or replay internals. A live projection may be narrower than the recorded frame but must never change values it does include. Tests must compare live projections against the recording field by field.

## 5. Technical Requirements

The authoritative simulation and browser prediction share movement and geometry code. Simulation state is fixed-tick and serializable. Rendering is independent of simulation rate: the client smooths the camera, local player, fog, and projectiles using one eased eye and elapsed fractions between authoritative states.

Phaser, SAT.js, and PathFinding.js are the current free/open-source components. They are replaceable only when a replacement improves correctness, determinism, licensing, performance, or browser support. The simulation must remain separable from the renderer so a Rust/WASM core can replace the shared JavaScript implementation if the game validates.

Profiling is off by default. `shared/profiler.js` keeps frame-scoped timing/counters separate from event-scoped packet and pacing observations. The server exposes `/api/profile`, `PROFILE=1` enables server profiling, `P` toggles browser profiling, and the benchmark scripts must remain runnable without opening a public server.

## 6. Verification Gates

Every gameplay or protocol change should pass the relevant gates:

```powershell
npm run check
npm test
npm run test:browser
npm run bench
npm run bench:client
```

The tests currently cover deterministic seeded simulation, 200 generated maps, continuous movement and physical gaps, gates and extraction, combat and kit progression, transit, stealth, visibility geometry, privacy projections, one-shot input latching, pacing/replay integrity, spectators, desktop controls, touch controls, mouse aim, client-side sight, shaded occlusion, and projectile interpolation.

## 7. Requirements Deliberately Deferred

These are requirements for later milestones, not silently missing pieces of the current proof of concept:

1. Presenter/caster controls for switching camera focus and identifying action.
2. Validated spectator patron commands that drop items for contestants; these must be a separate command type and replay event, never player input authority.
3. Enemy fade-out and last-seen indicators when an actor leaves sight.
4. Physics substeps inside the 20 Hz tick for projectiles, knockback, and richer hazards.
5. Wedge-culling for server `lineClear` queries if profiling shows it matters; client visibility already uses the optimized sweep.
6. Persistent gladiator unlocks, contestant perks, card/sticker packs, pre-game cards, cosmetics, and a fair monetization model.
7. Destructible cover, command-center interactions, additional static and hunter-triggered hazards, richer camera/sensor stations, audio, matchmaking, authentication, public deployment, and retention policies.

## 8. Open Product Decisions

- Are contestants strictly non-hostile rivals, or can they fight one another?
- Are extraction slots first-come-first-served, or do contestants need an extraction objective?
- Does a patron spend a limited audience resource, and can patrons affect gladiators as well as contestants?
- Should the presenter view be delayed by a fixed number of ticks or only reveal a delayed replay stream?
- Which progression elements are cosmetic, and which can affect the match without becoming pay-to-win?

## 9. Core Original Prompt Notes

This section preserves the original design stream that started the project. It is intentionally rough; it is a source record, not a list of accepted requirements.

### Initial section ideas

- Introduction: purpose of the document is to outline the core game elements and the most primitive design that can be implemented and played.
- Game premise/concept; battle-royale root; inspirations from The Running Man, Super Smash TV, a Sliders episode, Zombs Royale, Maze Runner, Battle Royale, The Hunger Games, Evolve, Dead by Daylight, Fortnite/PUBG, The Cycle, Plants vs. Zombies: Garden Warfare, and Titanfall 2.
- Character abilities with cooldowns; card packs/stickers; pre-game cards.
- Game elements: many contestant players, few hunter/gladiator players, map, contestant spawn zones, hunter spawn zones at one narrow end, a diamond-shaped maze, middle challenge area, procedurally generated simple maze, contestant pickups, keys, weapons, temporary and match-long power-ups, macro-loop collectibles and consumables, locked shortcuts, weapons and utility items, locked pickups.
- Environmental hazards and static traps; hunter-triggerable hazards and traps; trigger controls; command-center zones; a progressing hazard zone; contestant extraction zones; hunter fast travel locations; blockades; projectiles; player-spawnable temporary impediments; player-created temporary area damage or crowd-control zones; cameras and motion sensors; Mark of the Ninja; hunter HUD; cooldowns; map; contestant inventory; mechanics; design goals; player experience; monetization; micro/macro loop; replayability.

### Clarifications added afterward

- The diamond is elongated left-to-right.
- A hazard pushes across from left to right and compels contestants and gladiators forward.
- Gladiators have kits and abilities that upgrade as they claim kills.
- Contestants scale through items found in the environment.
- Barriers require keys mechanically, while exposed areas and environmental hazards provide alternatives.
- Only a few escape slots exist.
- Gladiators are larger and slower or equal-speed; contestants escape through gaps they cannot fit through.
- Gladiators have exclusive travel such as rails and transport stations.
- There are multiple gladiator kits.
- Cameras and sensors can alert gladiators or be inspected at viewing stations.
- The long-term loop is unlocking gladiators and earning contestant perks.
- The visual and interaction target is a Nintendo/Fortnite-style playground.
- The proof of concept is top-down and Zombs Royale-like in handling, with free movement rather than grid movement.
- The map is procedurally generated from reusable sections, not a visible square grid.
- The server should be authoritative and save perfect replays.
- Rust was considered for the core server and shared prediction; the current prototype uses a shared JavaScript core with a documented Rust/WASM path.

## 10. Maintenance Rules

When a requirement changes, update this file first, then update `DESIGN.md` or `ARCHITECTURE.md` only when the explanation belongs there. Add or update an acceptance test for every implemented requirement. Keep deferred work here until it is either implemented and tested or explicitly removed by a design decision. Record meaningful engine/library substitutions in `ARCHITECTURE.md` with license and rationale.
