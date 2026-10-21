import { cellKey, compareCells, type Cell } from './cell.ts';
import type { Run } from './run.ts';
import type { RegionBrief } from './contract.ts';

const ordered = (cells: Iterable<Cell>): Cell[] => [...cells].sort(compareCells);

/** Refuse a run that isn't whole cells, a positive whole length and an axis. */
function checkRun(run: Run): void {
  if (!run || !Number.isSafeInteger(run.x) || !Number.isSafeInteger(run.y)) throw new Error('Guaranteed run needs whole cell coordinates.');
  if (!Number.isSafeInteger(run.length) || run.length < 1) throw new Error('Guaranteed run needs positive whole length.');
  if (run.axis !== 'h' && run.axis !== 'v') throw new Error(`Invalid guaranteed run axis ${run.axis}`);
}

/** The clipped, cell-aligned union around resolved guaranteed runs (20.6). */
export function clearFootprint(runs: readonly Run[], playableCells: readonly Cell[]): Cell[] {
  const playable = new Set(playableCells.map(cellKey));
  const found = new Map<string, Cell>();
  const add = (x: number, y: number): void => {
    const cell = { x, y }, k = cellKey(cell);
    if (playable.has(k)) found.set(k, cell);
  };
  for (const run of runs) {
    checkRun(run);
    if (run.axis === 'h') {
      for (let x = run.x - 1; x <= run.x + run.length; x++) {
        add(x, run.y - 1);
        add(x, run.y);
      }
    } else {
      for (let y = run.y - 1; y <= run.y + run.length; y++) {
        add(run.x - 1, y);
        add(run.x, y);
      }
    }
  }
  return ordered(found.values());
}

/** The parts of a brief that its clear margins come from and go to. */
export type MarginRegion = Pick<RegionBrief, 'cells' | 'portals' | 'internalGuaranteed' | 'fillCells' | 'clearCells'>;

/**
 * A region with its margins. Macro's briefs carry them, from the whole map. A region that
 * arrives without them (one built by hand, or a standalone child) derives them from its own
 * portals and internal runs, knowing only its cells and the one-cell strip across each
 * portal: end caps past the portal's span are left out, since nothing says that space
 * is playable (20.6). Margins already carried are kept and never inset again.
 */
export function withClearMargins<R extends MarginRegion>(region: R): R & Required<Pick<RegionBrief, 'fillCells' | 'clearCells'>> {
  if (region.fillCells !== undefined && region.clearCells !== undefined) return region as R & Required<Pick<RegionBrief, 'fillCells' | 'clearCells'>>;
  // Malformed runs are refused before any expansion, and each run is clipped to the cells'
  // extent, so the work is bounded by the region, never by a run's stated length. A run on
  // the region's perimeter lies within that extent, so clipping changes no valid footprint.
  const runs = [...region.portals, ...(region.internalGuaranteed ?? [])];
  runs.forEach(checkRun);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of region.cells) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  const clip = (run: Run): Run[] => {
    const [lo, hi] = run.axis === 'h' ? [minX, maxX] : [minY, maxY];
    const start = run.axis === 'h' ? run.x : run.y, from = Math.max(start, lo - 1), to = Math.min(start + run.length - 1, hi + 1);
    if (from > to) return [];
    return [run.axis === 'h' ? { ...run, x: from, length: to - from + 1 } : { ...run, y: from, length: to - from + 1 }];
  };
  const portals = region.portals.flatMap(clip), playable = [...region.cells];
  for (const { axis, x, y, length } of portals) for (let i = 0; i < length; i++) {
    if (axis === 'h') playable.push({ x: x + i, y: y - 1 }, { x: x + i, y });
    else playable.push({ x: x - 1, y: y + i }, { x, y: y + i });
  }
  const fill = region.fillCells && new Set(region.fillCells.map(cellKey));
  const inherited = [...(region.clearCells ?? []), ...(fill ? region.cells.filter(cell => !fill.has(cellKey(cell))) : [])];
  return { ...region, ...applyClearConstraints(region.cells,
    clearFootprint([...portals, ...(region.internalGuaranteed ?? []).flatMap(clip)], playable), inherited) };
}

/** Apply inherited and new constraints once, preserving original ownership. */
export function applyClearConstraints(
  cells: readonly Cell[], clearCells: readonly Cell[], inheritedClear: readonly Cell[] = [],
): { fillCells: Cell[]; clearCells: Cell[] } {
  const owned = new Set(cells.map(cellKey));
  const clear = new Map<string, Cell>();
  for (const cell of [...inheritedClear, ...clearCells]) {
    let nearby = false;
    for (let dy = -1; dy <= 1 && !nearby; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (owned.has(`${cell.x + dx},${cell.y + dy}`)) { nearby = true; break; }
    }
    if (nearby) clear.set(cellKey(cell), cell);
  }
  return {
    fillCells: ordered(cells.filter((cell) => !clear.has(cellKey(cell)))),
    clearCells: ordered(clear.values()),
  };
}
