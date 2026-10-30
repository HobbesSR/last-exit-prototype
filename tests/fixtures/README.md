# Frozen behavior baseline

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

## Behavior baseline contents

`behavior-nav-1.json.gz` holds two independent things, and that separation is
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
and by `slow/bot-objective.test.js`, which routes bots to completion over generated maps.

The scripted cases exercise the input queue, equipment merging/use/drop/pickup,
charge interruption/completion, occupied doors, PvP, death/respawn, abilities,
transit, extraction and match completion. JSON serialization is the wire boundary.

Tests only read this fixture. Do not regenerate it to accommodate refactor
changes: a behaviour-preserving change must reproduce it exactly. Regenerating is
only correct for a deliberate content or rules change that has been decided, and
it costs the continuity below, so it is a decision rather than a step.

## Provenance

`nav-1` replaced `netcode-1` when route ends stopped snapping across walls thinner than a
tile (#351). It was captured at `5e83119`, against `content-1` and the stored arenas. `generated` and
`maps` were carried forward. Of the traces, only the bot trace for seed 4217 moved: the other three
bot traces and the scripted trace were recomputed on that tree and are byte-identical to
`netcode-1`'s. The superseded `behavior-netcode-1.json.gz` remains in git history.

`netcode-1` replaced `elements-1` when input handling and bot routing changed: a tick now spends
exactly one queued input instead of coalescing whatever arrived, and a grid route is straightened
before a bot walks it. Both move what the simulation does, so both move the traces. Neither touches
the generator, and that was checked rather than assumed — `generated` carried forward unchanged, and
so did `maps`.

`netcode-1` was the `95b7f1b` checkpoint; the current fixture is `nav-1`, captured
from simulation tree `5e83119` and introduced in commit `fa6c143`. Its full historical chain is
`5dd7d61` (captured at `0cd204e`) → `elements-1` (`9fe2d94`) → the stored-arenas
split (`aa833a6`) → hash-only cover update (`dede8fe`) → `netcode-1` → `nav-1`.
The historical fixture names remain in git history;
the current tests select legacy `content-1` through `contentById` under rules version
`last-exit-0.7`, so the default `content-2` does not rewrite this evidence.

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
`tests/characterization-scenarios.js` using an explicitly selected content set
obtained through `contentById`: `mapHashes()`, `traceMaps()`, one
`botTrace(seed, maps[seed], content)` per exported seed, and
`JSON.parse(JSON.stringify(scriptedTrace(maps[4217], content)))` — gzip it,
and name it for the new checkpoint.

To audit the existing `nav-1` fixture on this tree, select `content-1` and use
its stored maps, never today's default content or freshly generated arenas.
The three-hunter checkpoint preserved the then-current `behavior-netcode-1.json.gz`
bytes (present at `95b7f1b` and `5e83119`), SHA-256
`b8734d7cbf1292f8e5fad5c5f7007ed368bc33fc7d82b5965b23d71303a48ea2`.
The current `behavior-nav-1.json.gz`, introduced at `fa6c143`, has gzip SHA-256
`708222c5e226019b2d601e4574f2d83c3832ed1b0cb09827bc5e9866e83ed7c8`.
`nav-1` changed the seed-4217 bot trace when route ends stopped snapping across
walls thinner than a tile (#351); generated hashes, stored arenas, other bot traces
and the scripted trace carried forward byte-identical.

Carry `maps` over from the previous fixture unless the arenas themselves are meant to
change: regenerating them folds whatever the generator has done since into a change
that was supposed to be about the simulation. A pure content change needs only
`generated` replaced; rebuild the traces only when they are meant to move. There is
deliberately no script in the repository for this. To audit a fixture's provenance, run the scenario module
in an isolated checkout of its checkpoint and compare the decompressed JSON.


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


## Hinted structural hall wing (#533)

`hall-wing-hinted.json.gz` retains the exact `hall@306,72` input from the
revised 12x6 `issue330-before-12x6` authored library, also retained in the hall
comparison report. A two-cell secondary perimeter inset left a physically open
lane beside a hinted wall that the half-cell hunter route grid could not follow.
The regression checks the actual previously reachable stand against final
geometry; a bay with no safe pillar fit stays reserved. This is an input fixture,
not the frozen gameplay characterization baseline. Gzip uses mtime 0; SHA-256
`c0aeef58a9e5866b1ee1826bd1611a7f970a2ac9f09ed7cb03d127c065d69877`.
