# 24. Networking and privacy

The rules this mechanism enforces are in [15](15-information-rules.md).

## Client authority

Clients send bounded movement axes, aim, button state, and monotonic sequence numbers. They cannot set health, world positions, inventory, or match outcomes. The server expires stale input and checks interaction range, cooldowns, collision, and extraction availability. Local movement is predicted with the same collision code and reconciled from authoritative snapshots. Input is queued per player and a tick spends exactly one. That is what makes reconciliation exact, and it replaced coalescing rather than refining it: clients send on their own interval, so two messages can land between two ticks and none between the next two, and a merge applied one movement step where the client had already predicted two while a late packet applied the previous step twice. Both directions diverged, on a large fraction of ticks, and reached the player as a correction indistinguishable from a real one. Latching went with it — a one-shot press needed rescuing only because a merge could erase it, and nothing is merged now.

Two sequence numbers are kept, and the split is the point. One records what was *accepted*, guarding ordering and duplicates on arrival; `lastSeq`, the one transmitted, records what a tick has *spent*. Acknowledging on arrival tells a client an input was applied while it is still sitting in the queue, and the client then stops replaying it. A queue deeper than a few inputs is trimmed from the oldest, because an unbounded queue is unbounded input lag and the newest input is the closest to what the player currently intends. An empty queue repeats the last input's movement and aim for a short while — one late packet is far likelier than a player releasing every key — but never its one-shot presses, since that would turn packet loss into an action the player never asked for. The repeat is reported to the client so a correction it could not have predicted is distinguishable from one it mispredicted. Measured against a real client over a socket, holding a movement key, the queue sits in equilibrium at one input in flight with no stalls at all across 161 ticks, and never approaches the depth cap. The client therefore does not adapt its send rate and should not be given machinery to: a free-running 20 Hz send and a 20 Hz consumption balance on their own, and the repeat exists for the loss and jitter a local socket does not show, not for a rate mismatch.

Instantaneous attacks are resolved against what their attacker could see. It measures what that needs, and then uses it. The server stamps a token once a second, the client echoes it, and the server times the
return against its own clock: the client reports no number and can only return something it could not
have held earlier. It can still stall an echo, and that only ever makes its own connection look
slower — the direction that would buy a cheat more rewind — so the reported figure is the minimum of
the last five samples rather than their mean, and it is clamped at 400 ms. A lag switch cannot pull a
minimum upward without holding back every echo in the window, and the clamp bounds what it would win
if it did. Anything that later trades on latency must treat this as an upper bound the server chose,
never as a client statement.

## Lag compensation

A player aims at what is on their screen, and what is on their screen is old: two ticks of
interpolation delay by design, plus however long the frame took to arrive. Resolving a swing against
where the target is *now* charges the attacker for both, and the amount is invisible and varies with
their connection. `shared/simulation/rewind.ts` keeps ten ticks of positions and resolves a gladiator's
melee and a warden's shockwave against the positions their attacker was looking at, derived from the
measured round trip plus the buffer's own delay. Range, firing arc and cover all read the rewound
position: a compensated hit still had to have had line of sight.

This is not permissiveness, and the distinction is what the tests pin. A target that has stepped out
of reach since can still be hit; a target that has only just stepped *into* reach cannot, because the
attacker could not have seen them there. The cost is paid by the person being shot at, who can be hit
after reaching cover on their own screen. That trade is the standard one, and it is why the window is
bounded at half a second: past that a connection is too far behind to compensate for without the
victim's experience becoming the absurd one.

Travel-time projectiles are deliberately left alone. A player already leads a moving target by the
flight time, aiming where it will be rather than where it was, so rewinding the shot as well would
compensate twice and land it behind. That is a decision about this game's weapons, not a gap:
revisit it if a hitscan weapon is ever added.

The history never reaches a snapshot or a recording. It is derivable from the frames a recording
already holds, so carrying it would store the same positions twice. A player with no measured
latency — a bot, a local match, anyone before their first round trip returns — carries no trace of
the mechanism at all, which is why the frozen behaviour baseline is unchanged by it.

## Potential visibility

The server is authoritative over what could become visible, not over what is visible. It transmits everything within a generous radius of a viewer, plus anything a reveal has exposed at any range, and leaves line of sight to the client. That removes the latency and the pop that a per-tick server side sight test causes when something steps out of cover, and it gives the renderer the data it needs to shade rather than erase. The trade is explicit and deliberate: that radius is also how far a modified client could see through walls, so it is a tuned constant rather than the whole map. True line of sight stays server side and stays authoritative wherever it decides an outcome — bot targeting, ability reach, hit resolution — none of which may depend on anything a client asserts.

Filtering is field-level as well: another player carries only what the renderer draws, while inventory counts, ability timers, bot status, and input bookkeeping stay with the player they belong to, and replay-only bookkeeping is never broadcast. Recordings keep the complete state; a live view is a projection of it and must never differ where the two overlap. Every consumer of the transmitted state applies the client side sight test, the minimap included, since a surface that skipped it would quietly become a wallhack. This is not a complete production anti-cheat system.

`shared/simulation/projection-contract.ts` explicitly lists the live frame, own-player, equipment, gate, trap, projectile, effect and event fields. Source-key order and optional-field presence are retained for existing serialized output. Adding simulation bookkeeping now requires deliberate opt-in before it appears in those payloads. Other-player fields retain their existing narrower contract; snapshots and recordings remain complete. Static welcome-map content still follows the prototype map contract, and permitted fields retain their current types: these lists are not a protocol migration framework or full schema validator.

## Viewers and spectators

A connection is a viewer before it is a player. Each socket holds a connection id, and a player id only once it claims a slot, so a non-player client is a first-class case rather than a missing player. A viewer id matching no player receives the directed view: unfogged, the same shape a recording plays back, and the basis for spectator, patron, and presenter clients. The owner-key gate remains, and spectator state is delayed by 60 authoritative ticks (three seconds at 20 Hz) before it is broadcast, so an audience cannot use the directed view to relay current positions. Broadcast cost is per distinct view rather than per socket — every spectator shares one filtered, serialized delayed payload — so an audience does not scale the tick. Non-player clients hold no slot, start no recording, and have no input authority; giving patrons a way to affect a match means a separate validated command type recorded alongside each frame, not a widening of player input.
