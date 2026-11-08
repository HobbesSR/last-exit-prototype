import { rect } from '../../../shared/shape.ts';
import type { ObstacleAppearance } from '../../../shared/types.ts';
import type { Placeable } from './placeable.ts';

/*
 * `park-hedge-block`: hedge filling a box of whole cells. `park` grows these as fronts and fills
 * ground they seal off (#649).
 */

export interface ParkHedgeBlockParams {
  w: number;
  h: number;
  appearance?: ObstacleAppearance | undefined;
}

export const PARK_HEDGE_BLOCK = Object.freeze<Placeable<ParkHedgeBlockParams>>({
  id: 'park-hedge-block', version: 'park-hedge-block-1', summary: 'Hedge filling a box of whole cells.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'int', min: 1, max: 512 },
    { name: 'h', summary: 'Height in cells.', kind: 'int', min: 1, max: 512 },
  ],
  examples: [{ w: 1, h: 8 }, { w: 5, h: 1 }],
  build({ w, h, appearance }, cellSize) {
    const parts = [{ part: 'obstacle' as const, kind: 'hedge' as const, shape: rect(0, 0, w * cellSize, h * cellSize),
      ...(appearance ? { appearance } : {}) }];
    return { elements: [{ x: 0, y: 0, template: { w: w * cellSize, h: h * cellSize, parts } }],
      demand: { body: { w, h }, clear: [] }, details: undefined };
  },
});
