# Perimeter-reach SDK verification (#837)

The SDK contract is in [20.10](../../20.10-portal-cords.md). The implementation
moves the original hint-wall planner/committer into `perimeter-reach.ts` and
retains the old entry points as wrappers. Expanded run selection is opt-in;
no production builder selects additional runs. No version or fixture changed.

Acceptance uses the existing hint-wall tests plus a new fast-tier micro test:

- Explicit unhinted 18-cell selection splits around portal/end-cap and internal
  guarantee exclusions, keeps all wall geometry in the fill, and rejects an
  interior run. An empty explicit selection overrides hints.
- In a two-cell-wide, 18-cell-long corridor, opposing 0.1-cell walls together
  fail hunter reach. The live cord keeps the first, refuses the second, and
  leaves the refused side unaddressed. Final geometry passes thorough reach.
  The same result holds at cell sizes 20 and 40 and with reversed owned cells.

`tests/micro-perimeter-reach.test.js` belongs to the existing `micro-*` set.
Its isolated `npm run test:times -- tests/micro-perimeter-reach.test.js` run
was 0.3 s (fast tier, 15 s file budget). Two small cases use hand-built geometry
and existing swept-search helpers; no maps or seed sweeps are added to CI.
This is the cheapest direct witness of margin handling and a refused long-run
assembly, rather than a new builder-content sweep. CI machines run slower.

Whole-map generation can be reproduced with:

```sh
node docs/reports/issue-837/generate.mjs docs/reports/issue-837/generate.json
```

It takes the machine-wide bench lock and records one cold `generate` call at
36 wide, along with exact arguments, Node version, starting revision and an
output hash. This measures the switched-off landing only; it is not an
estimate of future adoption cost or a performance comparison. The retained
quiet capture took **44.97 s**, at cell size 48. It ran after waiting for the
other agents' active Node test/sweep processes to finish, under the bench lock.
An earlier contended sample (54.28 s) had the identical output hash and was
replaced by this quiet capture; it is not evidence of an implementation change.

Validation passed:

- `npm run check` and `npm run typecheck`.
- `npm run brief -- test`: 1,485 passed, zero failures/skips. The shared machine
  was 94% busy; its 381.5 s duration is not an isolated timing comparison.
- `node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json`:
  228 checked, zero drift. The baseline was not recaptured.
- `npm run brief -- test:set micro:hint-walls` and `micro:perimeter`.
  The latter and TypeScript were rerun after the runtime external-ledger guard
  was finalized. Rejected candidates leave both the coordinator's rejected
  side and an accidentally supplied external ledger unmarked.
- The #761 probe's checks and provenance are retained separately in
  [its report](../issue-761/README.md).

No browser code or authored macro library changed, so browser and macro-package
gates were not run. No slow file targets the three existing hint-wall callers;
their existing fast witnesses and the full chain sweep cover this extraction.
