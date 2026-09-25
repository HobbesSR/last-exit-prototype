# 14. Match rules and implemented defaults

Every number here is a tuning default of `content-2` under `last-exit-0.7` rules,
not a design constant. When one changes, it must stay named in code and updated
here in the same change. Accepted-but-unimplemented changes live in
[13](13-accepted-features.md).

## Capacities and the objective

Contestants must complete the power-cell objective before spending one of the three escape slots. The match time limit is ten minutes; early finish conditions below still apply.

The default match contains eight contestant slots, three gladiator slots, three extraction slots, a seeded generated map, and bot occupants for unclaimed player slots. A connection is a viewer until it explicitly claims a contestant or gladiator slot. Spectators consume no slot, start no recording, and have no input authority.

`content-2` implements F-11 by appending BLAZE (Striker) after IRONCLAD (Warden)
and VESPER (Specter). The existing station assignment puts each hunter at a
successive station counted back from the end. The name and one-of-each-kit roster
are tuning choices for this checkpoint. Contestant and extraction capacities stay
unchanged. `contentById('content-1')` retains the two-hunter baseline for frozen
characterization; `defaultContent()` selects `content-2`. Each selection returns
an independent deeply frozen copy, and unknown content IDs are rejected. This is
a content revision, with unchanged simulation rules and recording structure; see
[26](26-recording-contract.md) and [31](31-verification.md).

The power-cell objective supplements limited escape capacity; three extraction slots remain a baseline tuning default. Contestant equipment changes do not remove gladiator kits or kill-based progression. The ten-minute deadline leaves time for exploration and combat, not ten minutes of uninterrupted running. Existing early match-end conditions remain.

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

## Traps

Mine radius is 65 with a 120-unit blast and 45 damage; actual movement above 0.5 units triggers it once. Turrets target either role within 650 units and fire 12-damage shots on a 35-tick cooldown. Flame cycles last 160 ticks, warn for 40, then fire for 40; cone reach is 240 with wall checks. Spider webs acquire within 240, release targets beyond 360 from home, and grapple within 150 for 10 damage plus 30 ticks of movement slowdown on a 50-tick cooldown. All are prototype balance values.

## Contestant PvP, bots, spawns and gladiator respawn

Contestants can damage each other with projectiles. Bots retaliate immediately; roughly one third have an opportunistic temperament and may initiate fights after 30 seconds within 180 units, expanding to 320 units after two minutes. They avoid shooting directly through a third contestant and seek collision-clear space away from hunters within 170 units while returning fire. Starts are distributed across four nearby connected blocks, with at least 400 units between players and a pistol near every start. These distances/times are provisional balance values. Gladiators killed during a live match wait 20 seconds, then return at a valid transit station ahead of the wall and at least 1,000 units from active contestants; if none is safe, redeployment waits. Earned upgrades are retained.

## Buildings, doors and windows

Outside a building its roof conceals interior actors and loot, even through a window. Inside, the roof disappears and ordinary wall/window/door sight applies to the outside world. Windows block movement and reaching for items; sight and bullets pass through. Doors can be opened and closed with E by either role, but cannot close onto an active body. These are provisional visibility semantics pending the batched review.

## Matchmaking and lobby

Matchmaking only considers unstarted matchmade rooms on this server. It honors an available preferred role; otherwise it fills the role with the lower occupied fraction, with contestant as the tie-breaker. A 15-second countdown begins with the first join, then bots fill vacancies. Private rooms are excluded and remain owner-started. Session-stored rotating resume credentials reclaim the same actor; owner credentials restore lobby/finish authority and never enter shared invite links.

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
