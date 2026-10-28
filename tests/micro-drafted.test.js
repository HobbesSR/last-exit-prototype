import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion, REGION_TYPES } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const brief = (type, seed, cells, portals) => ({ id: 'drafted', seed, type, cellSize: SIZE, cells,
  zones: [{ tier: 2, bonus: 0, lootChance: 0.4, cells }], portals });

/** A field and an L, with portals on several sides. */
const MASKS = {
  field: [cellsOf(24, 18), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }]],
  ell: [cellsOf(18, 18, (x, y) => y < 9 || x < 9), [{ id: 'east', axis: 'v', x: 18, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 18, length: 3 }]],
};

test('market has its own strategy and keeps the portal promise', () => {
  assert.notEqual(REGION_TYPES.market, REGION_TYPES.hall);
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of [1, 2, 3]) {
    const market = buildRegion(brief('market', seed, cells, portals));
    assert.equal(market.brief.type, 'market');
    assert.ok(market.elements.every(element => element.label.startsWith('market-stall-')));
    assert.equal(market.manifest.infillCrates, undefined);
    const check = validatePortalReach({ ...market.brief, blockers: market.elements.flatMap(element => elementShapes(element)) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed} keeps the portal promise`);
  }
});
