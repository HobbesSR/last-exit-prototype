# Local route-start enumeration: bounded evidence

The new neighbourhood loop preserves the original exact distance predicate,
row-major candidates and stable distance ordering. No content, clearance,
portal, RNG, ID, fixture or version change is part of this optimization.

The standalone change is separated from #716's unready authorship. Reproduce
the bounded enumeration-only comparison with:

```text
node tools/route-start-bench.mjs --out NEW_REPORT.json
```

It checks all 129 input candidate lists before measuring, acquires the benchmark
lock with a one-second wait limit, and caps the three-pair phase at ten seconds.
A fresh standalone benchmark attempt deferred after the one-second lock wait
because another task held the lock; it was not retried. The three completed
source-extracted pairs below retain identical common setup in both variants.

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
`cases.json` retains the microbenchmark inputs. `bounded-runner.mjs` is the
original bounded runner, intended to run with the pinned #716 prototype and
its frozen corpus. It is evidence, not part of the shipped generator.

## Integration status

Focused tests pass on 129 captured cases and 72 negative/off-grid/clipped/outside
cases, and TypeScript passes. The complete 224-map chain sweep reports zero
drift, without a baseline or version change. Local `npm test` and `test:micro`
reached their explicit 120/180-second caps and are incomplete; neither was
automatically retried. No assertion failure was observed before those caps.
The standalone PR remains work in progress until the full gates/CI complete.
