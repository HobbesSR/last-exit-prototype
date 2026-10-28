import { oriented } from './frame.ts';
import type { Placeable } from './placeable.ts';

/*
 * `market-stall`: a low counter beneath an optional open-sided awning.
 */
export interface MarketStallParams {
  length: number;
  alongX: boolean;
  flipped: boolean;
  roofed: boolean;
}

export const MARKET_STALL = Object.freeze<Placeable<MarketStallParams>>({
  id: 'market-stall',
  version: 'market-stall-1',
  summary: 'A counter at one edge of a two-cell-deep stall, with an optional awning.',
  params: [
    { name: 'length', summary: 'Counter length in cells.', kind: 'int', min: 2, max: 4 },
    { name: 'alongX', summary: 'Counter runs along x rather than y.', kind: 'boolean' },
    { name: 'flipped', summary: 'Counter stands at the far edge rather than the near edge.', kind: 'boolean' },
    { name: 'roofed', summary: 'Open-sided awning over the stall.', kind: 'boolean' },
  ],
  examples: [
    { length: 4, alongX: true, flipped: false, roofed: true },
    { length: 2, alongX: false, flipped: true, roofed: false },
  ],
  build({ length, alongX, flipped, roofed }: MarketStallParams, cellSize: number) {
    const box = oriented(cellSize, alongX), w = alongX ? length : 2, h = alongX ? 2 : length;
    const cells = Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
    return {
      elements: [{ x: 0, y: 0, template: {
        w: w * cellSize, h: h * cellSize,
        parts: [{ part: 'obstacle', kind: 'crate', shape: box(0.1, flipped ? 1.1 : 0.1, length - 0.2, 0.8) }],
        ...(roofed ? { roofs: [{ id: 'awning', cellSize, cells, overhang: 0 }] } : {}),
      } }],
      demand: { body: { w, h }, clear: [] }, details: undefined,
    };
  },
});
