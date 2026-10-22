import { LIMITS } from '../limits.ts';
import type { Placeable } from './placeable.ts';
import { oriented } from './frame.ts';

/*
 * `wall-run`: a plain straight wall along one long edge of a strip of cells, one cell deep.
 * `wallHints` (#407) stands them along hinted perimeter runs for `hall`, `ruins` and `rubble`.
 */

/** The obstacle kinds a wall run can be. */
export const WALL_RUN_KINDS = ['building', 'ruin-wall'] as const;

export interface WallRunParams {
  /** Cells along the run. */
  length: number;
  /** Whether the run is vertical: its body is 1 × `length` cells rather than `length` × 1. */
  turned: boolean;
  /** Which long edge of the body the wall stands against: the low coordinate's or the high one's. */
  side: 'start' | 'end';
  /** Cells across the wall. */
  thickness: number;
  /** Cells between the wall and its edge. */
  inset: number;
  kind: typeof WALL_RUN_KINDS[number];
}

export const WALL_RUN = Object.freeze<Placeable<WallRunParams>>({
  id: 'wall-run',
  version: 'wall-run-1',
  summary: 'A plain straight wall along one edge of a strip of cells.',
  params: [
    { name: 'length', summary: 'Cells along the run.', kind: 'int', min: 1, max: LIMITS.run },
    { name: 'turned', summary: 'Vertical rather than horizontal.', kind: 'boolean' },
    { name: 'side', summary: 'The long edge the wall stands against.', kind: 'enum', values: ['start', 'end'] },
    { name: 'thickness', summary: 'Cells across the wall.', kind: 'number', min: 0.05, max: 1 },
    { name: 'inset', summary: 'Cells between the wall and its edge.', kind: 'number', min: 0, max: 0.95 },
    { name: 'kind', summary: 'Obstacle kind.', kind: 'enum', values: WALL_RUN_KINDS },
  ],
  check: ({ thickness, inset }) => thickness + inset > 1 ? ['wall-run thickness and inset must fit in one cell.'] : [],
  examples: [
    { length: 4, turned: false, side: 'start', thickness: 0.25, inset: 0, kind: 'building' },
    { length: 1, turned: true, side: 'end', thickness: 0.25, inset: 0.1, kind: 'ruin-wall' },
  ],
  build({ length, turned, side, thickness, inset, kind }: WallRunParams, cellSize: number) {
    const across = side === 'start' ? inset : 1 - inset - thickness;
    const shape = oriented(cellSize, !turned)(0, across, length, thickness);
    const w = turned ? 1 : length, h = turned ? length : 1;
    return { elements: [{ x: 0, y: 0, template: { w: w * cellSize, h: h * cellSize, parts: [{ part: 'obstacle' as const, shape, kind }] } }],
      demand: { body: { w, h }, clear: [] }, details: undefined };
  },
});
