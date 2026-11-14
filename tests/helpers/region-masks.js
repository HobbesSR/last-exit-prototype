import { cellsOf } from './cells.js';

// Builder fixtures several region types share, identical across them (#1072). A type whose
// fixtures are tailored to it (hut, block, compound's masks) keeps its own: level-tailored is not duplicate.

export const SIZE = 40;

/**
 * A brief maker for `type`, as its builder's fixtures call it: the mask's cells and portals, one tier 3
 * zone over them with `lootChance` (a call may give its own), and `parameters` when given.
 */
export const briefOf = (type, lootChance = 0.4) => (id, seed, cells, portals, parameters, chance = lootChance) => ({ id, seed, type,
  cellSize: SIZE, cells, zones: [{ tier: 3, bonus: 0, lootChance: chance, cells }], portals, ...(parameters ? { parameters } : {}) });

/** Depot's, plant's and (but the yard) park's: a yard, a wide field, an L, and a ring around a hole, with portals on several sides. */
export const MASKS = {
  yard: [cellsOf(14, 12), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 14, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 6, y: 12, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 7, length: 2 }]],
  field: [cellsOf(40, 30), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 15 || x < 15), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
    { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 }]],
  ring: [cellsOf(36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23), [{ id: 'north', axis: 'h', x: 15, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 23, y: 16, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 26, length: 3 }]],
};

/** Hall's and ruins': the same four shapes at a smaller scale. */
export const SMALL_MASKS = {
  yard: [cellsOf(10, 8), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 10, y: 2, length: 4 },
    { id: 'south', axis: 'h', x: 4, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 5, length: 2 }]],
  field: [cellsOf(24, 18), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }]],
  ell: [cellsOf(18, 18, (x, y) => y < 9 || x < 9), [{ id: 'east', axis: 'v', x: 18, y: 2, length: 2 }, { id: 'south', axis: 'h', x: 1, y: 18, length: 3 },
    { id: 'corner', axis: 'h', x: 10, y: 9, length: 4 }]],
  ring: [cellsOf(20, 20, (x, y) => x < 6 || x >= 14 || y < 6 || y >= 14), [{ id: 'north', axis: 'h', x: 8, y: 0, length: 2 },
    { id: 'hole', axis: 'v', x: 14, y: 8, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 15, length: 3 }]],
};
