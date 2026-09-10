# Playability pass — 2026-09-10

## Follow-up after user playtest

- Contestants start across four adjacent reachable blocks, separated by at least 400 units, with individual nearby weapons.
- Bots initiate close-range PvP after 30 seconds (180-unit personal space), expanding to 320 units after two minutes. Retaliation remains immediate.
- Every generated building contains a weapon or cell. Doors have contextual Open/Unlock/Close prompts; browser coverage now opens a door and walks inside rather than only teleporting to inspect the roof. Decorative depot ground silhouettes were removed because they resembled non-functional buildings.
- Terrain chunks now cull in both axes, as do labels and roofs. Roof layering no longer reorders every building twice per frame. Local navigation windows reuse their collision geometry instead of recreating it per grid.
- The reported severe slowdown remains unconfirmed: baseline entry Chrome was approximately 60 FPS; the revised dense-district run had 16.67 ms mean frames and 50.3 ms mean state gaps. Server sample with eight viewers was 1.26 ms mean / 2.67 ms p95 per tick. These samples do not prove the user's issue fixed. New reproducible dense case: `node tests/bench-client.mjs --location=dense --seconds=12`.
- User's six-slot/ammo/icon/rearrangement requirements and discrete-plane multi-floor direction are accepted follow-up work, not implemented in this feedback pass. Their original notes remain in requirements section 8.
- Follow-up validation: 44 unit/server tests, browser suite (including walking through a door), syntax checks, and dense-district benchmark pass. For the remaining performance review, record browser/device, seed/location, elapsed match time, number of open game tabs/rooms and whether the issue is low FPS or movement/network stutter; no immediate answer is required.

This is an interim maze implementation. The user's explicit modular/hierarchical design remains deferred, not completed. Batched design questions live in REQUIREMENTS.md section 8; no answers are required to try this build.

## Implemented

- 24,000 × 12,000 arena, versus 86,400 × 2,880. Connected randomized street graph with loops, offset passages, optional locked buildings, and small-body shortcuts. Local footprint reservations keep geometry off traversable streets; separated placement keeps loot, traps and stations from stacking.
- Route scoring reserves exploration time and rejects dangerous late westward backtracking. The wall still finishes at ten minutes after a one-minute grace period; main-route purposeful travel is roughly four minutes, not nine.
- One cell per ordinary inventory slot, five-second charging, retained charge on drops, G/touch drop control, and full-inventory E swaps.
- Closed roofs outside, transparent roofs inside; doors open/close, consume keys only when locked, and refuse to close on bodies. Windows allow sight and shots but not bodies or item interactions.
- Contestant projectile PvP, easy starter pistols, bot retaliation and crossfire avoidance. Gladiators return after 20 seconds at a safe transit station with upgrades retained.

## Validation and limitations

Unit/server tests cover 200 generated maps for both body sizes, route clearance, inventory, combat, doors/windows/roof semantics, respawning, privacy and replay authority. Another 50-seed test covers connectivity, loops, vertical objective distribution, placement separation and exploration pauses ahead of the wall. Browser checks cover desktop/mobile controls, visibility, charging/extraction, roof transitions, replay and spectators.

Final checks: 43 unit/server tests pass; desktop/mobile browser suite and syntax checks pass. Headless server benchmark averages 1.0 ms/tick (p95 3.5 ms, 50 ms budget); the 12-second Chrome client benchmark averages 54.5 FPS with 51 ms mean state gaps. These are local measurements, not production capacity guarantees. Changes are uncommitted and not pushed.

Headless no-hunter runs on seeds 1, 9 and 4217 fill all three extraction slots in roughly 3½–3¾ minutes. The full default bot match has one escape, seven contestant deaths, one gladiator death and redeployment. These are functional checks, not evidence that human multiplayer balance is finished.

Remaining limitations: uniform block-scale maze language rather than authored templates; no elevation/2½D; bots have global objective knowledge and can still bunch up or retaliate after accidental crossfire; static terrain/nearby potential state remains available to modified clients under the existing prototype trust model. Long optional detours can still be consumed by the wall. A rare crowded death-drop fallback may place loot at the original position if no clear nearby location exists. No public deployment, accounts or progression systems were added.
