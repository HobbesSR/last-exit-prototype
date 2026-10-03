# 16. Settled decisions and deferred work

## Settled and integrated

- Inventory: six slots, finite ammunition, icons, move/swap/merge, drops, one cell per slot. Implemented defaults are in [14](14-match-rules.md); the former five-slot/unlimited-ammo version is superseded.
- Multi-floor direction: eventually playable ramps, roofs and overlapping floors, with discrete collision planes. This is accepted direction, not an open yes/no question. Collision-plane transitions and navigation-mesh design remain future engineering work.
- Access points mean hunter fast travel. Existing transit stations are the interim implementation.
- Contestants can fight one another. Bots initiate close-range fights after opening grace, and immediately retaliate. Spawns occupy four nearby blocks rather than one cluster.
- Functional buildings have doors, roof concealment and guaranteed useful loot. Non-colliding depot silhouettes were removed. Automated browser checks open a door and walk inside.

## Deliberately deferred

These are requirements for later milestones, not silently missing pieces of the
current proof of concept:

1. Presenter/caster controls for switching camera focus and identifying action.
2. Validated spectator patron commands that drop items for contestants; these must be a separate command type and replay event, never player input authority.
3. Enemy fade-out and last-seen indicators when an actor leaves sight.
4. Physics substeps inside the 20 Hz tick for projectiles, knockback, and richer hazards.
5. Wedge-culling for server `lineClear` queries if profiling shows it matters; client visibility already uses the optimized sweep.
6. Persistent gladiator unlocks, contestant perks, card/sticker packs, pre-game cards, cosmetics, and a fair monetization model.
7. Unreliable transport. WebSocket runs over TCP, so one lost packet holds up every
   frame behind it — head-of-line blocking the receive buffer can only paper over by
   holding frames longer. WebRTC data channels (geckos.io, MIT) remove it, at the cost
   of signalling, NAT traversal and a second transport to operate. Deferred until
   measured, and the measurement now exists: `net.rttMs` reports what the server timed,
   and the buffer's `starved` and `snaps` counters report how often a frame arrived too
   late to draw. If starvation stays near zero on real connections, TCP is not the limit
   and this buys nothing. Take the numbers from a real network rather than loopback,
   where the stall rate is zero by construction.
8. Destructible cover, command-center interactions, hunter-triggered hazards, richer camera/sensor stations, audio, authentication, public deployment, and retention policies. Trap variety and single-server matchmaking are implemented as tracked in [13](13-accepted-features.md); richer variants and public infrastructure remain separate work.

F-01 micro generation is active under the user's September 19 direction; see
[20](20-micro-generation.md). Macro integration is specified as the generation
chain ([51](51-generation-chain.md)) and, like recursive child regions, remains
incomplete. The interim street maze doesn't claim to implement either.

Deferred within map generation, by Corey's answers in [17](17-open-questions.md):
- **Macro geometry prescriptions** (walls, fences): taken out of the library on
  2026-09-28, to "add them back in" later. When they return, a fence is
  passable because hunters can break it. How validation reports routes that
  need a fence broken is decided then.
- **An impassable directive** to builders: at most an architectural suggestion,
  "if at all" (2026-09-28).
- **Ceilings and sealed runs**, from macro or between a region's children:
  "we'll add that in later if we need it, let's keep in simple" (2026-09-29).
  Obligations are passability only.
- **Loot as a macro concern:** "that can be added in later" (2026-09-28).
  Regions place loot.
- **Primitive sets:** what declarations become physically in each part of the
  map ([52](52-map-primitives-and-library.md)).
- **Zone-driven hazards,** and builders with no region to attach to
  (map-boundary treatment).
- **Special access policies** such as locked doors on required routes
  (17, September 22: "parameter passing we can defer"). The `warp` core element
  now supplies authored transit in the live checkpoint (17, 52, 54).
- **Until the chain works top to bottom with core elements** (17 M18, M21 to
  M23 and M25, 2026-10-02):
  - reworking authoring, and specially recognized region types (M18)
  - squeezes required from macro (M21)
  - elements with mechanics other than core elements, such as traps, sensors
    and turrets, and how builders incorporate them, including spacing rules
    that reach across regions (M22)
  - how to reason about locked doors (M23)
  - what an `open` region may hold. For now it is pure open cells (M25)

Playable
elevation (2½D), overlapping floors and finished art remain incomplete under F-04.
Multi-floor direction is accepted; collision-plane transitions and navigation-mesh
design remain future engineering work.

Known prototype limitations, kept explicit rather than hidden: uniform interim
block geometry, global bot objective knowledge, possible crowding and accidental
crossfire, occasional crowded-drop fallback at the original position, and the
potential-state trust model described in [24](24-networking-privacy.md). No public
deployment or accounts exist; see [28](28-operational-limits.md).
