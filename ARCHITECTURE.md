# Architecture

## Stack Decision

Phaser renders the browser client. Node hosts an authoritative 20 Hz simulation over WebSockets. SAT.js supplies circle/polygon collision; PathFinding.js supplies bot route search. The map generator assembles generated sections with world-space geometry. Its coarse navigation sampling is private implementation detail and does not constrain human movement or rendering.

This first implementation uses a shared JavaScript core to make iteration and browser prediction direct. It is not a Rust implementation. The user allowed either Rust or an appropriate free/open-source ecosystem. Phaser's MIT-licensed browser focus fits this initial client; there is no engine editor or export pipeline to operate.

References: [Phaser](https://github.com/phaserjs/phaser), [SAT.js collision response](https://github.com/jriecken/sat-js), [PathFinding.js](https://github.com/qiao/PathFinding.js).

## Ownership

`shared/map.js` generates module layouts, obstacle geometry, props, gates, pickups, and navigation samples. `shared/movement.js` contains shared geometry, collision resolution, sight queries, and visibility polygons. `shared/simulation.js` owns fixed-tick rules, AI, combat, hazards, loot, and extraction. `server/index.js` owns rooms, connections, recording, archives, and static asset delivery. `public/client.js` owns input, networking, prediction, HUD, and replay controls; `public/arena-scene.js` renders the world and visibility mask.

The room loop paces itself against real time rather than against the timer. Platform timer granularity
is coarser than a tick — about 15.6 ms on Windows, which rounds a bare 50 ms interval up to 62.5 ms and
silently ran the match at 16 Hz — so the loop wakes several times per tick and advances each room by the
whole ticks that elapsed real time has earned, capped per wake so a stall cannot spiral into a burst.
Every simulated tick is still recorded; a catch-up batch sends only its newest snapshot. Tick spacing
therefore jitters by the wake granularity while the tick rate itself stays correct, which is what the
match clock and every tick-denominated constant depend on. Gameplay rates are expressed in ticks, so
changing `HZ` means rescaling them together; finer integration for a future physics system belongs in
substeps inside a tick rather than in a faster authoritative rate.

Clients send bounded movement axes, aim, button state, and monotonic sequence numbers. They cannot set health, world positions, inventory, or match outcomes. The server expires stale input and checks interaction range, cooldowns, collision, and extraction availability. Local movement is predicted with the same collision code and reconciled from authoritative snapshots. This prototype coalesces received input per simulation tick, except for one-shot presses, which latch until a tick spends them: clients send on their own interval, so two messages can land between two ticks and the later one must not erase a button press the earlier one carried. It has no rewind hit validation or latency-compensated combat.

Presentation smoothing is separate from simulation rate and belongs entirely to the client. Camera, own sprite, fog and cover all read one eased eye position rather than easing independently, because a fog polygon sampled at the raw predicted position while the camera eased toward it led the world by the easing lag and stepped at the input tick. Anything that only moves on an authoritative frame — projectiles, effect rings — is advanced by the elapsed fraction of a tick, since drawing it at the last received position makes 20 Hz motion visibly step at frame rate. The visibility polygon culls each segment to the angular wedge its endpoints subtend and sweeps those wedges in ray order, which is an exact optimisation, not an approximation, and is tested as such.

The server is authoritative over what could become visible, not over what is visible. It transmits everything within a generous radius of a viewer, plus anything a reveal has exposed at any range, and leaves line of sight to the client. That removes the latency and the pop that a per-tick server side sight test causes when something steps out of cover, and it gives the renderer the data it needs to shade rather than erase. The trade is explicit and deliberate: that radius is also how far a modified client could see through walls, so it is a tuned constant rather than the whole map. True line of sight stays server side and stays authoritative wherever it decides an outcome — bot targeting, ability reach, hit resolution — none of which may depend on anything a client asserts.

Filtering is field-level as well: another player carries only what the renderer draws, while inventory counts, ability timers, bot status, and input bookkeeping stay with the player they belong to, and replay-only bookkeeping is never broadcast. Recordings keep the complete state; a live view is a projection of it and must never differ where the two overlap. Every consumer of the transmitted state applies the client side sight test, the minimap included, since a surface that skipped it would quietly become a wallhack. This is not a complete production anti-cheat system.

Terrain, structures, gates, sensors and the hazard band are drawn everywhere and dimmed where they fall outside sight, so the arena stays readable and out of sight cover appears shadowed rather than absent. Actors, loot, shots and effects are withheld instead, and draw above the shade so anything in view reads at full brightness. Per entity visibility reuses the visibility polygon the fog is already drawn from — a log time query against its angle sorted vertices — so what is drawn and what is lit can never disagree, and no extra rays are cast.

A connection is a viewer before it is a player. Each socket holds a connection id, and a player id only once it claims a slot, so a non-player client is a first-class case rather than a missing player. A viewer id matching no player receives the directed view: unfogged, the same shape a recording plays back, and the basis for spectator, patron, and presenter clients. The owner-key gate remains, and spectator state is delayed by 60 authoritative ticks (three seconds at 20 Hz) before it is broadcast, so an audience cannot use the directed view to relay current positions. Broadcast cost is per distinct view rather than per socket — every spectator shares one filtered, serialized delayed payload — so an audience does not scale the tick. Non-player clients hold no slot, start no recording, and have no input authority; giving patrons a way to affect a match means a separate validated command type recorded alongside each frame, not a widening of player input.

## Recording Contract

Each room records a map header and every authoritative tick into a gzip JSON stream. Records contain a complete simulation snapshot plus accepted commands and membership changes. Frames include AI path state. The final metadata contains frame count and a SHA-256 digest over each serialized frame plus a newline. A recording is advertised only after the compressed file is finalized and renamed. Disk backpressure pauses tick advancement rather than dropping replay frames.

Replay playback restores recorded states directly, supports random seeking, and is independent of simulation determinism. Full-map viewing is restricted to completed recordings. This preserves exact recorded game states, not pixel-identical visual effects; decorative animations use render time. Same-runtime deterministic simulation is tested separately, but cross-platform input-only reconstruction is not claimed. Abrupt power loss can leave an incomplete `.partial` file that is retained but excluded from archives.

## Rust Path

If the prototype validates the game, move geometry and simulation into an engine-independent Rust crate with serializable state, fixed-tick input, and explicit randomness. Compile the same crate natively for the authoritative server and to WebAssembly for browser prediction. Keep the renderer and transport outside the crate. This avoids maintaining separate Rust and JavaScript gameplay implementations.

Rapier is a candidate if physics expands beyond kinematic collision. Its Rust and WASM ecosystem supports deterministic configurations, but determinism would still need tests covering game code, randomness, iteration order, and version changes. [Rapier determinism](https://rapier.rs/docs/user_guides/javascript/determinism/).

## Operational Limits

The server defaults to loopback and caps active rooms at eight. It has no authentication, public matchmaking, encrypted public hosting, horizontal scaling, retention policy, persistent unlocks, or automated crash recovery. Finished recordings accumulate until manually archived. Publishing publicly needs a separate deployment and security pass. The first slice intentionally has no sounds or persistent economy.
