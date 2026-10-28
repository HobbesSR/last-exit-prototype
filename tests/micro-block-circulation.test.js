import test from 'node:test';
import assert from 'node:assert/strict';
import { regionExample } from '../map/micro/region-examples.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { hasWideCirculation } from '../map/micro/strategies/block-circulation.ts';
import { cellsOf } from './helpers/cells.js';
import { unusedComponents } from '../map/micro/components.ts';
import { CELL_SCALE } from '../map/kernel/scale.ts';

test('the cell-scale hunter clearance fits the radius-one circulation witness', () => {
  assert.ok(CELL_SCALE.hunterRadius + CELL_SCALE.clearanceMargin < 1);
});

test('neck lots preserve final alley-child hunter access independently of parent interiors', () => {
  const brief = regionExample({ type: 'block', shape: 'neck', width: 36, height: 30, seed: 1 });
  const plan = planBlock(brief), child = buildRegion(plan.alleys);
  assert.deepEqual(validateBriefPartition(brief, [...plan.lots, plan.alleys]), []);
  assert.equal(plan.lots.length, 5);
  assert.equal(plan.lots.reduce((n, lot) => n + lot.cells.length, 0), 488);
  assert.equal(child.elements.length, 0);
  assert.deepEqual(validatePortalReach({ ...plan.alleys, blockers: child.elements.flatMap(e => elementShapes(e)) }).errors, []);
  const parent = buildRegion(brief);
  assert.deepEqual(validatePortalReach({ ...brief, blockers: parent.elements.flatMap(e => elementShapes(e)) }).errors, []);
});

test('clearance admission refuses corner pinches, clipped approaches and unsafe claimed unions', () => {
  const cells = cellsOf(8, 8), west = { id: 'west', axis: 'v', x: 0, y: 0, length: 2 };
  assert.equal(hasWideCirculation(cells, new Set(), [west]), true, 'two-cell corner portal joins the backbone');
  const clipped = cells.filter(c => !(c.x === 1 && c.y === 1));
  assert.equal(hasWideCirculation(clipped, new Set(), [west]), false, 'first approach row alone is insufficient');
  const top = new Set(cells.filter(c => c.x === 3 && c.y < 4).map(c => `${c.x},${c.y}`));
  const bottom = new Set(cells.filter(c => c.x === 4 && c.y >= 5).map(c => `${c.x},${c.y}`));
  assert.equal(hasWideCirculation(cells, top, []), true);
  assert.equal(hasWideCirculation(cells, bottom, []), true);
  const union = new Set([...top, ...bottom]);
  assert.equal(unusedComponents(cells, union).length, 1, 'cell connectivity hides the diagonal hunter-width pinch');
  assert.equal(hasWideCirculation(cells, union, []), false);
});
