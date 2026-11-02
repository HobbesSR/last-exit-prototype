import test from 'node:test';
import assert from 'node:assert/strict';
import { coverNear } from '../map/micro/strategies/cover.ts';
import { rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40, cells = cellsOf(20, 8);
const portals = [{ id: 'left', axis: 'v', x: 0, y: 3, length: 2 }, { id: 'right', axis: 'v', x: 20, y: 3, length: 2 }];
const brief = { id: 'near', seed: 1, type: 'charging', cellSize: SIZE, cells, zones: [], portals };
const site = { x: 4 * SIZE, y: 4 * SIZE, radius: SIZE };

test('coverNear adds one guard and keeps the cover it was given (#787)', () => {
  const crate = { label: 'crate', x: 16 * SIZE, y: SIZE, template: { w: SIZE, h: SIZE, parts: [{ part: 'obstacle', kind: 'crate', shape: rect(0, 0, SIZE, SIZE) }] } };
  const near = coverNear(brief, { elements: [crate], loot: [] }, site, 2 * SIZE);
  assert.equal(near.elements.length, 2);
  assert.deepEqual(near.elements[0], crate);
  assert.equal(near.guardsSkipped, undefined);
});

test('coverNear returns the cover unchanged and counts it when a fresh cord refuses the cover (#787)', () => {
  // A wall across the region leaves no cord; the guard must not drop it, nor stand without it.
  const wall = { label: 'cut', x: 15 * SIZE, y: 0, template: { w: SIZE, h: 8 * SIZE, parts: [{ part: 'obstacle', kind: 'wall', shape: rect(0, 0, SIZE, 8 * SIZE) }] } };
  const cover = { elements: [wall], loot: [{ x: 18 * SIZE, y: 4 * SIZE, tier: 1 }] };
  const near = coverNear(brief, cover, site, 2 * SIZE);
  assert.deepEqual(near.elements, cover.elements);
  assert.deepEqual(near.loot, cover.loot);
  assert.equal(near.guardsSkipped, 1);
  assert.equal(coverNear(brief, near, { ...site, y: 5 * SIZE }, 2 * SIZE).guardsSkipped, 2);
});
