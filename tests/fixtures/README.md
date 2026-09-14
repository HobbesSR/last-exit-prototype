# Frozen behavior baseline

`behavior-elements-1.json.gz` contains SHA-256 hashes of complete JSON maps
(including property/array order), 100-tick digest blocks over every snapshot and
contestant/gladiator/directed projection in four complete bot matches, and full
scripted snapshots/projections. The scripted cases exercise input latching,
equipment merging/use/drop/pickup, charge interruption/completion, occupied doors,
PvP, death/respawn, abilities, transit, extraction and match completion. JSON
serialization is the wire boundary.

Tests only read this fixture. Do not regenerate it to accommodate refactor
changes: a behaviour-preserving change must reproduce it exactly. Regenerating is
only correct for a deliberate content or rules change that has been decided, and
it costs the continuity below, so it is a decision rather than a step.

## Provenance

`elements-1` replaced `5dd7d61` when the element catalogue landed: block corners
began drawing structures from per-region template sets (hut, lodge, warehouse,
ruin, compound) instead of stamping one hardcoded building, which changes every
seeded map and therefore every map-dependent trace. The superseded
`behavior-5dd7d61.json.gz` remains in git history at the commits that carried it.

`5dd7d61` had been captured before any gameplay extraction and survived several
refactors unchanged, which is what made it evidence that those refactors were
behaviour-preserving. `elements-1` starts that evidence over: it proves nothing
about the code that predates it. Treat it the way `5dd7d61` was treated.

To regenerate after a decided content change, build `{ checkpoint, maps, bots,
scripted }` from `tests/characterization-scenarios.js` — `mapHashes()`, one
`botTrace(seed)` per exported seed, and `JSON.parse(JSON.stringify(scriptedTrace()))`
— gzip it, and name it for the new checkpoint. There is deliberately no script in
the repository for this. To audit a fixture's provenance, run the scenario module
in an isolated checkout of its checkpoint and compare the decompressed JSON.
