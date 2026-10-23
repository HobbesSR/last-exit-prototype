import { circle } from '../../../shared/shape.ts';
import type { Placeable } from './placeable.ts';

/*
 * `park-tree`: a round soft-cover tree in a two-cell footprint. `park` arranges these in clumps.
 */

const TREE = 2, REACH = 0.75;
const thousandth = (value: number) => Math.round(value * 1000) / 1000;

export const PARK_TREE = Object.freeze<Placeable<Record<string, never>>>({
  id: 'park-tree', version: 'park-tree-1', summary: 'A round tree giving soft cover.',
  params: [], examples: [{}],
  build(_params, cellSize) {
    const middle = TREE * cellSize / 2;
    return { elements: [{ x: 0, y: 0, template: { w: TREE * cellSize, h: TREE * cellSize,
      parts: [{ part: 'obstacle' as const, kind: 'tree' as const, shape: circle(middle, middle, thousandth(REACH * cellSize)) }] } }],
      demand: { body: { w: TREE, h: TREE }, clear: [] }, details: undefined };
  },
});
