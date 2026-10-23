import { polygon } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `fallen-slab`: a convex rotated span of a collapsed ruin wall. `ruins` chooses which
 * wall cells collapse and which slabs survive its protected routes.
 */
export interface FallenSlabParams { turn: number; length: number }
const WALL = 0.25;

export const FALLEN_SLAB = Object.freeze<Placeable<FallenSlabParams>>({
  id: 'fallen-slab', version: 'fallen-slab-1',
  summary: 'A rotated convex slab of fallen wall inside one cell.',
  params: [
    { name: 'turn', summary: 'Half-turn angle from zero to one.', kind: 'number', min: 0, max: 1 },
    { name: 'length', summary: 'Slab length variation.', kind: 'number', min: 0, max: 1 },
  ],
  examples: [{ turn: 0, length: 0 }, { turn: 0.37, length: 0.8 }],
  build({ turn, length }, cellSize) {
    const angle = turn * Math.PI, long = cellSize * (.55 + length * .25), wide = cellSize * WALL * 1.2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({
      x: round(u! * long / 2 * cos - v! * wide / 2 * sin), y: round(u! * long / 2 * sin + v! * wide / 2 * cos) }));
    const shape = polygon(.5 * cellSize, .5 * cellSize, points);
    return { elements: [{ x: 0, y: 0, template: { w: cellSize, h: cellSize,
      parts: [{ part: 'obstacle' as const, kind: 'ruin-wall' as const, shape }] } }],
      demand: { body: { w: 1, h: 1 }, clear: [] }, details: undefined };
  },
});
