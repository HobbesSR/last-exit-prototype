import type { Decal } from '../../../shared/types.ts';
import { ROOF_OVERHANG } from '../../../shared/view.ts';
import { OUTSIDE } from './design.ts';
import type { PlacedBuildingOpening } from './openings.ts';

/** How far a decal shows beyond the roof's overhang, in cells (56.2). */
export const DECAL_REACH = 0.25;

/** A door or window that opens to the outside: what a decal marks. Open sides and interior openings aren't. */
export const marksOpening = ({ kind, a, b }: PlacedBuildingOpening): boolean => kind !== 'open' && (a === OUTSIDE) !== (b === OUTSIDE);

/**
 * A ground decal for every door and window that opens to the outside, in opening order, in the
 * frame whose origin is cell `x0`,`y0`. Each spans its opening and reaches out from the footprint's edge past the roof's
 * overhang, so it shows while the roof is drawn.
 */
export function openingDecals(
  openings: readonly PlacedBuildingOpening[],
  footprint: readonly { x: number; y: number }[],
  x0: number,
  y0: number,
  cellSize: number,
  theme: string,
): Decal[] {
  const cells = new Set(footprint.map(c => `${c.x},${c.y}`));
  const depth = ROOF_OVERHANG + DECAL_REACH * cellSize;
  const decals: Decal[] = [];
  for (const opening of openings) {
    if (!marksOpening(opening)) continue;
    const { run, center, length } = opening, kind = opening.kind as Decal['marks'];
    const start = center - length / 2, cell = Math.floor(center);
    if (run.axis === 'h') {
      const south = cells.has(`${run.x + cell},${run.y - 1}`), edge = (run.y - y0) * cellSize;
      decals.push({ theme, marks: kind, side: south ? 'S' : 'N', x: (run.x - x0 + start) * cellSize, y: south ? edge : edge - depth, w: length * cellSize, h: depth });
    } else {
      const east = cells.has(`${run.x - 1},${run.y + cell}`), edge = (run.x - x0) * cellSize;
      decals.push({ theme, marks: kind, side: east ? 'E' : 'W', x: east ? edge : edge - depth, y: (run.y - y0 + start) * cellSize, w: depth, h: length * cellSize });
    }
  }
  return decals;
}
