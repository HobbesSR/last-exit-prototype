import { rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `hall-pillar`: one building-kind pillar inset into a two-cell block. `hall` chooses
 * the lattice, skipped route cells, and enclosing roof.
 */
const BLOCK = 2;
export const HALL_PILLAR_INSET = 0.25;

export const HALL_PILLAR = Object.freeze<Placeable<Record<string, never>>>({
  id: 'hall-pillar', version: 'hall-pillar-1',
  summary: 'A square building pillar inset into a two-cell block.',
  params: [], examples: [{}],
  build(_params, cellSize) {
    const span = (BLOCK - 2 * HALL_PILLAR_INSET) * cellSize;
    return { elements: [{ x: 0, y: 0, template: { w: BLOCK * cellSize, h: BLOCK * cellSize,
      parts: [{ part: 'obstacle' as const, kind: 'building' as const,
        shape: rect(HALL_PILLAR_INSET * cellSize, HALL_PILLAR_INSET * cellSize, span, span) }] } }],
      demand: { body: { w: BLOCK, h: BLOCK }, clear: [] }, details: undefined };
  },
});
