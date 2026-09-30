# Claude result: shared macro geometry revalidation

Status: COMPLETE.

Archive note: Codex reviewed and accepted this implementation. See DISPOSITION.md
alongside this file. Timings below are historical observations, not requirements.

`checkMacroRoutes` is implemented as the single recheck of retained corridors
and route constraints against a composition's current walls. `composeMacro` now
calls it once instead of checking inline, and copies the returned counts and
observations into the initial manifest. No second implementation of these checks
remains.

## Changed files

- `src/macro-types.ts` — added the `MacroRouteCheck` interface exactly as
  specified in the brief, with comments recording that `connected` is a sampled
  observation and that a partly blocked corridor is not counted.
- `src/macro.ts` — imports `clearNavCache`; adds `WALL_FIELDS` and the exported
  `checkMacroRoutes`; `composeMacro`'s trailing corridor and constraint loops are
  replaced by one call to the helper.
- `tests/macro.test.ts` — added the `revalidationInput` fixture and six
  `checkMacroRoutes:` tests. No existing test was changed except the import line.
- `docs/CLAUDE_MACRO_REVALIDATION_RESULTS.md` — this file.

Nothing else was edited. `src/nav.ts`, `src/core.ts`, the sibling, GUI/CLI/MCP,
legacy artifacts, dependencies, and the task/handoff/structure docs are
untouched. No agents were spawned and no packages were added.

## Behavior as implemented

1. `clearNavCache(map)` is the first statement, before any validation or early
   return, so every path — including a rejected wall list — leaves no stale wall
   index or lattice behind.
2. Walls are validated before any navigation call: each record must be an object
   and each of `x1,y1,x2,y2` a finite number. Errors are returned; nothing
   non-finite reaches `segmentClear`/`pointClear`, where a NaN distance would
   compare as clear. Two cheap list guards (`corridors`, `constraints`) reject a
   mangled container instead of throwing a `TypeError`. This is not an
   arbitrary-JSON validator: source fields, ownership, dimensions, `navBoxes`
   and the retained definitions are assumed unchanged and are never re-derived.
3. Every retained corridor segment is rechecked with the shared `segmentClear`.
   Local centre-line ownership containment is not rescanned. Every corridor is
   checked, every failing segment produces a `placementId/id` + segment-index
   error, and a corridor increments `corridorsChecked` only if all its segments
   pass.
4. Every retained constraint requires both endpoints `occupiable` at its defined
   radius first. A blocked endpoint records an error and omits that constraint's
   observation entirely, so it can never read as a successful requested cut.
   Otherwise the observation is computed with the existing `reachable` /
   `nodeIndex` at that radius and is recorded even when it disagrees with the
   declaration; the disagreement itself is an additional error.
5. `valid` is `errors.length === 0`. Walls, definitions, corridors, regions,
   `segmentOpen` and any prior manifest are never read as evidence and never
   modified. Each call returns a freshly allocated report with freshly allocated
   observation objects.
6. `composeMacro` calls the helper once on the composed map, and on
   `!report.valid` raises its existing authoring error via `fail`, joining the
   collected errors with `"; "` so the prefix stays
   `invalid macro composition: ...`. It then sets `manifest.corridorsChecked`
   and assigns `manifest.constraints` from **copies** of the report's entries, so
   the manifest and the report never share objects.
7. No region regeneration, no reconstruction from `seed`/`segmentOpen`, and no
   change to the 1e-9 tick precision, ownership or mask behavior.

## Contract points worth confirming, none of which changed the contract

- **Mismatch is an error.** The brief says to record an observation that
  disagrees with the desired connectivity, but only "return valid only if no
  errors" fixes the rejection. I made disagreement produce an error _and_ record
  the observation, because `composeMacro` must keep rejecting a failed
  requirement (its existing `/connectivity/` regression asserts this). If a later
  post-edit caller should instead treat disagreement as reportable-but-valid,
  that is a contract change and needs a new field rather than a silent
  relaxation.
- **Error strings changed.** Messages are now `placementId/id`-qualified, as the
  brief asked for useful placement/id errors. The corridor message moved from
  `corridor <id> is not clear in the composed map` to
  `corridor <placementId>/<id> segment <n> is not clear in the current geometry`.
  The constraint messages keep their wording after the new prefix, so the
  existing `/connectivity/` assertion still matches.
- **The report's `constraints` can be shorter than `map.constraints`** when an
  endpoint is blocked. For a map returned by `composeMacro` the two are always
  1:1, because a blocked endpoint rejects the composition.
- **Docs to update on ingestion (not owned by this task).**
  `docs/MACRO_STRUCTURES.md` still says "The helper is not implemented at this
  checkpoint", and `MODEL_HANDOFF.md` / `docs/NEXT_TASKS.md` still list this as
  active delegation. All three are Codex's to archive and update.

## Commands actually run and their outcomes

All commands were run in the workspace root on Windows.

- `npx tsc --noEmit` — clean, no output.
- `node --test tests/macro.test.ts` — 22/22 pass (16 pre-existing, 6 new).
- `npm test` (typecheck + `node --test tests/*.test.ts`) — **76/76 pass, 0 fail**,
  run four times. The suite was 70 before; the 6 new tests are the difference.
  No pre-existing test was modified or removed.
- `npx prettier --check src/macro.ts src/macro-types.ts tests/macro.test.ts`
  flagged only the new code; `npx prettier --write` on those three files fixed it
  and the suite was rerun. A diff against a prettier copy confirmed no
  pre-existing line was reformatted.
- Browser tests and the 200-seed legacy batch were **not** run, per the brief:
  this task changes no UI and no active generator.

### Max-size containment regression budget

Preserved and still passing, with the 2 s budget unchanged. Measured
`366x186, 20-point corridor` diagnostics on this machine:

- isolated `node --test tests/macro.test.ts`: 227.8 / 241.3 / 234.1 ms
- full `npm test`: 398.6 / 359.0 / 390.0 / 351.2 ms

The previously recorded figure (309.7 ms) was a full-suite run on a different
machine state, so the full-suite numbers here are not directly comparable and I
do not claim a speedup or a regression from them. What is measurable is the
helper's own cost: on that same 366x186 fixture (which merges to 4 walls) a
repeated `checkMacroRoutes` call took 6.5 / 4.0 / 3.9 ms, so the helper cannot
account for the spread above. Each of these is one local measurement, not a
throughput guarantee.

## Tests added, and evidence they are load-bearing

Fixture `revalidationInput()`: a 12x6 field owning all cells, with one retained
corridor (`spine`, radius 0.9) and two retained constraints over the same
endpoints that differ only by radius (`wide` 0.9, `narrow` 0.55, both
`connected: true`). Every post-composition edit is a direct `map.walls` change,
and every assertion is checked against actual swept geometry.

1. _a fresh composition rechecks clean and matches its manifest_ — full
   `deepEqual` on the report, plus the manifest counts/observations.
2. _a blocker added after caches are populated fails, and removing it recovers_ —
   populates the wall index and both radius lattices first, pushes a wall across
   the corridor, asserts the corridor error and `corridorsChecked: 0` while both
   constraints legitimately still connect around the short stub; then pops the
   wall and asserts recovery. `segmentClear` is asserted directly in both states.
3. _retained constraints are reevaluated per radius after geometry edits_ — a
   1.2-cell aperture pushed in at `x = 6` makes the 0.9 corridor and the `wide`
   constraint fail while `narrow` still connects, with both observations recorded
   and `connects(...)` confirming each at its own radius.
4. _a blocked endpoint fails even for a requested cut_ — a `connected: false`
   constraint observes `false` cleanly, then a wall through one endpoint makes it
   fail with a blocked-endpoint error and **no** observation recorded.
5. _reports are fresh and never alias or rewrite the composition_ — two calls are
   deep-equal but not identical objects, the report's entries are not the
   manifest's, scribbling on a returned report does not affect the next one, and
   `walls`, `constraints`, `corridors`, `manifest`, `regions` and `segmentOpen`
   all deep-equal their pre-call clones.
6. _non-finite wall coordinates fail without any navigation work_ — a NaN wall is
   appended and `map.walls` is wrapped in a `Proxy` counting numeric index reads.
   The report is the expected rejection, and the read count equals the wall count
   exactly: each record is read once for validation and never swept or indexed.
   Popping the bad wall recovers a valid report.

I mutated the implementation to confirm these tests fail when they should (each
mutation was reverted and the suite reconfirmed at 76/76):

- deleting `clearNavCache(map)` — tests 2, 3 and 4 fail.
- deleting the early `return reject()` after wall validation — test 6 fails.
- inserting one `occupiable(...)` call before wall validation — test 6 fails on
  the read count, 368 reads against 5.

## Remaining failures and ambiguities

No failing tests and nothing blocked. Two open items, both deliberately left to
the lead:

- Whether a post-edit caller should be able to treat a connectivity disagreement
  as reportable without invalidating the whole map (see the first contract point
  above). Today it is an error for every caller.
- `corridorsChecked` says how many corridors passed but not which ones, and the
  report has no per-corridor list. Error strings carry `placementId/id`, so the
  information is recoverable by parsing, which is not a good interface. If the
  micro pass needs per-corridor status it should be a new field on
  `MacroRouteCheck` rather than string parsing.

## Next action for Codex

Review the diffs in `src/macro.ts`, `src/macro-types.ts` and
`tests/macro.test.ts`, then update `docs/MACRO_STRUCTURES.md` (the helper is now
implemented; document it as the shared post-edit recheck and its sampled
semantics), and archive/update `docs/CLAUDE_MACRO_REVALIDATION.md`,
`MODEL_HANDOFF.md` and `docs/NEXT_TASKS.md`. Then proceed to micro/placement
validation, calling `checkMacroRoutes` after each final-geometry change rather
than reintroducing local checks, and decide the two open interface questions
above before a caller starts parsing error strings.
