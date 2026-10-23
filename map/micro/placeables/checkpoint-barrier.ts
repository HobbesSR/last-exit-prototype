import { rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `checkpoint-barrier`: a thin ruin wall across a checkpoint's crossing line. `checkpoint`
 * chooses the side, reach, and exact site of each barrier.
 */
export interface CheckpointBarrierParams { w: number; h: number }

export const CHECKPOINT_BARRIER = Object.freeze<Placeable<CheckpointBarrierParams>>({
  id: 'checkpoint-barrier', version: 'checkpoint-barrier-1',
  summary: 'A thin ruin wall across a checkpoint crossing.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'number', min: 0.05, max: 1000 },
    { name: 'h', summary: 'Height in cells.', kind: 'number', min: 0.05, max: 1000 },
  ],
  examples: [{ w: 0.5, h: 3 }, { w: 4, h: 0.5 }],
  build({ w, h }, cellSize) {
    const width = w * cellSize, height = h * cellSize;
    return { elements: [{ x: 0, y: 0, template: { w: width, h: height,
      parts: [{ part: 'obstacle' as const, kind: 'ruin-wall' as const, shape: rect(0, 0, width, height) }] } }],
      demand: { body: { w, h }, clear: [] }, details: undefined };
  },
});
