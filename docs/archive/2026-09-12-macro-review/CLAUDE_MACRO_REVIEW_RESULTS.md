# Claude macro composition review — results

Status: **COMPLETE**. Independent read-only review of the experimental macro
composer, performed against the task in `docs/CLAUDE_MACRO_REVIEW.md`. No source,
schema, doc, dependency or sibling file was modified; this file is the only
output. Two correctness bugs and one scalability defect are reported, plus four
optional improvements and two schema ambiguities to escalate. No fixes implemented.

Headline: rotation, ownership, order independence, mask handling, filled-cell
navigation exclusion, corridor/ownership-boundary checking and input rejection all
behave as `MACRO_STRUCTURES.md` describes, and I could not break them. The two real
defects are a floating-point exactness bug in shared-segment agreement and an
uncontrolled `TypeError` on one malformed-input shape. The scalability defect is
the one that should worry Codex most, because it sits directly under the bounded
candidate/reroll budget that pass 2 of the stated ordering needs.

## Files reviewed

Archive note (Codex, 2026-09-12): ingested; see DISPOSITION.md in this directory
for fixes, decisions, deferred items and verification. Source references below
refer to the reviewed checkpoint and may have shifted.

Read in full: `AGENTS.md`, `README.md`, `docs/DESIGN_DECISIONS.md` (macro
sections), `docs/NEXT_TASKS.md`, `docs/QUESTIONS.md`, `docs/MACRO_STRUCTURES.md`,
`src/macro-types.ts`, `src/macro.ts`, `src/nav.ts`, `src/geometry.ts`,
`src/types.ts`, `tests/macro.test.ts`. Read in part: `src/core.ts`
(`searchRegions`, `OUTSIDE_CLASS`, `SPAN_EPS`, `GridBuild`, `generateMicro`),
`src/primitives.ts` (`mergeRuns`, `EPS`), `package.json`, `tsconfig.json`.
Not touched: `../astra_test`, GUI/CLI/MCP tooling, artifact/BSON codec paths.

## Validation actually run

| Command                                                                                                           | Result                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `node --test tests/macro.test.ts`                                                                                 | 11 pass, 0 fail (143 ms)                  |
| `npm test` (typecheck + `node --test tests/*.test.ts`)                                                            | typecheck clean; 65 pass, 0 fail (2.88 s) |
| 10 read-only probe scripts run from a scratchpad directory, importing `src/macro.ts` and `src/nav.ts` by file URL | results below                             |

Per the brief I did not rerun `tests/browser.mts` or the 200-seed batch; both
exercise the legacy generator. The brief and `MACRO_STRUCTURES.md` describe "four
acceptance cases" in `tests/macro.test.ts`; the file actually holds 11 tests (4
geometry fixtures plus 7 rejection/invariant tests), which matches the
`NEXT_TASKS.md` wording rather than the other two.

Probe scripts were scratchpad-only and are not left in the repository. Each
finding below carries its reproducer inline so Codex can paste it into a test.

## Correctness bugs

### BUG-1 — shared segment agreement is decided by float bit-equality, so mathematically identical mirrored declarations are rejected

_Severity: medium. Latent with today's aperture vocabulary; reachable the moment
an author or a patch compiler states a non-dyadic span._

`src/macro.ts:111` and `src/macro.ts:119` reverse a span as
`[1 - open[1], 1 - open[0]]` when rotation reverses the world segment's direction.
`spanSame` (`src/macro.ts:122-124`) then compares with `===`, and the conflict
check at `src/macro.ts:286-289` fails composition on any difference.

`1 - x` is not exact in IEEE754 for most decimal fractions
(`1 - 0.8 === 0.19999999999999996`), so two placements that declare _the same
world aperture_ — one of them mirrored — disagree by one ULP and are rejected.

Violated contract, `docs/MACRO_STRUCTURES.md`, "Ownership and composition":
"Shared declarations must agree exactly; contradictory requirements fail instead of
using last-writer precedence", read together with "Rotation reverses spans when
segment direction reverses." Agreement is meant to be agreement about geometry; it
is currently agreement about a float representation. The rest of the codebase is
tolerant about exactly this quantity: `searchRegions`' `clear()` admits a span with
`SPAN_EPS = 1e-9` slack (`src/core.ts:633-636`), `emit` uses `EPS = 1e-9`
(`src/macro.ts:400-407`), and `mergeRuns` uses `EPS = 1e-9`
(`src/primitives.ts:36`). `spanSame` is the only exact comparison in the path.

Reproducer (verified). Two 6x6 halves of a 12x6 field, the right one placed at
180, both declaring the vertical world segment at line 6, offset 2 with the same
open span:

```ts
function mirror(lo: number, hi: number) {
  const src = input(12, 6);
  const left = {
    version: 1 as const,
    id: "L",
    defaultCellClass: "field",
    cells: cells(0, 0, 6, 6),
    segments: [{ axis: "v" as const, x: 6, y: 2, open: [lo, hi] as Span }],
  };
  const right = {
    version: 1 as const,
    id: "R",
    defaultCellClass: "field",
    cells: cells(0, 0, 6, 6),
    segments: [
      { axis: "v" as const, x: 6, y: 3, open: [1 - hi, 1 - lo] as Span },
    ],
  };
  src.placements = [
    { id: "a", structure: left, origin: { x: 0, y: 0 }, orientation: 0 },
    { id: "b", structure: right, origin: { x: 12, y: 6 }, orientation: 180 },
  ];
  return composeMacro(src); // right's span reverses back to [lo, hi]
}
```

Observed:

| span           | result                                                      |
| -------------- | ----------------------------------------------------------- |
| `[0.25, 0.75]` | composes; seam walls `[[2, 2.25], [2.75, 3]]`               |
| `[0.5, 1]`     | composes                                                    |
| `[0.3, 0.8]`   | throws `conflicting declarations for shared segment at 6,2` |
| `[0.1, 0.9]`   | throws (same)                                               |
| `[0.2, 0.6]`   | throws (same)                                               |

Control: the same spans declared by two _same-orientation_ placements (`v:6,2` and
`v:0,2`, origins `(0,0)` and `(6,0)`) compose for `[0.3, 0.8]`, which isolates the
reversal as the cause rather than the agreement rule itself.

Why it is latent today: every aperture the project currently uses is a dyadic
fraction of a cell (a 1.5-unit squeeze across a unit segment is `0.75`, a door is
`0.5`), and `1 - x` is exact for dyadic `x`. The shipped fixture
(`tests/macro.test.ts:180-182`) uses `0.25`/`0.75`, so it cannot see this. The bug
surfaces as soon as a value is a third, a `0.6` gap, or anything derived by
arithmetic rather than authored as a literal — i.e. exactly what pass 2's "compile
any local patches into owned cells and segment declarations" will produce.

Secondary effect, same root cause: emitted wall coordinates drift by ~1e-16
depending on a placement's orientation, so `walls` is not canonical across two
compositions that describe identical geometry. Any future JSON/BSON round-trip or
cross-orientation `deepEqual` test will be sensitive to this.

Test proposal: parameterise a mirrored-seam test over `[0.25, 0.75]`, `[0.3, 0.8]`
and `[1/3, 2/3]`, asserting all three compose with the same seam geometry. Assert
the seam wall spans with a tolerance, not `deepEqual`.

The fix depends on a contract decision — see ESC-1.

### BUG-2 — a falsy non-array `entrances` / `corridors` / `constraints` escapes validation and throws a raw `TypeError`

_Severity: low, but squarely inside the "malformed author input" scope._

The guards at `src/macro.ts:301`, `src/macro.ts:310` and `src/macro.ts:331` are
truthiness-gated (`if (structure.entrances && !Array.isArray(...))`), so a falsy
non-array value skips the check. `named()` at `src/macro.ts:292-300` then runs
`for (const item of items ?? [])`; `0 ?? []` is `0`, which is not iterable.

Violated contract: `docs/CLAUDE_MACRO_REVIEW.md` puts malformed author input in
scope, and every other rejection path in this module raises the `fail()` error
`invalid macro composition: …`. A bare `TypeError` is not an authoring diagnostic
and callers cannot distinguish it from an internal defect.

Reproducer (verified):

```ts
const st = {
  version: 1,
  id: "x",
  defaultCellClass: "field",
  cells: [{ x: 0, y: 0 }],
};
(st as any).entrances = 0; // also reproduces for corridors / constraints
composeMacro({
  ...input(6, 6),
  placements: [
    { id: "p", origin: { x: 0, y: 0 }, orientation: 0, structure: st },
  ],
});
// TypeError: (items ?? []) is not iterable
```

| field         | `= 0`                                          | `= "nope"`                                     |
| ------------- | ---------------------------------------------- | ---------------------------------------------- |
| `segments`    | `fail`: `structure x.segments must be a list`  | `fail`: same                                   |
| `entrances`   | **`TypeError: (items ?? []) is not iterable`** | `fail`: `structure x.entrances must be a list` |
| `corridors`   | **`TypeError`**                                | `fail`                                         |
| `constraints` | **`TypeError`**                                | `fail`                                         |

`segments` is correct because `src/macro.ts:258-260` uses the
`?? []` + `Array.isArray` pattern instead of a truthiness guard. The three
optional-list guards should adopt that same pattern.

Test proposal: extend `tests/macro.test.ts:416` ("rejects invalid versions,
duplicate mask cells and unsafe coordinates") with
`assert.throws(..., /must be a list/)` for each of the four optional list fields
set to `0`, `""` and `false`.

## Scalability defect

### PERF-1 — corridor containment validation is superlinear in footprint size and re-parses the cell set on every sample

_Severity: medium-high for the next milestone. Not a contract violation; it will
block the bounded placement budget described in pass 2._

`inClosure` (`src/macro.ts:125-137`) linear-scans the whole cell `Set` and runs
`entry.split(",").map(Number)` per candidate cell, per query. `segmentInCells`
(`src/macro.ts:140-163`) calls it once per polyline endpoint plus once per
grid-crossing sub-interval. Each corridor polyline segment is then tested **three
times** against large sets: once locally at `src/macro.ts:322`, then against the
world footprint _and_ against the whole mask at `src/macro.ts:467-468`. Cost is
roughly `O(points × crossings × |cells|)` with a string parse at the innermost
level, where `|cells|` is the footprint or the entire mask.

Measured (this machine, Node 24.15, full-mask footprint, corridor radius 0.9):

| mask / footprint                                  | corridor points | `composeMacro` |
| ------------------------------------------------- | --------------- | -------------- |
| 60x30 = 1,800 cells                               | 20              | 61 ms          |
| 120x60 = 7,200 cells                              | 20              | 407 ms         |
| 240x120 = 28,800 cells                            | 20              | 2,851 ms       |
| 366x186 = 68,076 cells (`MAX_WIDTH`/`MAX_HEIGHT`) | 20              | 10,067 ms      |
| 366x186                                           | 40              | 11,812 ms      |
| 366x186                                           | 80              | 14,630 ms      |
| 366x186                                           | 120             | 14,990 ms      |

For scale: the same 366x186 composition with **no** corridor takes 157 ms, and
with one route constraint (which builds a full half-cell lattice) 363 ms. So
essentially the entire cost above is containment checking, not geometry and not
navigation.

Why it matters now rather than later: `docs/MACRO_STRUCTURES.md`, "Pass ordering to
implement next", puts "explicit bounded candidate/reroll budgets" in pass 2 and "On
failure, try a different candidate" in pass 4. A reroll budget multiplies this
number. A ten-candidate budget on a full-size map with reserved corridors is
minutes, not milliseconds, and the CLI batch tooling sweeps seeds.

Fix direction (for Codex; not implemented): the composer already owns dense
`width × height` arrays (`cellOwner`, `cellSolid`, `cellClass`,
`src/macro.ts:186-188`). Containment can be an `O(1)` integer index test against
those instead of a scan over a string-keyed `Set`, which removes both the linear
scan and the per-sample `split`/`Number`. The third pass is also redundant: the
local check at `src/macro.ts:322` and the world footprint check at
`src/macro.ts:467` are the same predicate under an affine bijection, so one of them
can go.

Test proposal: a guard test that composes a 366x186 full-mask structure with a
20-point reserved corridor and asserts it completes inside a generous budget (say
2 s). That is a regression fence, not a benchmark.

## Verified sound — no bug found

These are the areas the brief asked about. I probed each and could not produce a
failure; recording them so Codex does not re-spend the effort.

- **All four cell and segment rotations.** `worldCell` (`src/macro.ts:68-79`)
  rotates a cell as an area and re-addresses it by its minimum corner, while
  segments rotate as vertex pairs (`src/macro.ts:90-121`). I checked the two
  conventions agree algebraically for 0/90/180/270 and confirmed it numerically:
  for an asymmetric 4-cell footprint carrying one vertical and one horizontal
  partial span, the structure's emitted wall set at 90, 180 and 270 is the **exact**
  rotated image of the wall set at 0 (coordinate for coordinate, after mapping
  through the same rotation and translation), and entrance positions match to the
  same precision. `rotated` (`src/macro.ts:51-62`) is genuinely clockwise in screen
  coordinates, as documented.
- **Declared segments stay incident to owned cells under rotation.** For a 4x3
  footprint declaring 24 segments, at every orientation every emitted
  non-perimeter wall borders an owned world cell (0 non-incident).
- **Negative local cell coordinates.** A footprint spanning local
  `[-2,2] × [-2,1]` composes correctly at all four orientations: 4x3 owned cells at
  0/180, 3x4 at 90/270, with the entrance landing on the four expected corners of
  the rotated bounding box, and corridors and constraints evaluating normally.
  `key()`'s `-0` stringification is safe (`${-0} === "0"`), so no key aliasing.
- **Asymmetric spans and the 1.5-cell aperture.** Span reversal is applied only
  when the world segment direction flips, and the fixture's `[0.25, 1]` /
  `[0, 0.75]` pair stays complementary and contiguous under rotation. Exactness
  caveat: BUG-1.
- **Order independence.** With two placements reversed, `walls`, `cellClass`,
  `cellSolid`, `cellOwner` and `regions` are byte-identical. The design is sound:
  all placements are ingested first, the derived-open pass (`src/macro.ts:366-391`)
  runs afterwards, and declarations are applied from a map that rejects
  disagreement rather than taking a last writer (`src/macro.ts:392-398`). Manifest
  array ordering does follow input order — see OPT-3.
- **Overlapping ownership.** Rejected per cell at `src/macro.ts:250-251`, before any
  paint can depend on order, including when the paints agree.
- **Arbitrary and disconnected masks.** A single-cell mask yields 4 walls, 1 region,
  1 nav box. A one-cell hole emits all 4 surrounding walls and one region of 35. A
  mask split by a two-column gap yields two separate regions of the same class
  (30 + 30). A diagonal staircase mask of 3 cells yields 3 separate regions and the
  lattice does **not** leak through the shared vertices: a constraint declared
  `connected: false` at radius 0.4 across the staircase is confirmed disconnected,
  which is the intended fail-closed behaviour.
- **Filled-cell navigation exclusion.** Solid cells are excluded from `navBoxes`
  (`src/macro.ts:444-452`) and from region search (`src/core.ts:644`) while keeping
  their paint class, which matches "a pillar in a plaza is still plaza". The centre
  of a solid cell is not occupiable even at radius 0.1, because it falls in no nav
  box; its perimeter nodes are blocked by the derived walls.
- **Apertures cannot carve derived barriers.** `src/macro.ts:392-397` rejects any
  non-`null` declaration on a segment the derive pass left sealed. Confirmed for
  both causes: a mask-exterior seam (including one reached only after a 180
  rotation) and a solid-cell interface.
- **Corridor reservations at ownership boundaries.** All cases behave per contract:
  clearance spilling into a neighbour's open cells is accepted ("ownership of paint
  is not ownership of clearance"); a centre line lying exactly on an open ownership
  seam is accepted; the same centre line is rejected once the neighbour walls that
  seam, **in either placement order**; a centre line crossing into the neighbour's
  cells is rejected with `leaves the structure footprint`; and a centre line on the
  mask perimeter is rejected. The `segmentInCells` closure test is correct for
  closure semantics — I could not construct a polyline that leaves the footprint yet
  passes the midpoint sampling.
- **Route constraints.** Observed connectivity is compared against the declaration
  and any mismatch rejects (`src/macro.ts:488-491`); blocked endpoints reject before
  the BFS (`src/macro.ts:477-481`); a 0.5-wide aperture correctly reports connected
  at radius 0.2 and rejects a `connected: true` declaration at radius 0.9.
  Endpoints are validated onto the half-cell lattice (`src/macro.ts:343-346`), which
  is what `nodeIndex` requires.
- **Malformed author input** is otherwise well covered: bad `version`, non-integer
  or infinite `width`, empty or duplicated mask, non-array `placements`, string
  `orientation`, a segment with no `open`, an inverted span, a `NaN` corridor radius
  and a non-incident segment all produce explicit `invalid macro composition: …`
  errors. Only the BUG-2 shape escapes.
- **Continuous-completeness caveat respected.** Nothing in `composeMacro` treats a
  sampled disconnection as a proof, and `tests/macro.test.ts:171` explicitly asserts
  no `deadEnds` field is smuggled in.

## Optional improvements

**OPT-1 — walls are emitted strictly inside solid material.** The derive pass opens
nothing between two solid cells, and the emit loops (`src/macro.ts:408-435`) run for
any segment with a mask cell on either side, so a solid block's interior segments
become walls. A 3x3 solid block produces 4 extra merged wall lines entirely inside
material (`x=4` and `x=5` spanning `y 3..6`; `y=4` and `y=5` spanning `x 3..6`).
Geometrically harmless, but they enter `mergeRuns` and every `near()` broadphase
bucket, and they are noise for the migration goal of reconstructing `walls` from
composed primitives. Skipping segments whose both sides are solid is a contained
change.

**OPT-2 — `region.manifest.corridorsHonored` is an unchecked self-report.**
`searchRegions` hard-codes `corridorsHonored: true` (`src/core.ts:675`). In a
composition this is vacuously true, since micro blockers are disabled, but nothing
has checked the macro reservations and `AGENTS.md` is explicit about not treating
generator self-reports as evidence. Worth making it either absent or actually
derived before pass 5 enables micro blockers.

**OPT-3 — input-order artifacts in otherwise order-independent output.** `navBoxes`
is built from `[...mask]` in input insertion order (`src/macro.ts:444`), and
`manifest.placements` / `manifest.constraints` follow placement order. Two inputs
describing an identical map are therefore not `deepEqual` even though all geometry
and region output is identical (verified: reversing `input.mask` changes `navBoxes`
only; reversing `placements` changes `manifest.constraints` only). If order
independence is to be a testable property of the whole composition rather than of
its geometry, canonicalise those three arrays.

**OPT-4 — `span()` is evaluated twice per segment** (`src/macro.ts:101-104` inside
`segmentWorld`, then again at `src/macro.ts:266`), with different diagnostic names,
so the error an author sees depends on which call runs first. Harmless, but the
`src/macro.ts:266` call's `"segment.open"` name is less useful than the
axis-qualified one, and it is the one that fires.

## Escalations — schema ambiguity, not changed here

**ESC-1 — `MACRO_STRUCTURES.md` does not state the precision or the comparison rule
for a segment span.** `Span` is typed as two arbitrary finite reals in `[0,1]`
(`src/types.ts:42`, validated at `src/macro.ts:80-89`); "must agree exactly" is
stated without saying _what_ must agree; and the implementation then applies a
non-exact `1 - x` transform to those reals. BUG-1 cannot be fixed without deciding
one of:

1. spans are compared with a tolerance (the `1e-9` already used by `clear()`,
   `emit` and `mergeRuns`), leaving authored values unconstrained; or
2. spans are quantised on ingest to a stated lattice — halves or quarters of a cell
   would cover every aperture the project currently has (door `0.5`, squeeze `0.75`,
   wide `1`) and would make reversal exact by construction; or
3. spans are stored as exact rationals.

This is a contract decision, so I have not made it. Option 1 is the smallest change
and the most consistent with the surrounding code; option 2 is the one that also
makes wall coordinates canonical across orientations, which the planned JSON/BSON
round-trip tests will want.

**ESC-2 — `MacroComposition` is not sufficient to revalidate itself, which pass 5
requires.** The output carries `version, width, height, walls, cellClass, cellSolid,
cellOwner, navBoxes, regions, entrances, corridors, manifest`
(`src/macro-types.ts:67-85`, confirmed at runtime). It omits three things the stated
pass ordering needs once micro generation changes geometry:

- **the per-segment `segmentOpen` spans.** `searchRegions` takes `segmentOpen` plus
  `segmentIndex` (`src/core.ts:628-636`); the composer builds them locally
  (`src/macro.ts:198-201`) and drops them. A caller holding a `MacroComposition`
  cannot re-run region search without re-deriving spans from `walls`, which is lossy
  in that direction — a merged wall run no longer says which unit segment produced it.
- **`seed`.** Region seeds derive from `input.seed` (`src/macro.ts:453-456`) but the
  seed is not in the output, so region identity cannot be reproduced from the
  composition alone.
- **the constraint definitions.** `manifest.constraints` keeps only
  `{ placementId, id, connected }` (`src/macro-types.ts:83`); `from`, `to` and
  `radius` are discarded. Pass 5 says "revalidate final geometry and actual micro
  manifests", and pass 4 says caches must be invalidated after any geometry change —
  neither is possible for route constraints from the output alone.

Reservations and ownership _are_ preserved, which is what `MACRO_STRUCTURES.md`
promises explicitly, so this is a gap between the output shape and the pass ordering
rather than a broken promise. It is cheapest to settle before the artifact
migration, since these are the same fields a new wire codec would have to carry.

## Suggested next action for Codex

1. **Decide ESC-1**, then fix **BUG-1** under the chosen rule. Smallest correct
   change: give `spanSame` the same `1e-9` tolerance the rest of the module uses, and
   add the mirrored-seam test over a non-dyadic span so the fixture actually covers
   reversal. If you prefer quantisation, state the lattice in `MACRO_STRUCTURES.md`
   in the same commit.
2. **Fix BUG-2** by switching the three optional-list guards at
   `src/macro.ts:301/310/331` to the `?? []` + `Array.isArray` pattern already used
   for `segments`, and extend the rejection test.
3. **Fix PERF-1 before wiring the placement pass.** Replace the `Set`-scanning,
   string-parsing `inClosure` with an `O(1)` lookup against the dense cell arrays and
   drop the redundant third containment pass. Add the 2 s guard test. Do this before
   pass 2's reroll budget exists, not after, or the budget will be tuned around the
   wrong cost.
4. **Then settle ESC-2** as part of planning the versioned library/artifact
   migration, since `segmentOpen`, `seed` and the constraint definitions are the same
   fields the new wire codec has to carry.
5. OPT-1 through OPT-4 are safe to defer; OPT-3 is worth folding in if you want
   whole-composition order independence as an assertable property.

Not in scope and not done here: any fix, any randomized placement pass, and any
judgement about maze tuning or placement success rate. Continuous navigation
completeness remains deliberately unpromised, and nothing in this review treats a
sampled disconnection as a proof of continuous disconnection.
