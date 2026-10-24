# 14. Match rules and implemented defaults

Every number here is a tuning default of `content-5` under `last-exit-0.7` rules,
not a design constant. When one changes, it must stay named in code and updated
here in the same change. Accepted-but-unimplemented changes live in
[13](13-accepted-features.md).

## Capacities and the objective

Contestants must complete the power-cell objective before spending one of the three escape slots. The match time limit is ten minutes; early finish conditions below still apply.

The default match contains eight contestant slots, three gladiator slots, three extraction slots, a seeded generated map, and bot occupants for unclaimed player slots. A connection is a viewer until it explicitly claims a contestant or gladiator slot. Spectators consume no slot, start no recording, and have no input authority.

`content-2` implements F-11 by appending BLAZE (Striker) after IRONCLAD (Warden)
and VESPER (Specter). The chain's departure region supplies each hunter's initial spawn; transit
stations are separate redeployment and fast-travel sites. The name and one-of-each-kit roster
are tuning choices for this checkpoint. Contestant and extraction capacities stay
unchanged. `contentById('content-1')` retains the two-hunter baseline for frozen
characterization. Each selection returns
an independent deeply frozen copy, and unknown content IDs are rejected. This is
a content revision, with unchanged simulation rules and recording structure; see
[26](26-recording-contract.md) and [31](31-verification.md).

`content-3`, the default (`defaultContent()`), keeps `content-2`'s numbers and roster and
changes how bots plan: over free-space tiles, contestants from what they know
([22.6](22.6-hierarchical-navigation.md), #424). `content-2` remains selectable with the
grid planner.

`content-4`, the default from #470 part 1 to part 2, is `content-3` with each bot's repath spread over several
ticks while it walks its current route (`replanning: 'sliced'`, 22.6). Because a route arrives
after the bot has moved on, a bot turns a corner early only when it is within the 2-unit margin
the planner keeps beyond its body. Its numbers and roster are unchanged; `content-3` remains
selectable with whole-tick searches.

`content-5`, the default since #470 part 2, is `content-4` with local repair
(`replanning: 'repair'`, 22.6): when a contestant learns of a door or ground near itself or on
the next stretch of its route, it searches round the change at once and keeps the rest of its
route, rather than walking on until its next sliced repath. Its numbers and roster are unchanged;
`content-4` remains selectable.

The power-cell objective supplements limited escape capacity; three extraction slots remain a baseline tuning default. Contestant equipment changes do not remove gladiator kits or kill-based progression. The ten-minute deadline leaves time for exploration and combat, not ten minutes of uninterrupted running. Existing early match-end conditions remain.

## Experimental character profile (#439)

Explicitly pass `contentById('content-physics-2')` to `createPhysicsGame` or
`createPhysicsMatch` to select `last-exit-0.8-physics-2`. Neither the normal room
nor the physics factory's omitted-content default selects it. P1 remains
available with content-1 through content-5. These are provisional playtest
settings, not a default balance change.

| Role | Nominal head radius | Movement radius | Retained combat radius |
| --- | ---: | ---: | ---: |
| Contestant | 14.109375 | 11.2875 | 12 |
| Gladiator | 20.3125 | 16.25 | 23 |

Nominal head circles are measured from contestant.svg (21 at display scale
43/64) and warden.svg (25 at 65/80), without outline or equipment protrusions.
Bodies use 0.8 of those radii. Combat retains its existing attack-specific
allowances: projectile contact remains 15/26, including the legacy allowance
beyond the nominal combat radius. Neither movement nor art changes hit queries.

Both roles and teammates have rotation-locked equal-mass bodies (mass 1), zero
contact friction and restitution. Acceleration and braking start at 3,600 world
units/second squared. External impulses are capped per event at magnitude 600;
total body speed is capped at 600 units/second and also at the adapter's smaller
radius-dependent safety limit. Motor recovery changes velocity by bounded effort
rather than discarding external velocity. Existing movement speed modifiers stay
owned by movementSpeed. Floor modifiers and placement behavior follow [29.1](29.1-physics-design.md).
Navigation keeps its existing conservative radii until P8; this may reject a
route that a narrower physical body can traverse. Live promotion still needs
P3/P4, P8's actor-placement slice and P9.

## Power cells

Each cell occupies one of the six ordinary equipment slots and never stacks; carrying several costs several slots. Keys remain separate. A cell takes 100 ticks (five seconds) to charge; press E in range and stay still. Movement or leaving the station pauses charging but retains progress. Stations can charge multiple contestants. Elimination drops the cell with its charge; extraction consumes it. Traps are placed at least 850 units from chargers so required stationary charging is not automatically covered by a trap.

## Equipment and inventory

Equipment has six mixed slots. 1–6 or slot buttons select equipment; fire/use activates it. Items use icons with numeric ammo, stack or charge badges, tooltips and accessible names. R or Move/merge selects the current item for rearrangement; choose a destination with a number key or slot button. Matching medkit/shield stacks combine up to three; other items swap. Medkits restore 40 HP and shields restore 30 (75 maximum). Each cell takes one slot and never stacks.

Drag an occupied slot at least eight screen pixels to another slot to move,
swap or merge it. Release over the arena canvas to drop that source item beside
the player, using the same placement and pickup delay as G; the pointer does not
choose a remote world location. Releasing over other UI cancels. Mouse and touch
share the gesture, including touch dragging while another finger holds the move
stick. Cancellation, blur, dialogs, inactive players and replay mode prevent
unfinished gestures from producing inventory commands. Inventory changes remain
authoritative; the UI does not move items before the server responds.

E swaps nearby loot into the selected slot when full. G or Drop selected drops the whole selected slot; a one-second owner pickup delay avoids immediate recollection. Drops retain cell charge and remaining weapon ammunition. Pistol/rifle/scattergun pickups start with 48/90/24 rounds, capped at 192/360/96 per weapon. One shot costs one round, including a scattergun's five-pellet shot. Matching weapon pickups replenish ammo even with full inventory; untransferred rounds remain on the ground. There is no reload mechanic or separate reserve-ammo slot yet. Existing damage/cooldowns remain pistol 10/8 ticks, rifle 6/4, scattergun five 7-damage pellets/18. No contestant ability slot is implemented.

### Explicit L0 item instances (#442)

`createGame(seed, map, contentById('content-equipment-1'))` selects
`last-exit-0.8-equipment-1`. Default rooms, retained content sets and the frozen
fixture keep their existing behavior. L0 uses the ordinary movement loop without
a solver; `createPhysicsGame` refuses this selection until P5 integrates it.
The content otherwise retains content-5 tuning and six-slot controls.

Ground `id` is the persistent instance identity. Carried entries retain it as
`instanceId`, with a `lineageId` naming the original root. A whole pickup/drop
keeps that identity; splitting retains the original on one survivor and allocates
deterministic `instance-N` children for the others. Merges retain the target's
identity/root and retire the fully consumed source. This is bounded root lineage,
not an accumulating ancestry log. IDs for old carried entries are assigned in
player-ID/slot order before tick actions. A separate recorded `itemSerial` counter
does not consume legacy RNG or event IDs; initial IDs in its namespace are reserved.
Item definitions remain kind/weaponType; optional quality 1..5 is preserved but
does not alter statistics. Only equal qualities merge (omitted quality means 1).

Utility stacks stay capped at three in inventory; partial ground transfers retain
the source remainder. Drops scatter one ground entry per utility unit. Optional
drops reject the entire operation if the provisional 4,096-entry ground capacity
or bounded placement search cannot represent it. Inventory and allocation state
are unchanged on rejection. Full-inventory E swaps stage pickup and outgoing drop
together; an incomplete incoming refill rejects that swap without transferring
ammo. Automatic matching pickups still refill partially. Both E and automatic
pickup honor the one-second self-drop delay. Competing pickups resolve in lexical
player-ID order in this separately versioned loop.

Mandatory death drops may exceed the optional capacity and fall back to the
player's position when scattering is impossible. They remain ordinary recoverable
logical loot, including fully charged cells. Capacity never deletes their value.
A malformed carried entry that no ground record can represent is cleared without
halting the tick; well-formed value always drops.
The mandatory reserve is all carried value: at most eighteen utility units per
six-slot inventory, with no cap rejection. Overflow creates no extra value and
is bounded by the match's finite admitted loot quantity; repeated transfers do
not grow it. P5 must reserve bodies separately and keep this logical fallback when
body admission fails. L0 creates no bodies or joints. Tiers/reloading remain later work.

## Traps

Mine radius is 65 with a 120-unit blast and 45 damage; actual movement above 0.5 units triggers it once. Turrets target either role within 650 units and fire 12-damage shots on a 35-tick cooldown. Flame cycles last 160 ticks, warn for 40, then fire for 40; cone reach is 240 with wall checks. Spider webs acquire within 240, release targets beyond 360 from home, and grapple within 150 for 10 damage plus 30 ticks of movement slowdown on a 50-tick cooldown. All are prototype balance values.

## Contestant PvP, bots, spawns and gladiator respawn

Contestants can damage each other with projectiles. Bots retaliate immediately; roughly one third have an opportunistic temperament and may initiate fights after 30 seconds within 180 units, expanding to 320 units after two minutes. They avoid shooting directly through a third contestant and seek collision-clear space away from hunters within 170 units while returning fire. Starts are spread by the arrival strategy across its region, with a pistol and an uncharged cell within 100 units of every start. The former street map's four-block, 400-unit separation is not a promise of the chain map. These distances/times are provisional balance values.

Contestant bots search rather than know (15, #230). With no known cell, or no known charger for an uncharged cell, or an unknown exit for a charged one, a bot heads for the frontier of what it has seen: the unseen discovery cell next to a seen one that is nearest, with each unit of lead toward the exit worth half a unit of distance, and at least 300 units ahead of the wall. It keeps that target until the cell is discovered, and gives a frontier cell up for good when it cannot be routed to, when the bot has stood inside it for a sample (10 ticks) and still not seen it, or when it is not approached by 16 units within 6 seconds. Coming near is not arriving: a roofed cell stays concealed until the bot is under the roof. An item it stops approaching the same way, such as one seen through a window, is set aside for 30 seconds. Live maps carry three chargers, one per band along the map (52, 55). These are provisional tuning values. Gladiators killed during a live match wait 20 seconds, then return at a valid transit station ahead of the wall and at least 1,000 units from active contestants; if none is safe, redeployment waits. Earned upgrades are retained.

## Buildings, doors and windows

Outside a building its roof conceals interior actors and loot, even through a window. Inside, the roof disappears and ordinary wall/window/door sight applies to the outside world. Windows block movement and reaching for items; sight and bullets pass through. Doors can be opened and closed with E by either role, but cannot close onto an active body. These are provisional visibility semantics pending the batched review.

## Room creation

`POST /api/rooms` takes an optional `seed` and an optional `size`. With no seed
the room draws a random one from 1 to 2147483647 (#234), so general play varies;
a named seed reproduces a map, and the room's seed is in its recording. The
deploy dialog starts with a random seed, and `?seed=` still names one. `size` is
a zone size written `12x6`, `24x12` or `36x18`, the sizes a library is authored
for (55); the default is `12x6`, and any other value is refused with a 400 naming
the sizes. The lobby shows the room's size. A 12 × 6 map is 17,280 by 8,640 world
units; each larger size is two and three times that in each direction.
Matchmade rooms are always 12 × 6 with a random seed. The map is generated on a
worker thread, so other rooms keep running meanwhile (#253). The room exists, and
the request answers, at once (#258): players join its lobby while the map is
generated, which takes seconds at the larger sizes and tens of seconds for some
seeds (42), and the lobby says so. The owner's start, and a matchmade room's
countdown, wait for the map: a start pressed early happens when it is ready. A
36 × 18 room does not hold the tick budget alone (42).

## Matchmaking and lobby

Matchmaking only considers unstarted matchmade rooms on this server. It honors an available preferred role; otherwise it fills the role with the lower occupied fraction, with contestant as the tie-breaker. A 15-second countdown begins with the first join, then bots fill vacancies. Private rooms are excluded and remain owner-started. Before the start a joining player is placed in the role they asked for, or on the other side when that one is full of people, and in the lobby anyone may change role and kit while the side they want has a place; a full side is refused, never swapped (17.3 #14). Once a private match has started, a late join gets only the role it asked for. The deploy dialog lists rooms not yet started that are matchmade or named, with Join and, as Auto, matchmaking ([22.5](22.5-lobbies-and-matchmaking.md#lobby-browser)). Session-stored rotating resume credentials reclaim the same actor; owner credentials restore lobby/finish authority and never enter shared invite links.

## Tick pacing and match completion

The server advances the simulation at 20 Hz based on elapsed real time rather than trusting the operating-system timer interval. It can catch up a bounded number of ticks after a wake-up. Every simulated tick is offered to the bounded recorder; only the latest state in a catch-up batch is broadcast. Recording backpressure never pauses advancement.

Recording has an 8 MiB pending-data budget per match. On overflow, whole incoming
frames are omitted until capacity returns. A recovered archive explicitly records
its omission count and match endpoint; playback holds the last known state through
missing ticks and labels the gap. Permanent write failures stop recording and
notify viewers through a replay-specific status, while inputs and live state
continue. Finalization has a five-second deadline and never reports a failed
archive as saved. JSON serialization still uses the server event loop; this is
storage-failure isolation, not a claim that recording consumes no CPU.
See [26](26-recording-contract.md) for the queue, recovery and compatibility contract.

The match finishes when all extraction slots are used, no active contestants remain, or the time limit expires. A started room with no connected players or spectators receives a 30-second reconnect grace, then ends and archives cleanly; abandoned playtests must not continue running bots and recording for the entire match. Active contestants left at time expiry become stranded. The exact numbers are tuning defaults and must stay named in code and docs when changed.

## Live chain maps

Live matches use `chain-live-1` (`map/live.ts`): the authored chain library at
48 world units per cell, on the diamond zone plan at its default size (55),
yielding a 17,280 by 8,640 map. One physical extraction
site shares the existing three slots. Core sites supply contestant starts,
hunter starts, the charger and six distributed transit stations (52, 54).
Missing, extra or obstructed required starts/exits fail explicitly. The adapter
also refuses absent charging or the wrong transit count; it supplies no corner
fallbacks. Stations retain their owning region IDs.

Current player radii (12 contestant, 23 hunter), movement speeds, combat tuning,
charging time and match deadline remain unchanged by Corey's choice (17).
The existing west-to-east wall scales its progress to the actual map width.
The cell-profile contestant-only passage balance is a separate tuning pass;
this checkpoint does not claim that the smaller live hunter is blocked by every
1.5-cell squeeze (52).

Generated loot uses its authoritative site and tier metadata. #214 lowers the
default gradient from 0.015 plus 0.034 per tier to 0.012 plus 0.027: the more
varied fill paints more regions that roll loot, so the roughly 20% reduction
keeps item supply near the earlier budget. Explicit caller overrides still apply.
The 12-seed comparison against the implemented margin policy still increases mean
loot by about 10% (52); this is a content balance change, not exact supply preservation.
Each region type
rolls a loot chance per cell that starts at 0.012 in tier 1 and rises 0.027 a
tier (`DEFAULT_CHAIN_PARAMS`); `open` rolls none (54). S5's bigger set pieces
(#170) put a type that rolls loot on about 55% of the map, up from 13%, so the
old 0.04 and 0.09 were scaled by 0.37 to keep about 950 sites per live map
(Corey, 2026-10-04). The provisional
seeded kind weights are cell 3, weapon 3, medkit 1, shield 1, access 1; a weapon
selects pistol, rifle or scattergun equally. Cells start uncharged. Tier metadata
does not change weapon statistics or inventory rules; weapon tiers remain
separate work (17). Traps, sensors and locked-door authoring remain deferred
for the chain (16), so this library emits none of them. Their existing simulation
mechanics still apply to stored legacy maps.
