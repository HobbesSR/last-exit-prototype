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

Micro-generation changes additionally run `npm run test:micro`: focused contracts
and seeded builder tests plus all three isolated browser previews. The unit tests also run
in `npm test`. The lab browser check verifies actual builder content, control
variation, artifact download and movement, and saves `test-results/micro-lab.png`.
CLI batch generation/validation and limits are described in [20](20-micro-generation.md).
Decomposition checks cover immutable contexts and trial claims, graph/topology
analysis, generator contracts, residual tradeoffs, exact ownership and interface
accounting, corrupted artifacts, and CLI round trips. The decomposition browser
lab verifies policy controls, candidate inspection, imports/exports and narrow
viewports. Its diagrams are allocation proposals, not physical traversal tests.
The combined demo additionally checks generated child content, stable ownership
across content changes, export, stages, and real collision movement across a join.
Realization unit tests validate paired portals and both body-sized swept routes,
replay those routes with actual movement, preserve holes and reject corrupt output.
Exploration tests check exact recursive ownership, depth/search limits, distinct
objective choices and terminal constraints. The browser inspector exercises tree
and branch selection and exports. Entry-seed and ruin-decay tests compare actual
positions/geometry, and the micro browser verifies decay applies automatically.
Boundary tests cover disconnected interiors behind open mouths, single-port
standing clearance, body-specific passages, freeform routes, inherited and paired
child obligations, and rejection of silently split crossings. Access validation
uses final collision geometry rather than trusting recorded routes.

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

The current frozen characterization fixture is `behavior-netcode-1.json.gz`, captured at
`95b7f1b`. Its historical chain is `5dd7d61` (fixture captured at `0cd204e`) →
`elements-1` (`9fe2d94`) → stored-arenas split (`aa833a6`) → `netcode-1`.
`elements-1` superseded `5dd7d61` when per-region element catalogues replaced the
single hardcoded building and changed every seeded map. `netcode-1` changed simulation
traces for queued input consumption and bot route straightening while carrying forward
the generated hashes and stored arenas.

The fixture separates what the generator emits from what the simulation does.
Complete ordered map hashes characterize generation. The bot and scripted traces
characterize the simulation, and they run against **arenas stored in the fixture
itself** — `createGame(seed, map)` takes the stored one — rather than against
whatever the generator currently emits. So a deliberate content change re-baselines
four hashes and leaves every trace intact, instead of destroying the evidence that
the simulation is unchanged along with the content it happened to run on. Map
diversity stays covered by those hashes and by `playability.test.js`, which routes
bots to completion over generated maps.

The frozen tests select legacy `content-1` through `contentById` while running under
simulation version `last-exit-0.7`. The shipped default `content-2` adds the third
hunter; see [14](14-match-rules.md) for the roster and [26](26-recording-contract.md)
for the version decision. This checkpoint must not alter any fixture bytes.

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
Content pinning is tested for what pinning is *for* rather than for the plumbing: a match given a
harder-hitting pistol hits harder, which only holds if the read goes through the match and not the
module the defaults live in. Alongside it, two matches hold independent copies, a match cannot edit
the balance it runs under, a kit is validated against the match's own table, and the content stays
out of every frame while the recording header names it.

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
