import { cellsOf } from './cells.js';

/** The block fixtures that micro-block's tests share. */
export const SIZE = 40;
export const brief = (id, seed, cells, portals) => ({ id, seed, type: 'block', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.3, cells }], portals });

/** A wide field, an L, a ring around a hole and a deep block, with portals on several sides. */
export const MASKS = {
  field: [cellsOf(44, 34), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 44, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(56, 56, (x, y) => y < 26 || x < 26), [{ id: 'east', axis: 'v', x: 56, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 56, length: 4 },
    { id: 'corner', axis: 'h', x: 30, y: 26, length: 6 }]],
  ring: [cellsOf(64, 64, (x, y) => x < 24 || x >= 40 || y < 24 || y >= 40), [{ id: 'north', axis: 'h', x: 20, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 40, y: 28, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 50, length: 3 }]],
  deep: [cellsOf(72, 60), [{ id: 'west', axis: 'v', x: 0, y: 30, length: 2 }, { id: 'east', axis: 'v', x: 72, y: 2, length: 2 },
    { id: 'south', axis: 'h', x: 60, y: 60, length: 2 }, { id: 'north', axis: 'h', x: 4, y: 0, length: 2 }]],
};
export const SEEDS = [1, 2, 3, 4];
