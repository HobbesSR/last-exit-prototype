import { rect } from '../../../shared/shape.ts';
import type { ElementPart } from '../../../shared/map/element.ts';
import type { Run } from '../../kernel/run.ts';
import { isCellSize } from '../../kernel/scale.ts';

/** An opening along a run, measured in cells from its beginning. */
export interface WallOpening {
  center: number;
  length: number;
  kind: 'door' | 'window' | 'open';
}

export interface WallRunOptions {
  /** World units a cell: a whole number (`isCellSize`). */
  cellSize: number;
  /** Thickness in cells. */
  thickness: number;
  /** Shift from the guide towards +y on a horizontal run or +x on a vertical run, in cells. */
  offset: number;
  /** Corner ownership: omit geometry at the beginning or end, in cells. */
  trimStart?: number;
  trimEnd?: number;
  openings?: readonly WallOpening[];
}

/** Turn one straight boundary guide into building walls and its openings. No input is mutated. */
export function emitWallRun(run: Run, options: WallRunOptions): ElementPart[] {
  const { cellSize, thickness, offset, trimStart = 0, trimEnd = 0 } = options;
  const finite = (n: number) => Number.isFinite(n);
  if ((run.axis !== 'h' && run.axis !== 'v') || ![run.x, run.y, run.length, thickness, offset, trimStart, trimEnd].every(finite)
    || !isCellSize(cellSize) || run.length <= 0 || thickness <= 0 || trimStart < 0 || trimEnd < 0 || trimStart + trimEnd > run.length)
    throw new RangeError('Invalid wall run or dimensions.');

  const openings = [...(options.openings ?? [])].sort((a, b) => a.center - b.center);
  let previous = trimStart;
  for (const opening of openings) {
    const start = opening.center - opening.length / 2, end = opening.center + opening.length / 2;
    if (!finite(opening.center) || !finite(opening.length) || opening.length <= 0
      || !['door', 'window', 'open'].includes(opening.kind)
      || start < previous || end > run.length - trimEnd)
      throw new RangeError('Wall openings must be positive, disjoint, and inside the trimmed run.');
    previous = end;
  }

  // Lengths are computed in cells, then scaled: with a whole-number cell size that is exact.
  const scale = (n: number) => n * cellSize;
  const along = run.axis === 'h' ? run.x : run.y, guide = run.axis === 'h' ? run.y : run.x;
  const across = scale(guide + offset), gateAcross = scale(guide + offset + thickness / 2);
  const parts: ElementPart[] = [];
  const wall = (a: number, b: number, kind: 'building' | 'window') => {
    if (b <= a) return;
    const start = scale(along + a), length = scale(b - a);
    const shape = run.axis === 'h' ? rect(start, across, length, scale(thickness)) : rect(across, start, scale(thickness), length);
    parts.push({ part: 'obstacle', shape, kind });
  };
  let cursor = trimStart;
  for (const opening of openings) {
    const start = opening.center - opening.length / 2, end = opening.center + opening.length / 2;
    wall(cursor, start, 'building');
    if (opening.kind === 'window') wall(start, end, 'window');
    else if (opening.kind === 'door') parts.push(run.axis === 'h'
      ? { part: 'gate', x: scale(along + opening.center), y: gateAcross, w: scale(opening.length), h: scale(thickness) }
      : { part: 'gate', x: gateAcross, y: scale(along + opening.center), w: scale(thickness), h: scale(opening.length) });
    cursor = end;
  }
  wall(cursor, run.length - trimEnd, 'building');
  return parts;
}
