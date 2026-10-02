import type { Cell } from './types.ts';

/**
 * The SDK's tool limits (20). They bound the work one call can do; they aren't contract
 * rules or match dimensions, so macro never reads them. They are sized for macro's regions
 * (17 M7): a layout region may be a whole map's open ground, hundreds of cells across with
 * hundreds of portals, and a map composes hundreds of regions.
 */
export const LIMITS = Object.freeze({
  /** Every cell address lies within this many cells of the origin on each axis. */
  address: 512,
  /** One region's cells. */
  regionCells: 65_536,
  /** One region's extent, in cells per axis. */
  regionSpan: 512,
  /** One region's portals, or its ports. */
  portals: 4_096,
  /** One portal's or port's run, in segments. */
  run: 512,
  /** The regions one composition joins. */
  mapRegions: 4_096,
});

/**
 * Check one region's cells against the limits and return them in row order: whole
 * addresses, no duplicates, the bounded span, and one four-connected area.
 */
export function checkedRegionCells(cells: readonly Cell[]): Cell[] {
  if (!Array.isArray(cells) || !cells.length || cells.length > LIMITS.regionCells) throw new Error(`A region needs 1 to ${LIMITS.regionCells} cells.`);
  if (cells.some(c => !c || !Number.isInteger(c.x) || !Number.isInteger(c.y) || Math.abs(c.x) > LIMITS.address || Math.abs(c.y) > LIMITS.address)) throw new Error(`Cell addresses must be integers between -${LIMITS.address} and ${LIMITS.address}.`);
  const sorted = cells.map(c => ({ x: c.x, y: c.y })).sort((a, b) => a.y - b.y || a.x - b.x), keys = new Set(sorted.map(c => `${c.x},${c.y}`));
  if (keys.size !== sorted.length) throw new Error('Duplicate region cell.');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of sorted) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  if (maxX - minX >= LIMITS.regionSpan || maxY - minY >= LIMITS.regionSpan) throw new Error(`A region may span at most ${LIMITS.regionSpan} cells per axis.`);
  const seen = new Set<string>([`${sorted[0]!.x},${sorted[0]!.y}`]), queue = [sorted[0]!];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const key = `${c.x + dx},${c.y + dy}`;
      if (keys.has(key) && !seen.has(key)) { seen.add(key); queue.push({ x: c.x + dx, y: c.y + dy }); }
    }
  }
  if (seen.size !== keys.size) throw new Error('Region cells must form one connected area.');
  return sorted;
}
