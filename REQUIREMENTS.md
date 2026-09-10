# Last Exit Design and Requirements

Status: living document  
Updated: 2026-09-10
Prototype version: `last-exit-0.6`

This is the canonical product and engineering requirements document for the prototype. `DESIGN.md` is the shorter design working draft; `ARCHITECTURE.md` records implementation ownership and technical tradeoffs. When implementation and this document disagree, update the document and the relevant tests in the same change.

## 1. Product Intent

Last Exit is an asymmetric top-down escape game. Many contestants move through a large, elongated diamond arena while a small number of gladiators hunt them. A left-to-right hazard forces the whole match forward. Contestants are trying to reach a small number of extraction places; gladiators are trying to claim kills and improve their kits.

The first milestone is a playable proof of the pursuit-and-escape loop. It is successful when a player can understand the space, make route and information decisions, outplay or be outplayed by another role, and explain the outcome afterward through a perfect replay.

## 2. Non-Negotiable Player Requirements

P-01 through P-16 describe the core implementation. Section 2.1 tracks the improvements accepted on 2026-09-09 and their current acceptance status.

| ID | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| P-01 | The arena is elongated left-to-right, diamond-shaped, and larger than one camera view. | World is 24,000 x 12,000; live camera width is less than one third of the world width; generated boundary is diamond-shaped. | Implemented |
| P-02 | Tile templates will eventually compose the map; movement remains continuous. | Interim street graph uses coarse 1,000-unit blocks with offset passages and continuous geometry. This is not the requested modular hierarchy. | Partial; hierarchy deferred |
| P-03 | The hazard advances from contestant entry toward extraction and pressures both roles. | `hazardX` advances against real time; actors behind it take damage; the match has a fixed duration. | Implemented |
| P-04 | Contestants are smaller/faster and can use passages that block gladiators. | Continuous circle collision uses contestant radius 12 and gladiator radius 23; generated gaps and tests verify clearance. | Implemented |
| P-05 | Contestants collect environmental items that affect the current match. | Access charges, weapons, shields, and healing are generated in sections and collected authoritatively. | Implemented |
| P-06 | Access charges open optional barriers without making keys mandatory for escape. | Some building doors require one key; unlocking is permanent. Street routes require no keys. | Implemented interim |
| P-07 | There are few escape places. | The match begins with three extraction slots; each successful extraction consumes one. | Implemented |
| P-08 | Gladiators have distinct kits and improve after kills. | Warden, Specter, and Striker have separate abilities; kills raise level, health, damage, and recovery. | Implemented |
| P-09 | Gladiators have movement options contestants do not. | Transit stations relocate gladiators with cooldown; contestants cannot use them. | Implemented |
| P-10 | Stealth and detection are legible. | Sensors reveal running contestants; sneak avoids sensors; gladiator scan reveals contestants. Contestants have no innate smoke sprint. | Implemented |
| P-11 | Solid obstacles block vision and projectile travel. | Solid walls and closed doors occlude; windows pass sight and shots but block bodies and item interactions. | Implemented |
| P-12 | Desktop controls separate movement and aim. | WASD/arrow movement and pointer aim; left mouse fires. | Implemented |
| P-13 | Touch controls support simultaneous movement and aim/fire. | Independent virtual sticks are tested with two concurrent touch contacts. | Implemented |
| P-14 | A player cannot see the whole live battlefield. | Camera follows the player; full-map view is reserved for completed replays. | Implemented |
| P-15 | A player can replay exactly what the authoritative server recorded. | Every simulation tick is stored in a compressed replay with commands, map, metadata, and SHA-256. | Implemented |
| P-16 | Server authority prevents client-side state injection. | Inputs are bounded, sequenced, rate-limited, and validated; clients cannot set position, health, inventory, or outcomes. | Implemented |

### 2.1 Accepted Improvements — updated 2026-09-10

The target is a substantially larger cyberpunk urban dystopian ruin with indoor and outdoor play, hierarchical generation, equipment-driven contestants, and a power-cell extraction objective. The statuses below distinguish working prototype mechanics from remaining visual and design work. Unit/server tests and browser checks cover the implemented mechanics; human multiplayer balance is still unverified.

| ID | Requirement | Acceptance evidence / limits | Status |
| --- | --- | --- | --- |
| F-01 | Generate maps hierarchically by selecting compatible tile templates controlling paths. | User explicitly deferred the modular hierarchy pending a detailed specification. Current connected street maze is an interim playability improvement, not completion of this requirement. | Deferred specification |
| F-02 | Reach extraction through upper, middle, and lower areas; include dead ends and optional keyed areas. | Connected maze with loops, offset passages, optional locked buildings and size-limited shortcuts. 200 seeds verify sampled top/main/bottom route clearance and no-key navigation for both sizes. Access-point semantics remain open. | Interim prototype |
| F-03 | Find a power cell, charge it at a station, and deliver it to a pod. | Cells each occupy one ordinary slot, retain charge on drops, take five seconds to charge, and are consumed on extraction. Inventory, interruption, death/drop, charging and extraction tests pass. | Implemented |
| F-04 | Cyberpunk ruins with interiors/exteriors and a 2½D playing field. | Buildings have open/close doors, windows, and roofs that hide interiors outside and disappear inside. Flat top-down presentation remains; playable elevation and finished art are not implemented. | Partial |
| F-05 | Add motion-sensitive mines, turrets, flamethrowers, and NPC spider bots that attack anything within web range, pursue only a limited distance, and can grapple. | Tests cover mine movement triggers, turret targeting, flame warning/cone/cover, and spider grappling and leash limits against both player roles. | Implemented prototype |
| F-06 | Six weapon/item slots, finite ammunition, icons, rearrangement and compatible stack merging. No innate contestant abilities. | Six slots; pistol/rifle/scattergun with finite rounds; med/shield stacks; unstackable cells; numeric ammo/charge badges; R/touch move/merge; G/touch drop. Server validation and browser tests cover sixth-slot use and rearrangement. | Implemented prototype |
| F-07 | Support private rooms and server matchmaking with gladiator, contestant, or no role preference. | Private owner-started rooms and separate server matchmaking. Tests cover all preferences, fallback, automatic start, and refresh recovery. No internet deployment or account service. | Implemented on one server |
| F-08 | Allow exploration within an approximately ten-minute wall deadline. | Revised 24,000 x 12,000 maze; 600-second limit, 60-second wall grace, five-second charging. Main-route travel targets roughly four to five minutes; generation penalizes late westward backtracking and tests include exploration pauses. Human balance still needs playtesting. | Revised initial tuning |
| F-09 | Remove the circular visibility boundary and use the full play-area viewport. Static map elements remain visible; obstacles still conceal dynamic entities. | Viewport coverage tests include portrait, desktop and ultrawide sizes; browser test renders an actor beyond the former 620-unit cutoff while preserving wall occlusion. Camera coverage is bounded on huge displays. | Implemented |
| F-10 | Preserve the last-known state of changeable map elements such as doors when out of sight. Extend this principle to future dynamic terrain. | Gate memory tests cover unseen changes and observation refresh. Unseen gates are muted; unknown gates are shown closed with an uncertainty marker. Dynamic terrain remains future work. | Implemented for gates |

### 2.2 Implemented Defaults and Constraints

The power-cell objective supplements limited escape capacity; three extraction slots remain a baseline tuning default. Contestant equipment changes do not remove gladiator kits or kill-based progression. The ten-minute deadline leaves time for exploration and combat, not ten minutes of uninterrupted running. Existing early match-end conditions remain.

Camera coverage is capped at 2,400 x 1,600 world units, and the server's potential-visibility radius includes its diagonal plus a 250-unit margin. The sight polygon covers the viewport rather than imposing a circular cutoff. Obstacles conceal dynamic actors, including allies, except explicit gladiator sensor/scan reveals. Static geometry stays visible with shade. Gate memory is local historical presentation; authoritative collision uses actual gate state. This is not a production anti-cheat system: potential state and actual gates remain available to a modified client within the existing trust model.

Each cell occupies one of the six ordinary equipment slots and never stacks; carrying several costs several slots. Keys remain separate. A cell takes 100 ticks (five seconds) to charge; press E in range and stay still. Movement or leaving the station pauses charging but retains progress. Stations can charge multiple contestants. Elimination drops the cell with its charge; extraction consumes it. Traps are placed at least 850 units from chargers so required stationary charging is not automatically covered by a trap.

Equipment has six mixed slots. 1–6 or slot buttons select equipment; fire/use activates it. Items use icons with numeric ammo, stack or charge badges, tooltips and accessible names. R or Move/merge selects the current item for rearrangement; choose a destination with a number key or slot button. Matching medkit/shield stacks combine up to three; other items swap. Medkits restore 40 HP and shields restore 30 (75 maximum). Each cell takes one slot and never stacks.

E swaps nearby loot into the selected slot when full. G or Drop selected drops the whole selected slot; a one-second owner pickup delay avoids immediate recollection. Drops retain cell charge and remaining weapon ammunition. Pistol/rifle/scattergun pickups start with 48/90/24 rounds, capped at 192/360/96 per weapon. One shot costs one round, including a scattergun's five-pellet shot. Matching weapon pickups replenish ammo even with full inventory; untransferred rounds remain on the ground. There is no reload mechanic or separate reserve-ammo slot yet. Existing damage/cooldowns remain pistol 10/8 ticks, rifle 6/4, scattergun five 7-damage pellets/18. No contestant ability slot is implemented.

Matchmaking only considers unstarted matchmade rooms on this server. It honors an available preferred role; otherwise it fills the role with the lower occupied fraction, with contestant as the tie-breaker. A 15-second countdown begins with the first join, then bots fill vacancies. Private rooms are excluded and remain owner-started. Session-stored rotating resume credentials reclaim the same actor; owner credentials restore lobby/finish authority and never enter shared invite links.

Mine radius is 65 with a 120-unit blast and 45 damage; actual movement above 0.5 units triggers it once. Turrets target either role within 650 units and fire 12-damage shots on a 35-tick cooldown. Flame cycles last 160 ticks, warn for 40, then fire for 40; cone reach is 240 with wall checks. Spider webs acquire within 240, release targets beyond 360 from home, and grapple within 150 for 10 damage plus 30 ticks of movement slowdown on a 50-tick cooldown. All are prototype balance values.

Contestants can damage each other with projectiles. Bots retaliate immediately; roughly one third have an opportunistic temperament and may initiate fights after 30 seconds within 180 units, expanding to 320 units after two minutes. They avoid shooting directly through a third contestant and seek collision-clear space away from hunters within 170 units while returning fire. Starts are distributed across four nearby connected blocks, with at least 400 units between players and a pistol near every start. These distances/times are provisional balance values. Gladiators killed during a live match wait 20 seconds, then return at a valid transit station ahead of the wall and at least 1,000 units from active contestants; if none is safe, redeployment waits. Earned upgrades are retained.

Outside a building its roof conceals interior actors and loot, even through a window. Inside, the roof disappears and ordinary wall/window/door sight applies to the outside world. Windows block movement and reaching for items; sight and bullets pass through. Doors can be opened and closed with E by either role, but cannot close onto an active body. These are provisional visibility semantics pending the batched review.

## 3. Match Rules

Contestants must complete the power-cell objective before spending one of the three escape slots. The match time limit is ten minutes; early finish conditions below still apply.

The default match contains eight contestant slots, two gladiator slots, three extraction slots, a seeded generated map, and bot occupants for unclaimed player slots. A connection is a viewer until it explicitly claims a contestant or gladiator slot. Spectators consume no slot, start no recording, and have no input authority.

The server advances the simulation at 20 Hz based on elapsed real time rather than trusting the operating-system timer interval. It can catch up a bounded number of ticks after a wake-up. Every simulated tick is recorded; only the latest state in a catch-up batch is broadcast.

The match finishes when all extraction slots are used, no active contestants remain, or the time limit expires. A started room with no connected players or spectators receives a 30-second reconnect grace, then ends and archives cleanly; abandoned playtests must not continue running bots and recording for the entire match. Active contestants left at time expiry become stranded. The exact numbers are tuning defaults and must stay named in code and docs when changed.

## 4. Information Rules

F-09 and F-10 govern viewport-wide sight and remembered gates. The server uses a bounded potential radius for transport; it is not a rendered circular fog boundary.

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
7. Destructible cover, command-center interactions, hunter-triggered hazards, richer camera/sensor stations, audio, authentication, public deployment, and retention policies. Trap variety and single-server matchmaking are implemented as tracked in section 2.1; richer variants and public infrastructure remain separate work.

## 8. Batch Product Review and Remaining Work

### Settled and integrated

- Inventory: six slots, finite ammunition, icons, move/swap/merge, drops, one cell per slot. Implemented defaults are in section 2.2; the former five-slot/unlimited-ammo version is superseded.
- Multi-floor direction: eventually playable ramps, roofs and overlapping floors, with discrete collision planes. This is accepted direction, not an open yes/no question. Collision-plane transitions and navigation-mesh design remain future engineering work.
- Access points mean hunter fast travel. Existing transit stations are the interim implementation.
- Contestants can fight one another. Bots initiate close-range fights after opening grace, and immediately retaliate. Spawns occupy four nearby blocks rather than one cluster.
- Functional buildings have doors, roof concealment and guaranteed useful loot. Non-colliding depot silhouettes were removed. Automated browser checks open a door and walk inside.

### Open questions — review together when convenient

1. Modular hierarchy: provide hierarchy levels, template sizes, connector contracts and one concrete example. Current street generation remains explicitly interim.
2. Exterior visibility: should open doors/windows reveal interiors to exterior players? Current roofs keep interiors hidden until entry.
3. Human balance: review route readability, vertical exploration, five-second charging, the ten-minute wall, PvP engagement distances and three extraction slots.
4. Ammo: keep ammunition attached to weapons and refill from matching pickups, or introduce magazines/reloads and separate ammo stacks? Current supplies/caps are provisional. Additional weapon types and an equipped-ability slot remain undecided.
5. Hunter travel/respawning: automatic safe placement versus chosen destinations, 20-second respawn, retained upgrades, and rewards for taking down a hunter.
6. Multi-floor implementation: ramp transition rules, overlapping-floor visibility/projectile rules, and a navigation representation compatible with intended templates.
7. Matchmaking and lifecycle: soft role preference, 15-second bot-fill timer and 30-second empty-room grace. Public hosting/accounts/ranking are separate work.
8. Performance: if a slowdown recurs, capture Replays → Download performance diagnostics. It includes recent raw frame intervals, packet gaps, browser/viewport, seed/location and live/empty room counts, but no owner credentials, chat or player list. Note whether movement stutters or the whole display freezes, plus elapsed match time and number of game tabs.
9. Patron actions, persistent progression, presenter UX and fairness remain separate milestones.

The reported severe slowdown is still open. Off-screen culling and navigation reuse are implemented; abandoned rooms now retire; previous benchmarks used smoothed frame deltas and have been replaced with raw timing. Passing local tests alone does not establish a fix.

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

### Future-work notes added 2026-09-09

These notes are accepted direction, unlike the exploratory original prompt above; section 2.1 provides requirement IDs. Improve procedural generation through hierarchies and selected tile templates controlling paths, with top/middle/bottom routes, some dead ends, keys, and relatively fixed access points. Require finding a power cell, charging it at a station, and delivering it to escape pods. Use cyberpunk urban dystopian ruins, interiors and exteriors, and a 2½D playing field. Add motion-sensitive mines, turrets, flamethrowers, and web-bound spider bots with limited pursuit and grappling. Give contestants weapon/item slots, more weapons, and no innate abilities, with one equipped-ability slot still a possibility. Add private rooms and matchmaking with optional role preference. Increase map size and tune objectives/travel toward ten minutes, with the wall reaching the end around ten minutes.

Visibility clarification: remove circular fog and fill the play-area viewport. Static map elements remain visible, while obstacles conceal dynamic entities. Retain the last-known state of changeable map elements such as doors; future dynamic terrain should follow that model. The precise meaning of 2½D remains open.

## 10. Maintenance Rules

When a requirement changes, update this file first, then update `DESIGN.md` or `ARCHITECTURE.md` only when the explanation belongs there. Add or update an acceptance test for every implemented requirement. Keep deferred work here until it is either implemented and tested or explicitly removed by a design decision. Record meaningful engine/library substitutions in `ARCHITECTURE.md` with license and rationale.
