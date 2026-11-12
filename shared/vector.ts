import type { Vec2, World } from './types.ts';
import { hypot } from './math.ts';

/** Distance between two world points. */
export const distance = (a: Vec2, b: Vec2): World => hypot(a.x - b.x, a.y - b.y);
