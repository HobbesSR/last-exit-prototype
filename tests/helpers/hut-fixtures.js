import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { elementShapes } from '../../map/micro/geometry.ts';
import { cellsOf } from './cells.js';

/** Hut fixtures shared by tests/micro-hut.test.js and tests/slow/micro-hut-sweeps.test.js (#807). */
export const SIZE = 40;
export const brief = (id, seed, cells, portals, extra = {}) => ({ id, seed, type: 'hut', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }], portals, ...extra });

/** 52's worked case, then masks with portals on several sides: a yard, an L, and a ring around a hole. */
export const MASKS = {
  worked: [cellsOf(6, 6), [{ id: 'south', axis: 'h', x: 1, y: 6, length: 2 }, { id: 'east', axis: 'v', x: 6, y: 3, length: 2 }]],
  yard: [cellsOf(10, 8), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 10, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 4, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 5, length: 2 }]],
  ell: [cellsOf(12, 12, (x, y) => y < 6 || x < 6), [{ id: 'east', axis: 'v', x: 12, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 12, length: 3 },
    { id: 'corner', axis: 'h', x: 7, y: 6, length: 4 }]],
  ring: [cellsOf(14, 14, (x, y) => x < 5 || x >= 9 || y < 5 || y >= 9), [{ id: 'north', axis: 'h', x: 6, y: 0, length: 2 },
    { id: 'hole', axis: 'v', x: 9, y: 6, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 10, length: 3 }]],
};
export const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

export const house = result => result.elements.find(element => element.template.encloses);
export const blockers = (result, doors = false) => result.elements.flatMap(element => elementShapes(element, doors));

/**
 * Small regions, 6 or 7 cells a side at four cell sizes, use a house with a reachable outside
 * door and a window, whatever the order of their cells, at each of `seeds`. The fast tier runs
 * the first seed; tests/slow/micro-hut-sweeps.test.js all sixteen: the 256 builds took 5 s (#807).
 */
export function assertSmallHouses(seeds) {
  for (const [w, h] of [[6, 6], [7, 7], [7, 6], [6, 7]]) for (const cellSize of [1, 7, 40, 53]) for (const seed of seeds) {
    const cells = cellsOf(w, h), at = `${w}x${h} size ${cellSize} seed ${seed}`;
    const result = buildRegion({ id: 'one-space', seed, type: 'hut', cellSize, cells, zones: [{ tier: 3, bonus: 0, lootChance: 0.5, cells }],
      portals: [{ id: 's', axis: 'h', x: 0, y: h, length: 2 }] });
    const building = house(result);
    assert.ok(building, at);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, [], at);
    assert.ok(building.template.parts.some(part => part.part === 'gate'), at);
    assert.ok(building.template.parts.some(part => part.kind === 'window'), at);
    assert.deepEqual(buildRegion({ ...result.brief, cells: [...cells].reverse() }).elements, result.elements, at);
  }
}
