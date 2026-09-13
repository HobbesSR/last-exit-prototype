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
7. Destructible cover, command-center interactions, hunter-triggered hazards, richer camera/sensor stations, audio, authentication, public deployment, and retention policies. Trap variety and single-server matchmaking are implemented as tracked in [13](13-accepted-features.md); richer variants and public infrastructure remain separate work.

F-01's hierarchical template system is deferred pending the user's detailed
specification; the interim street maze does not claim to implement it. Playable
elevation (2½D), overlapping floors and finished art remain incomplete under F-04.
Multi-floor direction is accepted; collision-plane transitions and navigation-mesh
design remain future engineering work.

Known prototype limitations, kept explicit rather than hidden: uniform interim
block geometry, global bot objective knowledge, possible crowding and accidental
crossfire, occasional crowded-drop fallback at the original position, and the
potential-state trust model described in [24](24-networking-privacy.md). No public
deployment or accounts exist; see [28](28-operational-limits.md).
