# Physics P0 comparison lab

The P0 comparison lab's engine harness (rapier.mjs, the runner, report, queries, lab prediction and the jelly lab) retired with the rapier.js package in #1192, and the old-world P4–P9 report drivers (`prediction-network.mjs`, `prediction-contacts.mjs`, `hook-traces.mjs`, `integration-report.mjs`, `p5-report.mjs`, `navigation-report.mjs`) retired in #1349 once the simulation tick moved into the Rust core ([27](../../docs/27-rust-path.md)). Their retained evidence stays in `docs/reports/` and the 42.x documents.

P9's integrated local playtest is at `/dev/physics` when running `npm run dev`.
Try A character contact/crowd, B crates and C hook; use Reset to pin tuning and
Download JSON to retain configuration/actions/frames for Import and rerun.
This does not change default matches. Human feel/promotion gates and measurement
limits live in [42.20](../../docs/42.20-physics-p9.md).

Sequential P9 client measurement (after other tests finish):

```powershell
node tests/bench-client.mjs --json
```

The client benchmark uses `defaultContent()` unless `--content=<id>` selects
another shipped set, and includes `physicsPrediction` statistics on live runs.

Isolated research for #437 and #451. The game uses its separate production adapter
in `shared/physics/`. Rapier is compiled into the Rust core (`rust/core`, docs/27); `rust/Cargo.lock` pins it.
The scenario/action contract is in [contract.md](contract.md). This is neither a
production physics API nor permission to activate new gameplay rules.

Run from the repository root:

```powershell
npm run test:physics
```

The retained revised measurements and limitations are in [42.9](../../docs/42.9-physics-remediation.md).

The physics test files also run in the normal fast tier through `tests/*.test.js`.

Reports keep exact state SHA-256 hashes, repeated runs, checkpoint continuation,
per-substep geometry diagnostics, native spring stability/settling traces,
startup/disposal and heap observations, ordered-network projection probes, and
raw per-tick step/cast/serialization/byte samples. Numeric gate failures are
results, not reasons to alter the witness. Unexpected exceptions are retained
as `error` entries and must be inspected. Reports save after each timing cell.
Generated reports in `test-results/` are scratch; durable evidence belongs in
`docs/reports/` with a numbered interpretation. Large retained reports use
lossless `.json.gz`; decompress them before reading. For example, read one in
Node with `JSON.parse(gunzipSync(readFileSync(path)))` from `node:zlib` and `node:fs`.

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

Read [29.1](../../docs/29.1-physics-design.md) for the physics gates. If neither
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

## Jelly and player compression prototype (#455)

Four synthetic scenes show stretched-jelly recovery, wall loading, opposing
player presses and a one-sided control. The player collider stays radius 12;
visual compression never changes collision geometry. The discrete jelly nodes
collide, but the filled connecting artwork is not a continuous shell collider.
The threshold signal causes no damage or death. Fixed-wall CCD contacts may have
no reported impulse, so the force proxy is not ready for gameplay crushing.

Assumptions, evidence and open promotion choices are in [42.21](../../docs/42.21-jelly-squish.md).

## Experimental P1 evidence (#438)

The production adapter now lives in `shared/physics/`, separately from these lab
implementations. Run focused tests with `npm run test:physics` and the actual
shared adapter's Chrome witness with `node tests/physics-world.browser.mjs`.

`node tools/physics/bench-integration.mjs <output.json>` takes the machine benchmark
lock and runs a short seeded whole-match sample sequentially.
It measures step, authoritative snapshot and one projection over 500 samples after
100 warmup ticks. Frame sizing is outside the timed interval. It is not the P0
physics-only workload or P9 capacity qualification. Findings and limits are in
[42.11](../../docs/42.11-physics-p1.md).
