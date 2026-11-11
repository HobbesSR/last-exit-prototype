# Frozen behavior baseline

## Physics behavior baseline (#920)

`behavior-physics-1.v8.gz` is the frozen characterization fixture. It freezes what the live engine does: `content-7` matches under
`last-exit-0.8-physics`, built by `createPhysicsGame`. It is `v8.serialize` of
`{ checkpoint, version, content, arenas, bots, scripted }`, gzipped, because each arena keeps the
portal graph bots plan with, and the graph holds typed arrays that JSON drops.

- `arenas` — seeds 9 and 4217's chain maps at the default live size (12 × 6), each
  `{ map, graph }`, stored so generation moving on never moves the traces.
- `bots` — 100-tick digest blocks over every snapshot (the private `physics` state included)
  and the `c0`, `g0` and directed projections of each seed's whole bot match: 3,557 ticks for
  seed 9 and 3,103 for seed 4217.
- `scripted` — 20 labelled snapshots, each with four projections, from a scene on seed 4217's
  arena: two queued inputs, carried instances merged and used, a physical drop and its automatic
  pickup, charging, a cancel and a full charge, a door opened, refused while occupied and closed,
  a contestant and a gladiator killed, a respawn, a hook pull, a hunter's ability and melee,
  transit, extraction and completion. Loot and traps are cleared and every other player stands
  still, so only the script acts. Each label was checked once by hand to do what it says.

`tests/characterization-physics.test.js` checks the version and content and replays the scripted
trace (1.3 s); `tests/slow/characterization-physics-bots.test.js` replays the bot matches
(31 s). Both run from `tests/characterization-physics-scenarios.js`.

Captured at `69561ae` (main after #921), whose simulation, physics and map code the
capturing branch left unchanged. Gzip SHA-256
`088ef3ca6f3e2b76b661f381d9813d658a24e714addbdcf14ba3551df6e03891`; the SHA-256 of
`JSON.stringify(scripted)` is `86795393e104d9b57311ec1dd0543728ef5380d2a82392145b970d2776204e80`.
The capture ran on freshly generated arenas; the tests, in other processes and from the
deserialized arenas, reproduce every digest, and each trace repeated within one process too.

Tests only read this fixture. Do not regenerate it to accommodate refactor changes: a
behaviour-preserving change reproduces it exactly. A recapture belongs to a decided rules, content,
recorded-state or wire change, is named for its new checkpoint, and costs the continuity of the
evidence, so it is a decision rather than a step. Such changes wait in the open "Physics recapture
batch" issue and land together with one recapture ([31](../../docs/31-verification.md#the-frozen-fixture)). A physics rules version change is one: the fast
test fails on the stored `version` first. Because the fixture carries its own arenas, a change to
generation alone never moves the traces. To recapture, build the object
above from the scenario module: `traceArenas()` (or the previous fixture's `arenas`, carried
forward unless the arenas themselves are meant to change), one `await botTrace(seed, arenas[seed])`
per exported seed, and `JSON.parse(JSON.stringify(await scriptedTrace(arenas[4217])))`, with
`version: PHYSICS_VERSION` and `content: CONTENT`; serialize, gzip and record the new digests
here. To audit, deserialize it in an isolated checkout of its checkpoint and compare.

## Pregenerated room arena (#849)

`room-arena-9.v8.gz` is seed 9's live map at 12 × 6 with the shipped content, and its portal graph,
as `v8.serialize({ map, graph })` gzipped (the graph holds typed arrays). Room and networking tests
play on it through `generatedMap(9)` (`tests/helpers/room-harness.js`) instead of building a map
(31, "Test arenas"). It is not a behaviour baseline: `tests/slow/room-arena.test.js` fails when it
is no longer seed 9's map, and the change that moved the map recaptures it with
`node tools/room-arena.mjs` (`--check` compares without writing). Last recaptured for the
sparse-sides and lighting batch (#895, `types-67`). It was captured with the legacy content; #920 moved
the tool to the shipped content, which gives the same map and graph, so the file was not recaptured.

## Focused compound siting input (#340)

`compound-340-brief.json.gz` is a separate diagnostic input, not a behavior
baseline. It captures the exact `compound@336,342` brief from
`generate('issue330-before-36x18', {mode:'game', zoneWidth:36, zoneHeight:18})`
at `c8c87b1d9adbc045e4d51a6a88a9c6ef048a0451`, `types-25`.
The SHA-256 of `JSON.stringify(brief)` is
`ea08497ff53070560aed9c5d50f25d270d95cbee30f879fddbd5ea3e66d513b2`.
It preserves original cells, portals, internal guarantees, fill/clear context,
zones, seed and hints. The focused test reads it to avoid building the full map.
`node tools/compound-siting-audit.mjs --out=test-results/340-audit` regenerates
the source map independently and writes the exact input, emitted result, reason
trace and collision/access SVG. See [42](../../docs/42-performance-history.md)
for the conclusion and limitations. After the correction, the command's default
regeneration audits current ring output; supply `--brief=tests/fixtures/compound-340-brief.json.gz`
to inspect the original constrained input. The frozen fixture below is unchanged.

`compound-340-inward-brief.json.gz` captures the corrected same-seed region after
the 312 `military-quarter` compound slots adopt the existing inward variants.
It preserves the original ID, seed, ownership, portals, zones and hints; internal
guarantees deliberately change from 586 to zero, allowing 10,856 fill cells.
Its serialized-brief SHA-256 is
`11ceb74f7a3bf42a59417d14a6b92ce60a87498a33467d7dd560663a8ef5a531`.
The corrected resolved library fingerprint is `a79cd8c355545bfc`. A fresh full
generation is compared exactly to this witness by
`node tools/compound-siting-solution-audit.mjs --out=test-results/340-solution`.
The original witness above is retained unchanged; this second input represents
a deliberate authored-content correction under the same `types-25` builders,
macro version 3 and library format version 3. See [53](../../docs/53-map-artifacts-and-tools.md)
for the final committed input/baseline provenance.

## Inherited nonfill strip input (#330, stored for #230)

`compound-330-strip-brief.json.gz` is the `compound@252,36` brief from
`generate('issue330-before-12x6', { mode: 'game', zoneWidth: 12, zoneHeight: 6 })`
(`map/chain.ts`), captured at `872d772`, before #230 raised the charger quota to three and moved
that map's layout. The SHA-256 of `JSON.stringify(brief)` is
`cf5b3245fc559d213b214e78b60fd53af549807e611cf7249c0b83cd917d5da3`. The focused test in
`tests/micro-compound-delegation.test.js` reads it, so the measured compound stays measured whatever
later content does to the generated map.

## Retired: the legacy mover's baseline (#920)

`behavior-seat-1.json.gz` froze the legacy mover (`content-1` under `last-exit-0.7`) and, in its
`generated` hashes, the legacy street generator. #920 retired that engine and its content, and the
fixture with them; `behavior-physics-1` above replaced it. It remains in git history, last at
`03af19a`, with gzip SHA-256
`a4a6856b4bb082f92ee8ee64a6bdc5273fc2384ed28f0e38684460b6c242d488`. Its chain was `5dd7d61`
(captured at `0cd204e`) → `elements-1` (`9fe2d94`) → the stored-arenas split (`aa833a6`) →
hash-only cover update (`dede8fe`) → `netcode-1` (`95b7f1b`) → `nav-1` (`fa6c143`) → `seat-1`
(#792). Its idea carries over: a fixture stores the arenas its traces ran in, so the traces move
only when the simulation does. To audit it, run that checkout's `tests/characterization-scenarios.js`.

## Compound yard review input (#647 / #657)

`compound-647-review-brief.json.gz` is the unchanged input for
`compound@180,294` from `issue330-before-36x18` in
`docs/reports/issue-647/compound-cords.json.gz` (content source
`3d4106fff2ed12240b9741f3d7fc46343079f269`). Extracted during review 498 to pin
an irregular production yard: the original `compound-yard-2` transferred 180
cells; the first PR's extent-relative `compound-yard-3` selected none. The
review regression requires actual ownership transfer, preserved ring/court,
actual gate access and final owner/whole geometry, rather than counting offers.
This is an input fixture, not a replacement characterization baseline.
Gzip bytes use mtime 0; SHA-256
`d4a1f8de12220f0de815047a0b0a2a69a5c327c56ba824e96b1bb227fdec0bf4`.


## Route-start enumeration inputs (#722)

`route-start-cases.json` contains 129 inputs captured at the #716 prototype
checkpoint `b051565`: the first portal stand from each of 121 frozen direct
depot/market briefs, plus eight off-grid variants (offsets -0.33 and +0.27
cell sizes on both axes for the first four inputs). The frozen corpus SHA-256
is `b90b15079f1396798217462c7782a08a6d15f527838f5e8dd4f52f2d970ce9bb`.
The fixture was moved byte-identically from the #722 report; file SHA-256 is
`0b984291f9eb3ab9e543b7076f370d1c43f6569c2ec7c90b6bce1e5894171d46`.
The direct helper test and enumeration-only benchmark share these inputs;
the test compares against an independent whole-grid reference. This is an
input fixture, not the frozen gameplay characterization baseline. Measurement
scope and the pinned historical runner are documented in
[the report](../../docs/reports/issue-722/README.md).

## Hinted structural hall wing (#533)

`hall-wing-hinted.json.gz` retains the exact `hall@306,72` input from the
revised 12x6 `issue330-before-12x6` authored library, also retained in the hall
comparison report. A two-cell secondary perimeter inset left a physically open
lane beside a hinted wall that the half-cell hunter route grid could not follow.
The regression checks the actual previously reachable stand against final
geometry; a bay with no safe pillar fit stays reserved. This is an input fixture,
not the frozen gameplay characterization baseline. Gzip uses mtime 0; SHA-256
`c0aeef58a9e5866b1ee1826bd1611a7f970a2ac9f09ed7cb03d127c065d69877`.

## Saved park briefs (#688, #922)

`park-pocket-briefs.json.gz` holds the two park briefs `tests/micro-park-pocket.test.js` builds:
`park@372,150` from `docs/reports/issue-688/size-24-1.json.gz` and `park@144,36` from
`size-12-1.json.gz`, with the latter's saved (empty) elements. Those saved maps embed a library
under the retired either-side rules, which the reader now refuses (#922), so the briefs were read
with `d127833`'s reader and stored as builder inputs; they stay valid when macro moves on. Gzip
uses mtime 0; SHA-256 `ad7329fab37b02e5d5b27a2853969cf72fb190b51832c15dd7dd9ed699adaaf6`.

## Larger-size briefs (#821)

`large-briefs.json.gz` holds the briefs only the larger authored sizes hand a builder, for
`tests/slow/micro-large-briefs.test.js`. `node tools/large-briefs.mjs` writes it, running macro
alone (no builds): for each region type and each axis (portal count, owned cells), the largest
brief over seeds `size-24-1` to `-5` and `size-36-1` to `-5` of the game-mode 24 × 12 and 36 × 18
libraries is kept when it exceeds the largest that type gets in the full sweep's `sweep-1` to
`sweep-120` game maps; a brief that wins both is kept once. Each entry records its seed and both
values. Recaptured for the sparse-sides libraries (#851, #895, `common-primitives@7`) at
`84d2553`: 14 briefs over 12 types, up to 46 portals (rubble) and 12,384 cells (compound). Gzip
uses mtime 0; SHA-256 `dff6bbbb0d466d12a798ebbedba72e0a2a0ce130b0b0e5ca95e73bca40be5b51`. Park's
brief is checked in `tests/slow/micro-large-briefs-park.test.js`. The previous captures: `f8c7633`
for placement's reachability lookahead (#857), 13 briefs over 12 types, up to 88 portals (market)
and 11,484 cells (market); `e5058c8` for the matched libraries (#849, `common-primitives@6`, with the placement stall limit),
13 briefs over 12 types, up to 87 portals (park); `cbf302d` for `common-primitives@5`, 15 briefs
over 13 types.

These are builder inputs, so they stay valid when macro moves on. Recapture them in the content
change that moves the larger sizes' briefs, so they keep standing for what those sizes produce;
a builder change never recaptures them. The sweep's `macro-*` entries pin seeds `size-24-1`,
`-2` and `size-36-1`, `-2`, the first two of the five the tool reads, so a moved `briefs` hash
there is the usual sign; it is not a witness for seeds 3 to 5. `node tools/large-briefs.mjs
--check` is: it reselects from all ten and exits 1 when the stored briefs differ (about 90 s).
Run it in any content change that moves macro.
