# Current implementation — September 11, 2026

Simulation version: `last-exit-0.6`. The map/building/PvP checkpoint was committed and pushed as `00dc8ef`. The intended modular hierarchy remains deferred; this street maze does not claim to implement it.

## Current mechanics

- 24,000 × 12,000 connected street maze, loops, offset passages, optional locked buildings and small-body shortcuts. Reservations protect routes; object placements are separated. Wall deadline remains ten minutes, with a one-minute grace and exploration-aware route scoring.
- Eight contestants start across four nearby blocks, at least 400 units apart, each with a nearby pistol.
- Six icon-based equipment slots. Pistols/rifles/scatterguns carry finite ammo, replenished from matching pickups. Remaining rounds and cell charge survive drops. Medkits/shields stack to three. R/touch move/merge rearranges or recombines; G/touch drops.
- Power cells take a normal slot and charge in five seconds. Three pods remain the escape limit.
- Buildings contain useful weapon/cell loot. E opens/closes/unlocks doors; the UI names the nearby action. Roofs disappear inside. Windows pass sight and shots but block bodies and item reach.
- Contestant PvP, mixed bot temperaments, immediate retaliation and spacing away from hunter melee. Gladiators redeploy after 20 seconds at safe transit with upgrades retained.

## Performance and reliability work

- Server transport, room/session lifecycle, match access and replay storage now have separate owners and independent tests. Shutdown awaits outstanding replay publication, including already-retired rooms, and repeated close calls share completion.
- Live frame field contracts make additional internal fields private by default. Complete snapshots/replays and current serialized player views remain compatible with the original frozen fixtures.
- Crowd benchmarks compare nearby and off-screen actors with AI enabled or idle. AI dominates server work in these local samples; the severe slowdown has not been reproduced or declared fixed. See ENCAPSULATION_VERIFICATION.md for repeated measurements and limitations.

- Two-axis terrain/label/roof culling; stable roof layer instead of repeated per-frame reordering.
- Reused navigation collision geometry across local pathfinding windows.
- Abandoned live rooms retain a 30-second reconnect grace, then end and archive, avoiding ten-minute background bot/recording workloads during repeated playtests.
- Replays copy sanitized accepted inputs before one-shot fields are cleared; inventory commands and interactions remain recorded.
- Raw frame intervals replace Phaser-smoothed delta. Profiler call rates now use the same rolling window as timings; client benchmark excludes warm-up frames.
- Replays → Download performance diagnostics captures bounded recent frame/packet timings and environment/seed/location/room counts. No owner credentials or player list is included.

The user's severe slowdown remains open. A recent raw entry benchmark measured 60.0 FPS, 17.5 ms p95 frames and 49.9 ms mean packet gaps; a dense-area sample also averaged 16.67 ms frames. These local results do not establish the user's issue fixed.

## Verification

After server encapsulation and field contracts, 74 unit/server/characterization tests pass; the desktop/mobile browser suite plus independent input/HUD checks pass; recursive syntax and diff checks pass; both benchmark commands complete. See `ENCAPSULATION_VERIFICATION.md` for this pass, and `REFACTOR_VERIFICATION.md` and `REFACTOR_BENCHMARKS.json` for the earlier simulation/map/client extraction. The original fixture remains unchanged. The diagnostics browser test preserves a deliberately injected long frame.

Unit/server coverage includes 200-seed path clearance, 50-seed placement/spawn/maze checks, ammo exhaustion/refill, sixth-slot selection, move/merge validation, retained drops, doors/windows, hunter respawning, bot retreat, abandoned-room archival and immutable replay commands. Objective-route runs neutralize combat damage so PvP deaths do not invalidate navigation assertions. Full default bot play with combat completes three escapes in about 223 seconds in the latest sample; human balance is still unverified.

Browser coverage includes keyboard/touch, six slot icons, move/merge, drops, charging/extraction, opening and walking through a real door, roof transitions, occlusion, replay/spectators and diagnostic download. A deliberate 120 ms browser stall verifies diagnostics preserve long frames.

## Remaining work

Canonical settled decisions and open questions are in REQUIREMENTS.md section 8. Three hunters, weapon tiers, drag/drop weapon gestures, reloads retaining ammunition, ammo pickups, spatial reward/danger scaling, proximity trap concealment and force/impulse/friction physics are accepted requirements pending a separate gameplay checkpoint. The current prototype still has two hunters. ENCAPSULATION_PLAN.md describes useful implementation boundaries and batches the production policy questions. Other priorities remain capturing an actual slow run, human playtesting, explicit modular templates and discrete-plane ramps/roofs/overlapping floors.

Known limitations: uniform interim block geometry, global bot objective knowledge, possible crowding/accidental crossfire, occasional crowded-drop fallback at the original position, and the prototype's potential-state trust model. No public deployment or accounts were added.
