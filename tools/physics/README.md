# Physics P0 comparison lab

P9's integrated local playtest is at `/dev/physics` when running `npm run dev`.
Try A character contact/crowd, B crates and C hook; use Reset to pin tuning and
Download JSON to retain configuration/actions/frames for Import and rerun.
This does not change default matches. Human feel/promotion gates and measurement
limits live in [42.20](../../docs/42.20-physics-p9.md).

Sequential P9 measurements (after other tests finish):

```powershell
npm run physics:integration
node tests/bench-client.mjs --physics --json
```

The integration report accepts `--warmup=N --samples=N --output=path` through
the direct `node --expose-gc tools/physics/integration-report.mjs` invocation.
It compares legacy/A/B/C at 11/27 actors, with 128 **total** dynamic bodies in
B/C (64 crates plus actors and loose loot), and eight direct bounded ropes in C.
This is an open synthetic arena with scripted input; generated-map bot and real
browser costs require their own existing witnesses. Source/settings and observed
awake-body counts accompany every run. A failed admission is retained as a
failure rather than silently reducing the requested population.

Isolated research for #437 and #451. Nothing in the game imports these candidates. Rapier
is an exact, development-only dependency; `npm ci` installs the pinned artifact.
The scenario/action contract is in [contract.md](contract.md). This is neither a
production physics API nor permission to activate new gameplay rules.

Run from the repository root:

```powershell
npm run test:physics
npm run physics:report -- --mode=correctness --out=test-results/physics-correctness.json
npm run physics:report -- --mode=node --out=test-results/physics-node.json
npm run physics:report -- --mode=browser --out=test-results/physics-browser.json
npm run physics:report -- --mode=correctness --browser --queries --out=test-results/physics-supplement.json
```

On npm versions that reject forwarded `--mode` flags, use the direct equivalent:
`node --expose-gc tools/physics/report.mjs --mode=all --queries --out=test-results/physics-451.json`.
Focused cost repetitions: `node tools/physics/repeat-timing.mjs test-results/physics-451-repeats.json`.
Optional visual QA (Python/matplotlib): `python tools/physics/plot-springs.py test-results/physics-451.json docs/reports/physics-451-springs.png`.
The retained revised measurements and limitations are in [42.9](../../docs/42.9-physics-remediation.md).

The physics test files also run in the normal fast tier through `tests/*.test.js`.

`node` measures the full actor × prop × tether × sparse/clustered × substep
matrix, plus separate sleeping populations. `browser` runs all correctness
scenarios at 2/4/8 substeps, then the diagonal capacity envelope at four substeps
in installed headless Chrome. `all` runs Node then Chrome. `--diagonal` reduces
only Node timing coverage; it is recorded in the command. `--samples=N` and
`--warmup=N` default to 100 and 20 ticks. Revised reports evaluate Rapier only,
plus the legacy timing control; the retired custom solver and its tests remain
an archived P0 baseline. Every invocation acquires the machine benchmark lock.

With `correctness`, `--browser` adds Chrome correctness without the full timing
matrix. `--queries` adds 18 populated query microbenchmarks per candidate/runtime:
one 12.5 ms scene step, then 128 fixed paths with 96 aimed through initial body
centres. Original timing-grid casts run along the northern fringe; use the
supplement for populated-query evidence. Input hashes and hit counts are retained.

Reports keep exact state SHA-256 hashes, repeated runs, checkpoint continuation,
per-substep geometry diagnostics, native spring stability/settling traces,
startup/disposal and heap observations, ordered-network projection probes, and
raw per-tick step/cast/serialization/byte samples. Numeric gate failures are
results, not reasons to alter the witness. Unexpected exceptions are retained
as `error` entries and must be inspected. Reports save after each timing cell.
Generated reports in `test-results/` are scratch; durable evidence belongs in
`docs/reports/` with a numbered interpretation. Large retained reports use
lossless `.json.gz`; decompress them before passing a file to `--resume`.
For example, read one in Node with
`JSON.parse(gunzipSync(readFileSync(path)))` from `node:zlib` and `node:fs`.

An interrupted Node sweep can resume with `--mode=node --resume=<saved.json>
--out=<saved.json>`. It refuses changed solver/witness/runner/lockfile hashes or
different sample settings, records the restart and source manifest, warms the
candidate again, and skips only saved cells with the same complete configuration.

The legacy control invokes actual `moveBody` once per 20 Hz tick on the same
actor-only workload. It does not implement dynamics, new-body collisions,
constraints or projectile queries, so its timing is not an equivalent engine
score. Its synthetic map is translated into a large legacy diamond.

Limits that constrain interpretation:

- Workloads are seeded synthetic maps with four boundary walls and a pillar per
  hundred dynamic bodies, not generated production maps or whole-room tests.
  Body counts mean props; loot-only masking is covered by separate witnesses.
- The 128 moving-projectile queries are swept circles against current poses.
  They do not model projectile damage, lifecycle or moving-target queries.
- P0 used game-owned springs and ropes; its unchanged evidence is in 42.6.
  The #451 suite adds opt-in native centre springs, uncapped and evaluation-only,
  and retains force-limited game-owned ropes. Native springs reject finite force
  caps. They are not an approved hook contract; jelly/squish remain #455.
- Revised gates and the speed admission policy are in 41.1 and contract.md.
  Contact witnesses scale the old r=8 geometry to r=12; the mixed gladiator is
  r=23. The doorway keeps its relative clearances and still rejects actor overlap
  above 0.5. The maximum live-map coordinate witness is 51,840 by 25,920 units,
  rather than a million. The generator playground has no universal size limit.
  Old scenarios remain in baselineScenarios for custom's historical tests.
- Paths between observed substeps are checked independently. Relative circles
  have an analytic straight-path test; rotating boxes are sampled at up to 1024
  intervals. These cannot prove arbitrary continuous containment or reconstruct
  an engine's internal curved/bouncing CCD path. A pair with overlap at either
  endpoint is excluded from the crossing counter and reported as penetration.
  Consequently a pass-through with an overlapping sample can show zero crossings;
  the old Rapier moving-pair witness did this while bodies swapped sides. Inspect
  penetration and trajectories together. Rotating interpolation uses the short
  angle arc, avoiding a false crossing when Rapier wraps from +pi to -pi.
- Coincident placement is deliberately invalid, marked separately from legal
  starts. Door closure is a caller policy that waits for a clear footprint.
- Prediction is a synthetic fresh-island reconstruction with authorized proxies,
  hidden contact, delayed door discovery, jitter, a stalled batch and ID removal.
  It is not the production networking or renderer. Its safe-cache comparison
  restores only the newly projected island, never an authoritative hidden world.
- JS heap samples include garbage collection noise; WASM allocator retention is
  not a memory census. Handle disposal is checked separately. Browser measurements
  are headless JavaScript costs, not GPU rendering or whole-game frame rates.

Read [41.1](../../docs/41.1-physics-plan.md) for promotion gates. If neither
candidate passes, report a no-go and keep production integration blocked.

## P7 isolated thrown-item lab (#447)

Run `npm run physics:ballistics` to create `test-results/physics-p7.json` and
`test-results/physics-p7.html`. Open the HTML directly in a browser to select a
witness and seek through retained ticks with the cube and its ground shadow.
No server or WASM is needed; playback imports no solver. To choose a report path:
`node tools/physics/ballistic-report.mjs test-results/my-ballistics.json`.
The `.html` is written alongside it. Report identity is
`ballistic-lab-recording-1`; source and trace SHA-256 hashes are included.

Focused acceptance: `node --test tests/physics-ballistics.test.js`, then
`node tests/physics-ballistics.browser.mjs`. The latter checks retained forward
and backward seek, shadow/cube pixels and complete Node/Chrome witness equality.
The 14 synthetic cases use one bounded cube profile, stationary explicit height
boxes, a flat ground plane and a rectangular mask with rectangular holes.
No game runtime imports this lab. It changes no live projectile, window or roof
behavior. Contract and promotion questions are in [29.1](../../docs/29.1-physics-design.md),
[29.2](../../docs/29.2-physics-state-networking.md), and
[17.3](../../docs/17.3-product-gameplay.md); evidence is [42.18](../../docs/42.18-physics-p7.md).

## Experimental P1 evidence (#438)

The production adapter now lives in `shared/physics/`, separately from these lab
implementations. Default matches stay legacy. Reproduce the retained paired tick
traces with `node tools/physics/phase-traces.mjs <output.json>`; run focused tests
with `npm run test:physics` and the actual shared adapter's Chrome witness with
`node tests/physics-world.browser.mjs`.

`node tools/physics/bench-integration.mjs <output.json>` takes the machine benchmark
lock and runs a short seeded legacy/experimental whole-match comparison sequentially.
It measures step, authoritative snapshot and one projection over 500 samples after
100 warmup ticks. Frame sizing is outside the timed interval. It is not the P0
physics-only workload or P9 capacity qualification. Findings and limits are in
[42.11](../../docs/42.11-physics-p1.md).
