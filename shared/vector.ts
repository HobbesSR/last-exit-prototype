import type { Vec2, World } from './types.ts';
import { hypot } from './math.ts';

/**
 * Distance between two world points. Sole owner: map generation, routing, hazards and the
 * simulation all measured this independently before, which is four places to disagree.
 */
export const distance = (a: Vec2, b: Vec2): World => hypot(a.x - b.x, a.y - b.y);
