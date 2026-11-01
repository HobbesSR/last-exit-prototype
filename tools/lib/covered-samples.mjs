import { bounds, body, contains } from '../../shared/shape.ts';

/** Points per fill cell side when measuring covered area. */
export const SAMPLES = 4;

/** How many cells' worth of `cells` (fill) fall inside any of `shapes`, sampled at `SAMPLES`² points a cell. */
export function coveredSamples(cells, size, shapes) {
  const near = new Map();
  for (const shape of shapes) {
    const box = bounds(shape), cached = shape.kind === 'polygon' ? body(shape) : undefined;
    for (let y = Math.floor(box.y / size); y < Math.ceil((box.y + box.h) / size); y++)
      for (let x = Math.floor(box.x / size); x < Math.ceil((box.x + box.w) / size); x++) {
        const key = `${x},${y}`;
        (near.get(key) ?? near.set(key, []).get(key)).push([shape, cached]);
      }
  }
  let hit = 0;
  for (const cell of cells) {
    const list = near.get(`${cell.x},${cell.y}`);
    if (!list) continue;
    for (let i = 0; i < SAMPLES; i++) for (let j = 0; j < SAMPLES; j++) {
      const px = (cell.x + (i + .5) / SAMPLES) * size, py = (cell.y + (j + .5) / SAMPLES) * size;
      if (list.some(([shape, cached]) => contains(shape, px, py, cached))) hit++;
    }
  }
  return hit / SAMPLES ** 2;
}
