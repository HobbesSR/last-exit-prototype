import { elementShapes } from '../../map/micro/geometry.ts';
import { bounds } from '../../shared/shape.ts';
import { cellsOf } from './cells.js';

export const SIZE = 40;
export const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'plant', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals, ...(parameters ? { parameters } : {}) });

/** A yard, a wide field, an L, and a ring around a hole, with portals on several sides. */
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
export const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
export const blockers = result => result.elements.flatMap(element => elementShapes(element));
export const kind = prefix => element => element.label.startsWith(`plant-${prefix}`);

/** A run's stubs as intervals along it, in cells from the run's start, and the gap they leave. */
export function gapOf(pipe) {
  const across = pipe.template.w > pipe.template.h, length = (across ? pipe.template.w : pipe.template.h) / SIZE - 1;
  // A stub cut by a chamfer is several convex pieces; their bounds still cover it along the run.
  const stubs = pipe.template.parts.map(({ shape }) => bounds(shape)).map(box => across ? [box.x / SIZE - 0.5, (box.x + box.w) / SIZE - 0.5]
    : [box.y / SIZE - 0.5, (box.y + box.h) / SIZE - 0.5]).sort((a, b) => a[0] - b[0]);
  const free = [];
  let at = 0;
  for (const [start, end] of stubs) { if (start > at) free.push([at, start]); at = Math.max(at, end); }
  if (at < length) free.push([at, length]);
  return { across, free };
}
