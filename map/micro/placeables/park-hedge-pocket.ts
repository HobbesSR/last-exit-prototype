import { rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `park-hedge-pocket`: a fixed hedge enclosure with an east-facing opening. `park` sites it.
 */

export const PARK_HEDGE_POCKET = Object.freeze<Placeable<Record<string, never>>>({
  id: 'park-hedge-pocket', version: 'park-hedge-pocket-1', summary: 'A hedge pocket with an east opening.',
  params: [],
  examples: [{}],
  build(_params, cellSize) {
    const walls = [
      [0, 0, 1, 14], [1, 0, 13, 1], [1, 13, 13, 1],
      [13, 1, 1, 4.75], [13, 8.25, 1, 4.75],
    ];
    const parts = walls.map(([x, y, w, h]) => ({ part: 'obstacle' as const, kind: 'hedge' as const,
      shape: rect(x * cellSize, y * cellSize, w * cellSize, h * cellSize) }));
    return { elements: [{ x: 0, y: 0, template: { w: 14 * cellSize, h: 14 * cellSize, parts } }],
      demand: { body: { w: 14, h: 14 }, clear: [] }, details: undefined };
  },
});
