# Issue 330 baseline evidence

Captured on commit `3b54da0` (`codex/330-hut-cover`) before lead source edits. Existing untracked audit directories were preserved. Baseline source is recoverable with `git show 3b54da0:map/micro/strategies/hut.ts`.

## Route

`node test-results/330-measure.mjs` runs five direct builds for each existing hut case, followed by one full game map at each authored size, sequentially. Direct cases mirror `tests/micro-hut.test.js`: small worked 6x6, broad 10x8 yard, concave 12x12 ell, and concave 14x14 ring. It prints generation times, deterministic output hashes and manifest counts. Map runs use `generate(seed, {mode:'game', zoneWidth, zoneHeight})`; their total map JSON hash/size, tiles, set pieces, results and single elapsed time are reported. Repeat after the code change in the lead worktree using the same script; copy it there if needed. Output is intentionally printed so before/after can be retained separately.

For focused hut evidence without maps, run `node test-results/330-measure.mjs` only after editing the script's final fullMaps loop to `[]`, or use the `directHut` block from the baseline below. These timings are single-process and noisy: first result includes startup/JIT effects, and the 5-sample medians are descriptive, not a benchmark gate.

## Direct hut results

| Case | Cells / portals | Five times (ms) | Median (ms) | Output summary |
|---|---:|---|---:|---|
| small worked 6x6 | 36 / 2 | 12.811, 1.633, 1.645, 1.456, 0.836 | 1.633 | building 3x3 or 3x4; 7 obstacles, 1 gate |
| broad yard 10x8 | 80 / 4 | 6.182, 2.438, 3.069, 2.089, 2.469 | 2.469 | building 6x4; 13 obstacles, 2 gates |
| concave ell 12x12 | 108 / 3 | 6.128, 6.142, 15.658, 14.574, 12.806 | 12.806 | building 9x4 or 4x9; 19 obstacles, 3 gates |
| concave ring 14x14 | 180 / 3 | 5.696, 15.406, 4.298, 14.896, 15.701 | 14.896 | building 9x4 or 4x9; 19 obstacles, 3 gates |

Output hashes/bytes per seed are in the original command output; key count fields are stable across the five seeds except loot count and chosen hut orientation/shape. These builds had one structure each.

## Full map results

| Size | Seed | Time (ms) | Tiles | Set pieces | Results | JSON bytes | SHA-256 of `JSON.stringify(map)` |
|---|---|---:|---:|---:|---:|---:|---|
| 12x6 | issue330-before-12x6 | 928.889 | 936 | 26 | 265 | 2,496,219 | c0f9966e87da4cf3dc52c7c1028e07ab53cd00d978643c4fe2ed43337f81d435 |
| 24x12 | issue330-before-24x12 | 4,247.877 | 3,744 | 56 | 1,007 | 9,958,630 | a7f900f02b286969a255fba3dd17a3843cd217beef637a31570c14db05df48e5 |
| 36x18 | issue330-before-36x18 | 11,586.425 | 8,424 | 64 | 2,064 | 22,304,857 | e39470b8be574e579d03dcebe1a16c873a6ca84d3af01f92fc93b057bb9c7270 |

These are generation-only timings; no diagnose check ran. They are broad map cost references, not hut attribution. The project sweep hash route is `node map/tools/cli.mts sweep --out <file> --count N` / `--check <file>` (full sweep is multi-minute; do not use as the modest comparison). `map/tools/core.ts` exposes `generate`, `batch`, and `checkMap`; diagnosis adds about a minute per game map. `map/tools/cli.mts generate --seed ... --zone-width ... --zone-height ... --out ...` is the standard saved-map route. There is no dedicated hut timing CLI. `tools/builder-fill.mjs` / `npm run fill` summarizes fill but only on rectangular synthetic briefs. `tools/micro-region.mjs --builder=hut --shape=... --batch=N` measures the four `microExample` shapes, but not the test suite's exact custom yard/concave masks. The browser Map Lab's `snapshot()` is UI state, not a generation-performance snapshot API; chain serialized map views are in `map/tools/sweep.mts`.
