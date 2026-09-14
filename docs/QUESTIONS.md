# Questions for batch review

No answer is needed to run the prototype. These defaults are assumptions for this isolated experiment, not decisions imposed on the game. Answer by number whenever convenient.

2. **Body scale:** should integration preserve the game's radius ratio of 12/23, or the notes' approximate 0.55/0.90 segment radii? The lab uses the latter, with 1.5-unit squeezes and 2-unit doors. Units are abstract, not meters. This affects clearance calibration; no conversion is assumed.
3. **Shape near exits:** should the diamond's narrow tip remain when several exits share the same corridor? The lab preserves it and permits the rightmost five tiles as exit candidates. Widening/truncating the right side is optional, not an adopted Claude requirement. Staggered columns remain a later experiment.
5. **Placement failure policy:** the original notes place key structural requirements before filling tiles. The live maze-first solver does not implement that ordering. A future composer will try bounded alternate placements/variants for required structures, then fail explicitly. Which structures may be omitted when declared optional remains open; this question does not make the legacy maze authoritative over authored geometry.
6. **Reachability exceptions:** may whole regions be contestant-only, or should all tiles stay hunter-walkable with optional squeeze shortcuts? The lab guarantees walking connectivity for both bodies. Squeeze flanking/value thresholds still need measurement and tuning.
7. **Tier composition:** how should the original diagram combine horizontal tier and vertical bonus? The lab exposes both independently; loot is a placeholder and hazards are absent. Are novelty rewards a separate category? This unlocks content mixes and budgets.
9. **Later 2.5D:** are flat levels with ramps and occasional bespoke multi-height regions enough, or do generic overlapping floors matter? Cells and vertices are flat today. Deliberately deferred until 2D tuning progresses.

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
