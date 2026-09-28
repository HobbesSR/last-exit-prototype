# Questions for batch review

No answer is needed to run the prototype. These defaults are assumptions for this isolated experiment, not decisions imposed on the game. Answer by number whenever convenient.

2. **Body scale:** should integration preserve the game's radius ratio of 12/23, or the notes' approximate 0.55/0.90 segment radii? The lab uses the latter, with 1.5-unit squeezes and 2-unit doors. Units are abstract, not meters. This affects clearance calibration; no conversion is assumed.
3. **Shape near exits:** should the diamond's narrow tip remain when several exits share the same corridor? The lab preserves it and permits the rightmost five tiles as exit candidates. Widening/truncating the right side is optional, not an adopted Claude requirement. Staggered columns remain a later experiment.
4. **Optional structure omission:** which structures may a future composer omit when they are declared optional? The planned composer will try bounded alternate placements/variants for required structures, then fail explicitly. This remains open for the future composer; it does not change the game-mode quotas or the playground mode's quota bypass.
5. **Reachability exceptions:** answered 2026-09-27. Everything stays hunter-reachable, and squeezes are shortcuts on top. See "Should a hunter be able to reach every tile?" below. Squeeze flanking/value thresholds still need measurement and tuning.
6. **Tier composition:** how should the original diagram combine horizontal tier and vertical bonus? The lab exposes both independently; loot is a placeholder and hazards are absent. Are novelty rewards a separate category? This unlocks content mixes and budgets.
7. **Later 2.5D:** are flat levels with ramps and occasional bespoke multi-height regions enough, or do generic overlapping floors matter? Cells and vertices are flat today. Deliberately deferred until 2D tuning progresses.
8. **Reachability contract:** open parts of the direction in DESIGN_DECISIONS "Reachability". See "Reachability contract" below.
9. **Saving a map:** should a saved map hold only its layout and regenerate the rest, or keep storing its interiors? See "Saving a map" below. This blocks #70.
10. **Region boundary openings:** open parts of the direction given on #68. See "Region boundary openings" below.

## Already clear; no reconfirmation requested

A game-mode tier zone is 12 x 6 tiles on a 5 x 5 grid masked to a diamond, and
the map is the tiles those zones cover. Playground mode keeps the same diamond
and permits smaller zone dimensions for fast experiments. The appended
proposal's continuous noisy tier field is not adopted. Filled material is the
reserved cell class `solid` rather than a separate occupancy axis; only micro
builders lay it, while tiles paint zones.

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

The question was whether that is the wanted shape, or whether to relax the
invariant to "a contestant reaches every tile; a hunter reaches every street
and every block".

**Answered, Corey, 2026-09-27:** "Everything must be reachable by a hunter so
we are pessimistic about passablility." And: "remember we ignore gaps." So
hunter reachability of everything is the invariant, judged pessimistically:
an opening only a contestant fits through doesn't count toward it. DESIGN_DECISIONS
"Reachability" builds on this.

## Reachability contract

The direction is in DESIGN_DECISIONS "Reachability": tiles state passable
perimeter runs and which of them connect inside the tile, composition is a
union-find, and the open-face rule refuses a placement that seals a component
off (#59). The parts below are open unless marked answered. Each open one has
a working assumption so design can go on.

1. **Who states a tile's groups?** The design could author which passable runs
   connect, or they could be derived from the layout's primitives. Deriving
   works for open ground. A tile whose interior micro fills later has nothing to
   derive from before micro, so stating them keeps them in the layout.
   *Assumption:* stated by the design, derived only where the whole tile is
   open ground. `MacroRouteConstraint` is the likely starting point.
2. **What does "open" guarantee?** **Answered, Corey, 2026-09-27:** "Open is
   a special class of region." "Every cell in the regions formed by open cells
   must be passable as well as every internal segment of those regions.
   Addressing the open regions may ultimately use a decomposer and
   microgenerator that enforces its special requirements, but there is a notion
   that it is a privileged region class." Today's builders break this: #61.
3. **Skeleton first, or the open-face rule alone?** A spanning tree of required
   passable seams could be pinned before WFC, so the fill can add loops but
   never cut it. The open-face rule then only has to catch pockets off the
   skeleton. The rule alone is exact but may backtrack more.
   *Assumption:* the rule alone first, with backtracking measured on the
   sweep, and a skeleton only if that cost is too high.
4. **Non-open interiors: check after, or hold builders to the groups?** Holding
   builders keeps the proof valid through micro, as conform does for ports on
   the planned path. Checking after is simpler but can only reject.
   *Assumption:* hold builders to the groups, and keep the lattice check as
   verification.
5. **Which generator gets it?** The planned path already proves reachability
   at region grain. The contract is written for tile placement (V2). Whether the
   two converge, or one generator is retired, is open. *Assumption:* V2 first;
   the planned path unchanged.
6. **Does an `open` region need a minimum width?** Every cell and internal
   segment passable makes an open region connected on the cell grid, not at
   hunter size. A hunter's diameter is about 1.8 cells, so a one-cell-wide neck
   of `open` cells between walls is all passable cells and segments, and still
   no route. Either an open region is at least the door width (2 cells)
   everywhere it has to carry a route, or it is joined to its neighbours
   generously enough that a neck never matters, or narrow necks are allowed and
   the region splits into groups there. *Assumption:* at least the door width
   everywhere, checked when regions are formed, so "open is one group" holds.
7. **Where does cover go?** `open-field` exists to break long sight lines
   across open ground. If `open` cells can't hold obstacles, that cover has to
   come from elsewhere: other classes placed among open ground (the `tree`,
   `rock`, `rubble` and `hut` classes the library already declares), or
   obstacles confined to the boundary of an open region. *Assumption:* cover
   comes from other classes, and `open-field` stays available to them.

## How open should the map be?

`STREET_SPACING` in `src/core.ts` is the dial: tiles between one street and the
next, currently 3. Lower is more open ground and smaller blocks to build in;
higher is larger blocks and fewer roads. It was chosen to leave blocks above the
minimum area of the builders that make buildings, not from playtest evidence.

## How do fenced set pieces open?

The depot and evac set pieces are a ring of fence tiles. `generate_setpieces.py`
puts the style's gate tile in the middle of every fenced side, so a compound can
be crossed whichever way the map runs past it. Gates on only two sides were not
enough: a 6×6 or 3×6 compound can fill the diamond's six-row tip and cut the
start or the exit off from the rest of the map.

That is a reversible default that restores the gates `30e4df7` dropped when it
templated every perimeter as corners plus edges. The open part is the
edge-constraint work in progress when they were lost. The gate tiles' `S` edge
requires depot or evac cells inside, and depot and evac pieces have no interior
set, so WFC fills the interior with fence, corner and gate tiles. Over 30 seeds
that costs 17 retried attempts against 10 with the gate edges removed; no seed
fails either way. Corey chose to restore the gates now because doing so does not
block that work, and to let the edge-constraint work decide what a gate is and
what fills a compound.

## Saving a map

Under DESIGN_DECISIONS "The generation chain", one seed decides the whole map,
and re-running micro on a saved layout reproduces its interiors (checked
2026-09-27; pinned by #66). So the interiors in today's artifact are a copy of
something that can be regenerated. Either way the artifact will record an
engine version, a constant bumped whenever generator output changes (#70).

- **Layout only.** The artifact is the layout. Interiors are regenerated on
  read, and an artifact from another engine version is refused by name. It's
  smaller, and it can't disagree with the engine, but an old save stops
  loading once the builders change.
- **Layout and interiors (today).** A save keeps loading across engine
  changes and shows what was generated then. Reading one from another engine
  version reports the difference.
- **Both.** Interiors are optional: stored when the save has to outlive the
  engine, such as a map shipped to the game, and left out otherwise.

*Assumption:* keep storing interiors, and add the engine version, until this
is answered.

## Region boundary openings

**Answered in part, Corey, 2026-09-27 (on #68):** "We may require tile makers
to declare passable segments between cells of different regions, i.e. on the
perimiter of regions. It's the tile designer's job to mark internal as
passable. For convenience, we may make perimeter segments default to passable
with explicit nonpassable indicators." And: "just because something isn't
marked passable doesn't mean it won't be passable. It just means we can prove
its passable." And builders honour only passable: "I'd prefer them to honor
passable than try to honor multiple objectives." A nonpassable directive is
deferred. DESIGN_DECISIONS "The generation chain" records the rule. These parts are open, each with a working
assumption:

1. **Where the marks live.** Inside a tile, between cells of different
   classes, is clear. At a seam between tiles, a region perimeter is also a
   seam, and seam contracts already state spans there. *Assumption:* a seam
   contract's open span counts as marked passable, so the two don't need
   separate marks.
2. **How wide "passable" is.** **Answered, Corey, 2026-09-27:** "passable
   segments must all be part of a chain of perimeter segments on the region
   large enough to be passable for hunters." A shorter run makes the layout
   invalid. Still open: whether a run may continue across a tile seam, since
   a region can span tiles. *Assumption:* yes. The check runs on the layout's
   regions, where a run may cross seams. A design is also refused up front
   when a run lies wholly inside one tile, doesn't reach the tile's edge, and
   is too short, because no neighbour can lengthen it.
3. **Which region writes a shared segment.** Two regions meet along every
   perimeter segment. If both builders could write it, the result would
   depend on build order again, which #68 removes. This is write scope, not
   another objective: a builder still honours only passable. *Assumption:*
   each unmarked shared segment is written by at most one of the two regions,
   chosen in the region inputs. A class that encloses, as `courtyard` walls
   its border, gets its perimeter. Otherwise the lower region index gets it.
   The other region takes it as given.
4. **The shipped library.** Today most inter-class segments are unmarked
   (`any`), and a builder's openings are whatever the grid shows when its turn
   comes. After #68 they end up open unless the region that writes them
   builds something there, so the built maps may get more open. Nothing in
   them is proven yet, because nothing is marked. *Assumption:* #68 measures
   the change on the sweep and on bounded batches. Designs mark passable
   where connectivity must be guaranteed. Where the map gets too open, the
   answer is designs or builders that draw more geometry, not a nonpassable
   directive. Design edits are reported separately from the code change.
