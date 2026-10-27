import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { cellsOf } from '../helpers/cells.js';
import { assertWithinBudget } from '../helpers/budget.js';
import { brief } from '../helpers/block-masks.js';

test('a macro-sized block with hundreds of portals builds quickly', () => {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  const started = performance.now();
  const result = buildRegion(brief('macro', 3, cells, portals));
  const elapsed = performance.now() - started;
  assertWithinBudget(elapsed, 5000);
  assert.ok(result.manifest.structures > 50, `${result.manifest.structures} structures`);
  assert.equal(result.manifest.lots, undefined);
});
