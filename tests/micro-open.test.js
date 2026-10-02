import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, REGION_TYPES } from '../map/micro/region-types.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

/** An L of two 12 × 6 arms, with portals at both ends and one on the inside corner. */
function brief(seed) {
  const cells = [];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if (y < 6 || x < 6) cells.push({ x, y });
  return { id: 'ell', seed, type: 'open', cellSize: 40, cells,
    zones: [{ tier: 2, bonus: 0, lootChance: 1, cells }],
    portals: [{ id: 'east', axis: 'v', x: 12, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 12, length: 3 },
      { id: 'corner', axis: 'h', x: 7, y: 6, length: 4 }] };
}

test('an open region builds nothing: pure open cells, with no loot (17 M25)', () => {
  for (const seed of [1, 2, 3]) {
    const result = buildRegion(brief(seed));
    assert.deepEqual([result.elements, result.coreElements, result.loot], [[], [], []]);
    assert.equal(result.manifest.cells, 108);
    assert.deepEqual(result.brief, brief(seed));
  }
  assert.ok(Object.isFrozen(REGION_TYPES));
});

test('an open region keeps the portal promise over seeds and an irregular mask', () => {
  for (const seed of [1, 2, 3]) {
    const result = buildRegion(brief(seed));
    const check = validatePortalReach({ ...result.brief, blockers: [] });
    assert.deepEqual(check.errors, [], `seed ${seed}`);
    assert.equal(check.routes.length, 2);
  }
});

test('core elements asked of an open region are left for the report to name', () => {
  const result = buildRegion({ ...brief(1), coreElements: { spawn: 4, charger: 1 } });
  assert.deepEqual(result.coreElements, []);
  assert.equal(result.manifest.coreElements, 0);
});
