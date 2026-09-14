# 31. Verification

## Gates

Every gameplay or protocol change should pass the gates relevant to what it
touched. An integration checkpoint runs all of them.

```powershell
npm run check
npm run typecheck
npm test
npm run test:browser
npm run bench
npm run bench:client
```

`npm run check` parses every JavaScript module as Node would load it and confirms
every TypeScript module erases cleanly, which is what Node does instead of parsing
it. `npm run typecheck` is the separate, stronger pass: `tsc --noEmit` over
`shared/` under `strict`. Browser tests drive installed Google Chrome through
Playwright and start an isolated temporary server; screenshots land in
`test-results/`.

Run timing comparisons sequentially, with no competing tests or benchmarks, and
repeat a suspected regression three times before believing it. Do not claim the
reported slowdown fixed without a captured slow run; see
[42](42-performance-history.md).

## The frozen fixture

Frozen characterization fixtures in `tests/fixtures` come from checkpoint `elements-1`,
which superseded `5dd7d61` when per-region element catalogues replaced the single
hardcoded building and changed every seeded map.

The fixture separates what the generator emits from what the simulation does.
Complete ordered map hashes characterize generation. The bot and scripted traces
characterize the simulation, and they run against **arenas stored in the fixture
itself** — `createGame(seed, map)` takes the stored one — rather than against
whatever the generator currently emits. So a deliberate content change re-baselines
four hashes and leaves every trace intact, instead of destroying the evidence that
the simulation is unchanged along with the content it happened to run on. Map
diversity stays covered by those hashes and by `playability.test.js`, which routes
bots to completion over generated maps.

Never regenerate a fixture to make a refactor pass: a behaviour-preserving change
must reproduce it exactly. Regenerating is correct only for a deliberate content or
rules change that has been decided, and it restarts the evidence — the current
fixture proves nothing about code predating it. Separate intentional gameplay
changes, and the new expectations and version decision they require, from
behaviour-preserving extraction. `tests/fixtures/README.md` records provenance, how
to regenerate and how to audit.

`npm run check` recursively checks every module in server/shared/public/tests:
JavaScript is parsed as Node would load it, and TypeScript is verified to erase
cleanly, which is what Node does instead of parsing it. `npm run typecheck` is the
separate, stronger pass.

## Coverage

The tests currently cover deterministic seeded simulation, 200 generated maps, shape records and element stamping, continuous movement and physical gaps, gates and extraction, combat and kit progression, transit, stealth, visibility geometry, privacy projections, one input spent per tick, pacing/replay integrity, spectators, desktop controls, touch controls, mouse aim, client-side sight, shaded occlusion, and projectile interpolation. The receive buffer is covered separately and directly, against a clock the test drives rather than against wall time: uneven arrivals, a catch-up batch that skips ticks, starvation, a reordered or duplicated frame, and a discontinuity large enough to cut. Those are the conditions that distinguish a buffer from a smoothing filter, and none of them are reachable through a happy-path integration test.
The input queue is covered the same way, and the assertion that matters is that a client replaying its
unacknowledged inputs through the shared movement code lands on the server's position exactly, rather
than close to it. Around it sit the cases that decide whether that holds under load: acknowledging on
consumption rather than arrival, a queue trimmed when a client outruns the tick, a starved queue that
repeats movement but not one-shot presses, and a silence long enough to stop the player.
Latency measurement is tested for the properties that make it safe to trade on rather than merely
accurate: an invented or superseded token is refused, a token counts once, a stalled echo cannot pull
the reported minimum up on its own, and sustained stalling is clamped instead of believed.
Lag compensation is tested for the property that separates it from simply being generous: a target
that has stepped out of reach is still hit, and a target that has only just stepped into reach is
not. Around that sit cover at the rewound position, the bound on how far back it will reach, the
absence of compensation for travel-time projectiles, and the history staying out of recordings.

Unit and server coverage includes 200-seed path clearance, 50-seed
placement/spawn/maze checks, ammo exhaustion and refill, sixth-slot selection,
move/merge validation, retained drops, doors and windows, hunter respawning, bot
retreat, abandoned-room archival and immutable replay commands. Objective-route runs
neutralize combat damage so PvP deaths do not invalidate navigation assertions.

Browser coverage includes keyboard and touch input, six slot icons, move/merge,
drops, charging and extraction, opening and walking through a real door, roof
transitions, occlusion, replay and spectators, and diagnostic download. A
deliberately injected 120 ms browser stall verifies diagnostics preserve long
frames rather than smoothing them away. The visibility polygon's culling is checked
against a brute-force implementation of the same rays over sixteen hundred cases,
including origins placed exactly on obstacle corners and edges, and must match it
vertex for vertex.

Boundary tests enforce ownership, not just behavior: server application code may
not use the diagnostic `room.game` escape hatch, transport may not reach the
simulation, and rooms may not reach gzip or filesystem details. Tests and
benchmarks may use `room.game` to arrange scenarios.

Human multiplayer balance is unverified by any of this. Passing local tests alone
establishes nothing about the reported slowdown.
