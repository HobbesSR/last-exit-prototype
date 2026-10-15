// Research adapter only. No simulation or RNG/ID state is consumed.
import { bounds, shapeOf, rect, segmentShapeDistance } from '../../shared/shape.ts';
import { gateShape, insideMap } from '../../shared/movement.ts';

/** Snapshot geometry and closed gates. Recreate after any geometry/door change.
 * Tangency is conservatively blocked, unlike movement's small overlap tolerance.
 */
export function createClearance(map, radius) {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new Error('Invalid clearance');
  const buckets = new Map(), size = 192;
  const add = shape => {
    const box = bounds(shape), entry = { shape, box };
    for (let y = Math.floor(box.y / size); y <= Math.floor((box.y + box.h) / size); y++)
      for (let x = Math.floor(box.x / size); x <= Math.floor((box.x + box.w) / size); x++) {
        const key = `${x},${y}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(entry);
      }
  };
  for (const obstacle of map.obstacles) add(shapeOf(obstacle));
  for (const gate of map.gates) if (!gate.open) add(shapeOf(gateShape(gate)));
  if (map.playableArea) {
    const area = map.playableArea, rows = new Map(area.rows.map(row => [row.y, row.runs]));
    for (let y = 0; y < Math.ceil(map.height / area.cellSize); y++) {
      const runs = rows.get(y) ?? [];
      let run = 0;
      for (let x = 0; x < Math.ceil(map.width / area.cellSize); x++) {
        while (run < runs.length && runs[run][1] <= x) run++;
        if (run === runs.length || runs[run][0] > x) add(rect(x * area.cellSize, y * area.cellSize, area.cellSize, area.cellSize));
      }
    }
  }
  return (a, b) => {
    if (![a.x,a.y,b.x,b.y].every(Number.isFinite)) return false;
    // Rectangle and legacy diamond are convex: endpoint disk containment suffices.
    // Mask holes are additionally tested continuously as filled void cells below.
    if (!insideMap(map, a.x, a.y, radius) || !insideMap(map, b.x, b.y, radius)) return false;
    const left = Math.min(a.x,b.x)-radius, right = Math.max(a.x,b.x)+radius;
    const top = Math.min(a.y,b.y)-radius, bottom = Math.max(a.y,b.y)+radius;
    const seen = new Set();
    for (let y = Math.floor(top/size); y <= Math.floor(bottom/size); y++)
      for (let x = Math.floor(left/size); x <= Math.floor(right/size); x++)
        for (const entry of buckets.get(`${x},${y}`) ?? []) {
          if (seen.has(entry)) continue;
          seen.add(entry);
          const box = entry.box;
          if (box.x > right || box.y > bottom || box.x+box.w < left || box.y+box.h < top) continue;
          if (segmentShapeDistance(a,b,entry.shape) <= radius + 1e-9) return false;
        }
    return true;
  };
}
