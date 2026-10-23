import { rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `plant-pipe-run`: two pipe stubs meeting machines around a doorway gap. `plant` sites runs.
 */

const SEAT = 0.5, PIPE = 0.3;
export interface PlantPipeRunParams { length: number; gap: number; aisle: number; across: boolean }

export const PLANT_PIPE_RUN = Object.freeze<Placeable<PlantPipeRunParams>>({
  id: 'plant-pipe-run', version: 'plant-pipe-run-1', summary: 'A pipe between machines with a doorway gap.',
  params: [
    { name: 'length', summary: 'Distance between machines in cells.', kind: 'int', min: 1, max: 512 },
    { name: 'gap', summary: 'Gap start in cells.', kind: 'int', min: 0, max: 512 },
    { name: 'aisle', summary: 'Gap width in cells.', kind: 'int', min: 1, max: 32 },
    { name: 'across', summary: 'Horizontal run.', kind: 'boolean' },
  ],
  check: ({ length, gap, aisle }) => gap + aisle > length ? ['plant-pipe-run gap exceeds its length.'] : [],
  examples: [{ length: 5, gap: 2, aisle: 2, across: true }, { length: 7, gap: 3, aisle: 2, across: false }],
  build({ length, gap, aisle, across }, cellSize) {
    const stubs: [number, number][] = [[-SEAT, gap], [gap + aisle, length + SEAT]];
    const parts = stubs.filter(([s, e]) => e - s > SEAT).map(([s, e]) => ({ part: 'obstacle' as const, kind: 'pipe' as const,
      shape: across ? rect((s + SEAT) * cellSize, (0.5 - PIPE / 2) * cellSize, (e - s) * cellSize, PIPE * cellSize)
        : rect((0.5 - PIPE / 2) * cellSize, (s + SEAT) * cellSize, PIPE * cellSize, (e - s) * cellSize) }));
    const w = across ? length + 2 * SEAT : 1, h = across ? 1 : length + 2 * SEAT;
    return { elements: [{ x: 0, y: 0, template: { w: w * cellSize, h: h * cellSize, parts } }],
      demand: { body: { w, h }, clear: [] }, details: undefined };
  },
});
