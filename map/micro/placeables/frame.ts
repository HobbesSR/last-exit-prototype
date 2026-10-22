import { rect } from '../../../shared/shape.ts';
import type { Shape } from '../../../shared/shape.ts';

/** Maps a local (u, v) box in cells to a world-unit rect in the template's frame: u along x when `alongX`, else along y. */
export const oriented = (size: number, alongX: boolean) => (u: number, v: number, length: number, width: number): Shape =>
  alongX ? rect(u * size, v * size, length * size, width * size) : rect(v * size, u * size, width * size, length * size);
