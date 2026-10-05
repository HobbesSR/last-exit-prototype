import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, REGION_TYPES } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (type, seed, cells, portals) => ({ id: 'drafted', seed, type, cellSize: SIZE, cells,
  zones: [{ tier: 2, bonus: 0, lootChance: 0.4, cells }], portals });

/** A field and an L, with portals on several sides. */
const MASKS = {
  field: [cellsOf(24, 18), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }]],
  ell: [cellsOf(18, 18, (x, y) => y < 9 || x < 9), [{ id: 'east', axis: 'v', x: 18, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 18, length: 3 }]],
};

// 54, "Drafted types": each is its own name, bound to the nearest built strategy.
const STAND_INS = { market: 'hall', checkpoint: 'cover', park: 'cover' };

test('each drafted type builds what its stand-in builds, under its own name', () => {
  for (const [type, standIn] of Object.entries(STAND_INS)) {
    assert.equal(REGION_TYPES[type], REGION_TYPES[standIn], `${type} is bound to ${standIn}`);
    for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of [1, 2, 3]) {
      const drafted = buildRegion(brief(type, seed, cells, portals)), built = buildRegion(brief(standIn, seed, cells, portals));
      assert.equal(drafted.brief.type, type);
      assert.deepEqual({ ...drafted, brief: { ...drafted.brief, type: standIn } }, built, `${type} ${name} seed ${seed}`);
      const check = validatePortalReach({ ...drafted.brief, blockers: drafted.elements.flatMap(element => elementShapes(element)) });
      assert.deepEqual(check.errors, [], `${type} ${name} seed ${seed} keeps the portal promise`);
    }
  }
});
