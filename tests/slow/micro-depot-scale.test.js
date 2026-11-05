import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { cordWork } from '../../map/micro/cord-witness.ts';
import { cellsOf } from '../helpers/cells.js';
import { assertWithinBudget } from '../helpers/budget.js';

// A macro-sized depot: 200 × 150 cells with a two-cell portal every four cells on every side
// (170 portals), about 6 s alone. Slow tier because the fast tier's 100 × 75 case bounds the same
// cord work per region (31). Before #801 it took about 460 s: its witness outgrew fixed point
// limits, every later commit failed as `budget`, and each failure split into more whole-region
// proofs. The counts below fail if that returns; the duration stays opt-in (`BUILD_BUDGETS`).
test('a macro-sized depot with hundreds of portals builds with few cord searches', () => {
  const w = 200, h = 150, cells = cellsOf(w, h), portals = [];
  for (let x = 2; x < w - 4; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: h, length: 2 });
  for (let y = 2; y < h - 4; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: w, y, length: 2 });
  const brief = { id: 'macro', seed: 3, type: 'depot', cellSize: 40, cells, zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals };
  const before = { ...cordWork }, started = performance.now();
  const result = buildRegion(brief);
  assertWithinBudget(performance.now() - started, 12000, 'macro depot built');
  const calls = cordWork.calls - before.calls, meshes = cordWork.meshBuilds - before.meshBuilds;
  assert.ok(calls <= 12 && meshes <= 12, `cord searches ${calls}, meshes ${meshes}, ceiling 12 each (#801)`);
  assert.ok(result.manifest.warehouses > 100 && result.manifest.rows > 200, JSON.stringify(result.manifest));
});
