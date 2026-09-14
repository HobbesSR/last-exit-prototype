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

Frozen characterization fixtures in `tests/fixtures` come from checkpoint `elements-1`, which superseded `5dd7d61` when per-region element catalogues replaced the single hardcoded building and changed every seeded map. They compare complete ordered map hashes, every tick and projection of four bot matches, and scripted authoritative snapshots/private views against that checkpoint. A re-baseline is a decision about content, never a way to make a refactor pass, and it restarts the evidence: the current fixture proves nothing about code predating it. `tests/fixtures/README.md` records provenance and how to regenerate. Expected results are not regenerated during verification. `npm run check` recursively checks every module in server/shared/public/tests: JavaScript is parsed as Node would load it, and TypeScript is verified to erase cleanly, which is what Node does instead of parsing it. `npm run typecheck` is the separate, stronger pass.

Never regenerate it to make a refactor pass. Separate intentional gameplay changes,
and the new expectations and version decision they require, from behavior-preserving
extraction. `tests/fixtures/README.md` records its provenance and how to audit it.

## Coverage

The tests currently cover deterministic seeded simulation, 200 generated maps, shape records and element stamping, continuous movement and physical gaps, gates and extraction, combat and kit progression, transit, stealth, visibility geometry, privacy projections, one-shot input latching, pacing/replay integrity, spectators, desktop controls, touch controls, mouse aim, client-side sight, shaded occlusion, and projectile interpolation.

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
