# Questions for batch review

No answer is needed to run the prototype. These defaults are assumptions for this isolated experiment, not decisions imposed on the game. Answer by number whenever convenient.

2. **Body scale:** should integration preserve the game's radius ratio of 12/23, or the notes' approximate 0.55/0.90 segment radii? The lab uses the latter, with 1.5-unit squeezes and 2-unit doors. Units are abstract, not meters. This affects clearance calibration; no conversion is assumed.
3. **Shape near exits:** should the diamond's narrow tip remain when several exits share the same corridor? The lab preserves it and permits the rightmost five tiles as exit candidates. Widening/truncating the right side is optional, not an adopted Claude requirement. Staggered columns remain a later experiment.
4. **Placement failure policy:** the original notes place key structural requirements before filling tiles. The live maze-first solver does not implement that ordering. A future composer will try bounded alternate placements/variants for required structures, then fail explicitly. Which structures may be omitted when declared optional remains open; this question does not make the legacy maze authoritative over authored geometry.
5. **Reachability exceptions:** may whole regions be contestant-only, or should all tiles stay hunter-walkable with optional squeeze shortcuts? The lab guarantees walking connectivity for both bodies. Squeeze flanking/value thresholds still need measurement and tuning.
6. **Tier composition:** how should the original diagram combine horizontal tier and vertical bonus? The lab exposes both independently; loot is a placeholder and hazards are absent. Are novelty rewards a separate category? This unlocks content mixes and budgets.
7. **Later 2.5D:** are flat levels with ramps and occasional bespoke multi-height regions enough, or do generic overlapping floors matter? Cells and vertices are flat today. Deliberately deferred until 2D tuning progresses.

## Already clear; no reconfirmation requested

A tier zone is 12 x 6 tiles on a 5 x 5 grid masked to a diamond, and the map is
the tiles those zones cover. Zone dimensions are a tunable parameter; the
appended proposal's continuous noisy tier field is not adopted. Filled material
is the reserved cell class `solid` rather than a separate occupancy axis.

For the experimental macro contract, overlapping cell ownership is rejected and
shared segment declarations must agree. Filler owns only unclaimed cells. These
are reversible composition defaults; layered structure overlays and priority
paint are not implemented. Required-structure conflicts will try bounded
alternate placements, then fail, pending further guidance on optional omission.

6×6 tiles, cell/segment/vertex metadata, compatible tile sets, reusable layouts/set pieces, nonrectangular regions, simple micro generation, GUI plus agent interfaces, and standalone development are established directions. The coarse side-socket editor is an incremental implementation, not a proposed permanent replacement for six segment sockets. Remaining work is in NEXT_TASKS.md.

## Should a hunter be able to reach every tile?

`validateMap` requires that both bodies reach every tile, and generation now
satisfies it by construction: `planStreets` reserves a proven hunter route from
every tile anchor to the street network before any builder runs.

That invariant and the body brief pull against each other. The brief gives a
contestant a diameter under 1.5 segments and a hunter one over it precisely so
that an opening of 1.5 admits one and not the other, and the `rubble` builder
exists to make ground a hunter cannot cross. With the reserved routes in place,
that hostility is pocket-scale: rubble makes contestant-only shortcuts and
hiding places, never a contestant-only part of the map.

The open question is whether that is the wanted shape. The alternative is to
relax the invariant to "a contestant reaches every tile; a hunter reaches every
street and every block", which would let a whole quarter be hunter-hostile
ground and make the asymmetry a macro feature rather than a local one. It is a
one-line change to the validator plus the loss of a guarantee, so it wants a
decision rather than a default. Until then the conservative reading holds.

## How open should the map be?

`STREET_SPACING` in `src/core.ts` is the dial: tiles between one street and the
next, currently 3. Lower is more open ground and smaller blocks to build in;
higher is larger blocks and fewer roads. It was chosen to leave blocks above the
minimum area of the builders that make buildings, not from playtest evidence.
