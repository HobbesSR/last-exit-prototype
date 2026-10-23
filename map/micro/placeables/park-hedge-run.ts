import { rect } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `park-hedge-run`: two hedge stubs around a doorway-wide gap. `park` sites these across slots.
 */

const THICK = 0.4;
const thousandth = (value: number) => Math.round(value * 1000) / 1000;
export interface ParkHedgeRunParams { length: number; gap: number; aisle: number; across: boolean }

export const PARK_HEDGE_RUN = Object.freeze<Placeable<ParkHedgeRunParams>>({
  id: 'park-hedge-run', version: 'park-hedge-run-1', summary: 'A hedge with a doorway gap.',
  params: [
    { name: 'length', summary: 'Length in cells.', kind: 'int', min: 2, max: 512 },
    { name: 'gap', summary: 'Gap start in cells.', kind: 'int', min: 1, max: 511 },
    { name: 'aisle', summary: 'Gap width in cells.', kind: 'int', min: 1, max: 32 },
    { name: 'across', summary: 'Horizontal run.', kind: 'boolean' },
  ],
  check: ({ length, gap, aisle }) => gap + aisle >= length ? ['park-hedge-run needs a stub after the gap.'] : [],
  examples: [{ length: 10, gap: 3, aisle: 2, across: true }, { length: 10, gap: 5, aisle: 2, across: false }],
  build({ length, gap, aisle, across }, cellSize) {
    const stubs: [number, number][] = [[0, gap], [gap + aisle, length]];
    const parts = stubs.map(([s, e]) => ({ part: 'obstacle' as const, kind: 'hedge' as const,
      shape: across ? rect(s * cellSize, thousandth((0.5 - THICK / 2) * cellSize), (e - s) * cellSize, thousandth(THICK * cellSize))
        : rect(thousandth((0.5 - THICK / 2) * cellSize), s * cellSize, thousandth(THICK * cellSize), (e - s) * cellSize) }));
    const w = across ? length : 1, h = across ? 1 : length;
    return { elements: [{ x: 0, y: 0, template: { w: w * cellSize, h: h * cellSize, parts } }],
      demand: { body: { w, h }, clear: [] }, details: undefined };
  },
});
