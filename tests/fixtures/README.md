# Frozen behavior baseline

`behavior-5dd7d61.json.gz` was generated before any gameplay extraction, using
the tracked source at `5dd7d61` and `tests/characterization-scenarios.js`.
It contains SHA-256 hashes of complete JSON maps (including property/array order),
100-tick digest blocks over every snapshot and contestant/gladiator/directed
projection in four complete bot matches, and full scripted snapshots/projections.
The scripted cases exercise input latching, equipment merging/use/drop/pickup,
charge interruption/completion, occupied doors, PvP, death/respawn, abilities,
transit, extraction and match completion. JSON serialization is the wire boundary.

Tests only read this fixture. Do not regenerate it to accommodate refactor changes.
To audit its provenance, run the scenario module in an isolated checkout of
`5dd7d61` and compare the decompressed JSON; gameplay files must be unchanged.
