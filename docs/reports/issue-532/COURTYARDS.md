# Compound courtyard composition (#532)

`types-52` / `compound-yard-5` adds one HOUSE keep and up to four cover
pieces before exterior-yard delegation. The ring, gate selection and exterior
offer policy are unchanged. This is a useful first courtyard grammar; additional
exterior structures, larger-hut authoring and maximum residual use are separate
work.

Run `node docs/reports/issue-532/courtyards.mjs` for the raw
[authored sample](courtyards.json). The script generates the three matching
bundled libraries at cell size 48 using the parameters recorded in the JSON.
It checks final combined geometry, every ring/keep space, each realized door
center and its approaches on both sides, and the compound portal promise.
The nearest portal is used for each local target; the portal promise joins
these starts. All 772 targets pass, all eight compounds pass their portal
checks, and all three maps have no report defects.

| Authored seed | Courts | Keeps | Cover pieces | Physically occupied cells without / with court additions |
| --- | ---: | ---: | ---: | ---: |
| size-12-1 | 1 | 1 | 4 | 173 / 194 |
| size-24-1 | 2 | 2 | 8 | 481 / 542 |
| size-36-1 | 5 | 5 | 20 | 1,033 / 1,158 |

Four keeps use three-space 6 × 6 designs and four use two-space 6 × 4
designs. Their envelopes address 240 cells, plus 48 cells of cover footprints
across the eight courts. These are new composition intent within the already
retained ring parcel, not additional region ownership or physical occupancy.
Courts are 16 × 14 or 18 × 18. Occupancy uses `measureFill` on
each complete compound result; the comparison removes only the newly labeled
court elements from that result. It isolates their physical contribution,
including the enclosed floor remaining physically free; it is not a replay of
the historical generator or a claim that all other content hashes stay fixed.

The construction leaves a continuous two-cell court perimeter beside ring
openings and two-cell gaps between every rectangular court footprint. Each
footprint therefore has a hunter bypass connected to the perimeter. The canvas
also protects the keep's actual doorstep. A central two-by-two standing block
stays clear. The ring's whole pessimistic parcel continues to keep all court
content retained during exterior delegation. Small courts may admit cover only;
the six-by-six no-fit witness remains empty. This policy is conservative and
does not optimize occupied area or compare alternative composition orders.

The new focused test verifies those clearances, all room and door approaches,
small-court refusal, and reversed-cell determinism. It measures 5.7 seconds
with `npm run test:times -- tests/micro-compound-court.test.js`, below the
15-second fast-file budget. Full and omitted snapshot recovery includes the
keep observer event; mismatched historical compound versions are rejected.
The edited block/observer files also remain under 15 seconds in isolated
timing. The former delegation file took 18.2 seconds, so its three observer
and snapshot cases now live in `micro-compound-snapshots.test.js`, preserving
their assertions. A serial rerun measures 13.3 seconds for delegation and
5.6 seconds for snapshots.

The [integration report](court-integration.json) records the 224-map sweep:
224 results hashes, 130 built hashes and 130 report hashes changed; all upstream
views stayed fixed. All 130 built-drift cases pass
`checkMap(generate(seed, params), { diagnose: true })`. Its 384-second duration
is a verification run, not a performance comparison. To reproduce, first run
`node map/tools/cli.mts sweep --check map/tools/fixtures/chain-baseline.json`
against the pre-change baseline from `c3c0cfc` and save its output as
`test-results/532-sweep-before.log`, then run
`node docs/reports/issue-532/court-integration.mjs`. The report pins the input
log digest and working-source hashes. A recaptured baseline has no drift and
cannot select these historical changed cases by comparison alone.

Integration also passes all 517 micro units, the four micro browser scripts,
typecheck and syntax checks, and 14 selected slow compound/library tests.
The library checks cover 25 default-size maps, five each at 24 × 12 and
36 × 18, and a full game-map portal diagnostic. The frozen simulation fixture
is unchanged. The initial micro run found an old block observer assumption
that included all `compound-*` pieces in the ring; its corrected check selects
ring room/gate pieces and independently checks the keep trace.

The final capture pins content commit `a6cfa52` at
`2026-10-30T00:58:50.671Z`, Node v24.15.0, with all 224 cases and no generation
errors. An independent full comparison against it reports zero drift (150
seconds). Capture provenance is owned by 42.4; the source hashes above still
match the generated implementation.

The first full fast run passed 1,279 of 1,280 tests; its only failure was the
old generated-ID pins in `view.test.js`. Seed 1 now ends at `o788`,
`door-464`, `item-1800`; seed 2 at `o891`, `door-587`, `item-1824`.
The assertions remain in place with those intentional content expectations.
The complete view test passes and measures 10.9 seconds in isolation.

Final `npm test`: all 1,280 tests passed, zero failed (196 seconds).
