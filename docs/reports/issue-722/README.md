# Local route-start enumeration: bounded evidence

The new neighbourhood loop preserves the original exact distance predicate,
row-major candidates and stable distance ordering. No content, clearance,
portal, RNG, ID, fixture or version change is part of this optimization.

The standalone change is separated from #716's unready authorship. Reproduce
the bounded enumeration-only comparison with:

```text
node docs/reports/issue-722/route-start-bench.mjs --out NEW_REPORT.json
```

It checks all 129 input candidate lists before measuring, acquires the benchmark
lock with a one-second wait limit, and caps the three-pair phase at ten seconds.
A fresh standalone benchmark attempt deferred after the one-second lock wait
because another task held the lock; it was not retried. The three completed
source-extracted pairs below retain identical common setup in both variants.
Those historical measurements predate the review refactor. The current runner
imports the production `routeStarts` helper directly and compares it with an
independent whole-grid reference; it does not extract or evaluate source text.

At prototype checkpoint `b051565`, one capped pass matched all 121 frozen
depot/market expected results exactly in 15.94 seconds (60-second cap, no retry).
That checks the #716 prototype's captured geometry, loot, core elements,
manifests and order; it does not claim that the prototype is ready for adoption.
The frozen corpus remains on `codex/incidental-seam-obstacles`, bound by SHA-256
`b90b15079f1396798217462c7782a08a6d15f527838f5e8dd4f52f2d970ce9bb`.

Three source-extracted enumeration comparisons on 129 cases gave:

| Pair | Whole-grid scan | Local neighbourhood |
| --- | ---: | ---: |
| 1 | 35.255 ms | 1.109 ms |
| 2 | 33.048 ms | 1.084 ms |
| 3 | 33.009 ms | 1.093 ms |

Every candidate-list output hash was identical. These are **enumeration-only**
timings, not whole-generation timings. The 129 cases are one actual entrance
per captured brief plus eight off-grid cases. The control and variant were
otherwise identical; the benchmark lock serialized the measurements.

A broader actual-entrance equivalence probe hit its explicit 10-second cap
after 7,804 checked origins, all identical. It was not retried and is not
claimed as an exhaustive completed probe. No map generation or full access
analysis was repeated for these bounded checks.

`identity.json`, `micro.json` and `start-equivalence.json` retain raw results;
[`tests/fixtures/route-start-cases.json`](../../../tests/fixtures/route-start-cases.json)
holds the current test and microbenchmark inputs. The identical `cases.json`
copy remains here for historical evidence. `bounded-runner.mjs` is the
original bounded runner, intended to run with the pinned #716 prototype and
its frozen corpus. Its source extraction requires that pinned prototype; it
does not run against the current exported helper. It is historical evidence,
not part of the shipped generator.

## Integration status

Focused tests pass on 129 captured cases and 72 negative/off-grid/clipped/outside
cases, and TypeScript passes. The complete 224-map chain sweep reports zero
drift, without a baseline or version change. Local `npm test` and `test:micro`
reached their explicit 120/180-second caps and are incomplete; neither was
automatically retried. No assertion failure was observed before those caps.
After review, the planner and tests share an exported helper, the fixture lives
under `tests/fixtures/`, and the one-off benchmark lives in this report directory.
The revised focused tests pass all 201 cases in 0.4 seconds under `test:times`;
typecheck and static checks pass. A complete fast run passes all 1,379 tests
with no skips or failures in 241.06 seconds, within its five-minute cap. The
revised benchmark deferred after its one-second lock wait; no retry was made.
The earlier capped runs above remain historical records, not current failures.
The complete revised micro gate also finishes within its five-minute cap:
543 tests pass with no skips or failures (232.15 seconds for the unit phase),
followed by all four browser scripts. No map corpus or baseline was regenerated.
