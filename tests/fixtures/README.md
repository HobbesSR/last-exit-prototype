# Frozen behavior baseline

`behavior-netcode-1.json.gz` holds two independent things, and that separation is
the point of its shape:

- `generated` — SHA-256 hashes of complete JSON maps, property and array order
  included. This characterizes the **generator**, and a deliberate content change
  re-baselines it alone.
- `maps`, `bots`, `scripted` — the four arenas the traces ran in, stored verbatim,
  plus 100-tick digest blocks over every snapshot and contestant/gladiator/directed
  projection in four complete bot matches and full scripted snapshots/projections.
  These characterize the **simulation**. Because the fixture carries its own maps,
  they keep their meaning when content changes: the traces only move if the
  simulation moves.

Before the split, every trace ran on a freshly generated map, so any content change
invalidated all of them at once and the evidence that the simulation was unchanged
was destroyed along with it. Map diversity is still covered — by `generated` here,
and by `playability.test.js`, which routes bots to completion over generated maps.

The scripted cases exercise the input queue, equipment merging/use/drop/pickup,
charge interruption/completion, occupied doors, PvP, death/respawn, abilities,
transit, extraction and match completion. JSON serialization is the wire boundary.

Tests only read this fixture. Do not regenerate it to accommodate refactor
changes: a behaviour-preserving change must reproduce it exactly. Regenerating is
only correct for a deliberate content or rules change that has been decided, and
it costs the continuity below, so it is a decision rather than a step.

## Provenance

`netcode-1` replaced `elements-1` when input handling and bot routing changed: a tick now spends
exactly one queued input instead of coalescing whatever arrived, and a grid route is straightened
before a bot walks it. Both move what the simulation does, so both move the traces. Neither touches
the generator, and that was checked rather than assumed — `generated` carried forward unchanged, and
so did `maps`.

Carrying `maps` forward matters more than it looks. Those arenas already predated `elements-1`'s
`generated` hashes, because an earlier pure-content change replaced those hashes alone, as the rule
above allows. Recapturing the arenas here would have folded that content change into this one and
destroyed the evidence that only the simulation moved. The traces are therefore directly comparable
to `elements-1`: same arenas, same scenarios, different simulation. The superseded
`behavior-elements-1.json.gz` remains in git history at the commits that carried it.

The scripted `latched-merge-and-use` capture is gone, replaced by `queued-first-spent` and
`queued-second-spent`. It characterized the merge that a queue removes, so there was nothing left for
it to describe.

`elements-1` replaced `5dd7d61` when the element catalogue landed: block corners
began drawing structures from per-region template sets (hut, lodge, warehouse,
ruin, compound) instead of stamping one hardcoded building, which changes every
seeded map and therefore every map-dependent trace. The superseded
`behavior-5dd7d61.json.gz` remains in git history at the commits that carried it.

`5dd7d61` had been captured before any gameplay extraction and survived several
refactors unchanged, which is what made it evidence that those refactors were
behaviour-preserving. `elements-1` starts that evidence over: it proves nothing
about the code that predates it. Each checkpoint is treated the way `5dd7d61` was.

To regenerate after a decided change, build
`{ checkpoint, generated, maps, bots, scripted }` from
`tests/characterization-scenarios.js`: `mapHashes()`, `traceMaps()`, one
`botTrace(seed, maps[seed])` per exported seed, and
`JSON.parse(JSON.stringify(scriptedTrace(maps[4217])))` — gzip it, and name it for
the new checkpoint.

Carry `maps` over from the previous fixture unless the arenas themselves are meant to
change: regenerating them folds whatever the generator has done since into a change
that was supposed to be about the simulation. A pure content change needs only
`generated` replaced; rebuild the traces only when they are meant to move. There is
deliberately no script in the repository for this. To audit a fixture's provenance, run the scenario module
in an isolated checkout of its checkpoint and compare the decompressed JSON.
