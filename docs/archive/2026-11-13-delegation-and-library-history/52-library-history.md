# 52 library history, as of 2026-11-13

Moved verbatim from [52](../../52-map-primitives-and-library.md) (#1051): the S5 footprint narrative and the #241/#243/#298 and #214 tracing of the former `last_exit_map` library.

### The old footprints (S5)

The old library's set pieces ("The old library", below; recovered from
`141dece^:map/macro/content/default-library.json`) come back with their slot
arrangements and their placement rules and quotas unchanged (Corey,
2026-09-28: "the same distribution as before"). Each old area takes its
region type from 54's "Today's names":

- `market` pieces become `market`, except one medium piece, which became
  `hall` so the library paints it.
- `industrial` pieces become `plant` for the works and `depot` for the sheds
  and yards.
- `military` pieces become `compound` for the walled bases and `checkpoint` for
  the choke, a passage between two fence lines.
- `landing` pieces outside `start` can't be `arrival`, a core element class
  (51, "Core elements"). They were plain clearings, so they become `block`
  (the enormous one), `park`, `cover`, `ruins` and `rubble`.

The old designs were rings of fence and gate tiles around an unclaimed
middle. They are filled here: the builders now draw enclosures themselves
(`compound`'s ring, `depot`'s walls), and a ring one tile wide is below every
structure type's shape needs. So the footprints are larger than the old
ones. The S5 footprint coverage sample is in [42.3](../../42.3-generation-and-delegation-evidence.md#s5-footprint-coverage-sample).

Every non-`open` type rolls loot, so the default loot gradient was scaled to
keep loot per map level (14).

### From "The old library"

Inspection for #241/#243/#298 also traced the former `last_exit_map` library
(at `141dece^`) for rotated partial regions and selected fence, corner and gate
tiles. Those shapes show a useful way to compose irregular regions without
forcing openings along every side. This pass adopts selective guaranteed
openings and deferred/hinted perimeter segments; it retains the current
three-cell tile grid, shapes and weights. The #214 follow-up adds rotated rubble
bands and bends, a centered courtyard feature, and deliberately larger building
fill areas within selected structure set pieces. The bounded #214 fill composition and portal diagnosis sample is in [42.3](../../42.3-generation-and-delegation-evidence.md#fill-composition-214-sample).
