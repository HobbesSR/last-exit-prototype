import { elementShapes } from '../../map/micro/geometry.ts';
import { bounds } from '../../shared/shape.ts';
import { briefOf, SIZE, MASKS } from './region-masks.js';

export { SIZE };
export const brief = briefOf('plant');

/** A yard, a wide field, an L, and a ring around a hole, with portals on several sides (shared with depot and park). */
export { MASKS };
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
