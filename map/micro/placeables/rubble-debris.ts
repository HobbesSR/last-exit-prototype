import { CELL_SCALE } from '../../kernel/scale.ts';
import { rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `rubble-debris`: one square debris block, broad enough to leave a squeeze gap or narrow
 * enough for an ordinary passage. `rubble` chooses its cells and protects portal routes.
 */
export interface RubbleDebrisParams { squeeze: boolean }

export const RUBBLE_DEBRIS = Object.freeze<Placeable<RubbleDebrisParams>>({
  id: 'rubble-debris', version: 'rubble-debris-1',
  summary: 'A centred square of debris with an ordinary or squeeze gap.',
  params: [{ name: 'squeeze', summary: 'Leave the narrower gap.', kind: 'boolean' }],
  examples: [{ squeeze: true }, { squeeze: false }],
  build({ squeeze }, cellSize) {
    const width = (squeeze ? 2 - CELL_SCALE.squeeze : 0.1) * cellSize;
    const start = .5 * cellSize - width / 2;
    return { elements: [{ x: 0, y: 0, template: { w: cellSize, h: cellSize,
      parts: [{ part: 'obstacle' as const, kind: 'ruin-wall' as const, shape: rect(start, start, width, width) }] } }],
      demand: { body: { w: 1, h: 1 }, clear: [] }, details: undefined };
  },
});
