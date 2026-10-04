import { rect } from '../../../shared/shape.ts';
import type { ElementPart } from '../../../shared/map/element.ts';
import type { Run } from '../../kernel/run.ts';

/** An opening along a run, measured in cells from its beginning. */
export interface WallOpening {
  center: number;
  length: number;
  kind: 'door' | 'window' | 'open';
}

export interface WallRunOptions {
  cellSize: number;
  /** Thickness in cells. */
  thickness: number;
  /** Shift from the guide towards +y on a horizontal run or +x on a vertical run, in cells. */
  offset: number;
  /** Corner ownership: omit geometry at the beginning or end, in cells. */
  trimStart?: number;
  trimEnd?: number;
  openings?: readonly WallOpening[];
  /** Compute rectangle lengths after scaling endpoints. Preserves templates authored in world units. */
  arithmetic?: 'cells' | 'world';
}

/** Turn one straight boundary guide into building walls and its openings. No input is mutated. */
export function emitWallRun(run: Run, options: WallRunOptions): ElementPart[] {
  const { cellSize, thickness, offset, trimStart = 0, trimEnd = 0 } = options;
  const finite = (n: number) => Number.isFinite(n);
  if ((run.axis !== 'h' && run.axis !== 'v') || ![run.x, run.y, run.length, cellSize, thickness, offset, trimStart, trimEnd].every(finite)
    || (options.arithmetic !== undefined && options.arithmetic !== 'cells' && options.arithmetic !== 'world')
    || run.length <= 0 || cellSize <= 0 || thickness <= 0 || trimStart < 0 || trimEnd < 0 || trimStart + trimEnd > run.length)
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

  const world = options.arithmetic === 'world', scale = (n: number) => n * cellSize;
  const along = run.axis === 'h' ? run.x : run.y, guide = run.axis === 'h' ? run.y : run.x;
  const alongWorld = scale(along), spanWorld = scale(run.length);
  const across = world ? scale(guide) + scale(offset) : scale(guide + offset);
  const gateAcross = world ? scale(guide) + scale(offset + thickness / 2) : scale(guide + offset + thickness / 2);
  const parts: ElementPart[] = [];
  const wall = (a: number, b: number, worldA: number, worldB: number, kind: 'building' | 'window') => {
    if (b <= a) return;
    const start = world ? worldA : scale(along + a), length = world ? worldB - worldA : scale(b - a);
    const shape = run.axis === 'h' ? rect(start, across, length, scale(thickness)) : rect(across, start, scale(thickness), length);
    parts.push({ part: 'obstacle', shape, kind });
  };
  let cursor = trimStart, cursorWorld = alongWorld + scale(trimStart);
  for (const opening of openings) {
    const start = opening.center - opening.length / 2, end = opening.center + opening.length / 2;
    const centerWorld = alongWorld + scale(opening.center), halfWorld = scale(opening.length) / 2;
    const startWorld = centerWorld - halfWorld, endWorld = centerWorld + halfWorld;
    wall(cursor, start, cursorWorld, startWorld, 'building');
    if (opening.kind === 'window') wall(start, end, startWorld, endWorld, 'window');
    else if (opening.kind === 'door') parts.push(run.axis === 'h'
      ? { part: 'gate', x: world ? centerWorld : scale(along + opening.center), y: gateAcross, w: scale(opening.length), h: scale(thickness) }
      : { part: 'gate', x: gateAcross, y: world ? centerWorld : scale(along + opening.center), w: scale(thickness), h: scale(opening.length) });
    cursor = end; cursorWorld = endWorld;
  }
  wall(cursor, run.length - trimEnd, cursorWorld, alongWorld + spanWorld - scale(trimEnd), 'building');
  return parts;
}
