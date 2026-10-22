# Physics P0 comparison lab

Isolated research for #437. Nothing in the game imports these candidates. Rapier
is an exact, development-only dependency; `npm ci` installs the pinned artifact.
The scenario/action contract is in [contract.md](contract.md). This is neither a
production physics API nor permission to activate new gameplay rules.

Run from the repository root:

```powershell
npm run test:physics
npm run physics:report -- --mode=correctness --out=test-results/physics-correctness.json
npm run physics:report -- --mode=node --out=test-results/physics-node.json
npm run physics:report -- --mode=browser --out=test-results/physics-browser.json
```

`node` measures the full actor × prop × tether × sparse/clustered × substep
matrix, plus separate sleeping populations. `browser` runs all correctness
scenarios at 2/4/8 substeps, then the diagonal capacity envelope at four substeps
in installed headless Chrome. `all` runs Node then Chrome. `--diagonal` reduces
only Node timing coverage; it is recorded in the command. `--samples=N` and
`--warmup=N` default to 100 and 20 ticks. `--candidates=custom,rapier` chooses
ordering. Every report invocation acquires the existing machine benchmark lock.

Reports keep exact state SHA-256 hashes, repeated runs, checkpoint continuation,
per-substep geometry diagnostics, a one-second analytic spring reference,
startup/disposal and heap observations, ordered-network projection probes, and
raw per-tick step/cast/serialization/byte samples. Numeric gate failures are
results, not reasons to alter the witness. Unexpected exceptions are retained
as `error` entries and must be inspected. Reports save after each timing cell.
Generated reports in `test-results/` are scratch; durable evidence belongs in
`docs/reports/` with a numbered interpretation.

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
- Both candidates use game-owned centre spring forces and force-limited rope
  impulses. Native Rapier joints are not evaluated. Spring forces use explicit
  substep integration; their measured reference error remains a release gate.
- Paths between observed substeps are checked independently. Relative circles
  have an analytic straight-path test; rotating boxes are sampled at up to 1024
  intervals. These cannot prove arbitrary continuous containment or reconstruct
  an engine's internal curved/bouncing CCD path.
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
