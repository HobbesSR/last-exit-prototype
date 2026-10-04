import { CELL_SCALE } from '../../kernel/scale.ts';
import type { Run } from '../../kernel/run.ts';
import type { BuildingBoundary } from './boundaries.ts';
import type { BuildingDesign, OpeningKind } from './design.ts';

export interface PlacedBuildingOpening {
  connectionId: string;
  a: string;
  b: string;
  run: Run;
  center: number;
  length: number;
  kind: OpeningKind;
}
export interface MissedBuildingOpening { connectionId: string; reason: 'no-boundary' | 'no-fit' | 'overlap' }
export interface BuildingOpeningResult { openings: PlacedBuildingOpening[]; misses: MissedBuildingOpening[] }
export interface BuildingRunLimits { a: string; b: string; run: Run; trimStart: number; trimEnd: number }
export interface BuildingOpeningOptions { width?: number; widths?: Record<string, number>; limits?: readonly BuildingRunLimits[] }

export const sameBuildingRun = (a: Run, b: Run): boolean => a.axis === b.axis && a.x === b.x && a.y === b.y && a.length === b.length;

/** Center each requested opening on a single straight run; never cross a corner. */
export function placeBuildingOpenings(design: BuildingDesign, boundaries: readonly BuildingBoundary[], options: BuildingOpeningOptions = {}): BuildingOpeningResult {
  const openings: PlacedBuildingOpening[] = [], misses: MissedBuildingOpening[] = [];
  const width = options.width ?? CELL_SCALE.doorway;
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('Invalid opening width.');
  for (const connection of design.connections) {
    const length = options.widths && Object.hasOwn(options.widths, connection.id) ? options.widths[connection.id]! : width;
    if (!Number.isFinite(length) || length <= 0) throw new RangeError(`Invalid opening width for ${connection.id}.`);
    const boundary = boundaries.find(pair => pair.a === connection.a && pair.b === connection.b || pair.a === connection.b && pair.b === connection.a);
    if (!boundary) { misses.push({ connectionId: connection.id, reason: 'no-boundary' }); continue; }
    const candidates = boundary.runs.map((run, i) => ({ run, i })).filter(({ i }) => !connection.side || boundary.runSides[i] === connection.side)
      .sort((a, b) => b.run.length - a.run.length || a.i - b.i);
    let reason: MissedBuildingOpening['reason'] = 'no-fit', found = false;
    for (const { run } of candidates) {
      const limit = options.limits?.find(item => item.a === boundary.a && item.b === boundary.b && sameBuildingRun(item.run, run));
      const start = limit?.trimStart ?? 0, end = run.length - (limit?.trimEnd ?? 0);
      if (![start, end].every(Number.isFinite) || start < 0 || end > run.length || end < start) throw new RangeError('Invalid opening run limits.');
      if (end - start < length) continue;
      const center = (start + end) / 2;
      const taken = openings.some(opening => opening.a === boundary.a && opening.b === boundary.b
        && sameBuildingRun(opening.run, run)
        && Math.abs(opening.center - center) < (opening.length + length) / 2);
      if (taken) { reason = 'overlap'; continue; }
      openings.push({ connectionId: connection.id, a: boundary.a, b: boundary.b, run, center, length, kind: connection.kind });
      found = true; break;
    }
    if (!found) misses.push({ connectionId: connection.id, reason });
  }
  return { openings, misses };
}
