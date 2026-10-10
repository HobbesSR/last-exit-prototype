import type { Cell } from './cell.ts';
import type { Run } from './run.ts';
import type { RegionBrief } from './contract.ts';

const key = ({ x, y }: Cell): string => `${x},${y}`;
const ordered = (cells: Iterable<Cell>): Cell[] => [...cells].sort((a, b) => a.y - b.y || a.x - b.x);

/** The clipped, cell-aligned union around resolved guaranteed runs (20.6). */
export function clearFootprint(runs: readonly Run[], playableCells: readonly Cell[]): Cell[] {
  const playable = new Set(playableCells.map(key));
  const found = new Map<string, Cell>();
  const add = (x: number, y: number): void => {
    const cell = { x, y }, k = key(cell);
    if (playable.has(k)) found.set(k, cell);
  };
  for (const run of runs) {
    if (!Number.isSafeInteger(run.x) || !Number.isSafeInteger(run.y)) throw new Error('Guaranteed run needs whole cell coordinates.');
    if (!Number.isSafeInteger(run.length) || run.length < 1) throw new Error('Guaranteed run needs positive whole length.');
    if (run.axis !== 'h' && run.axis !== 'v') throw new Error(`Invalid guaranteed run axis ${run.axis}`);
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
  const playable = [...region.cells];
  for (const { axis, x, y, length } of region.portals) for (let i = 0; i < length; i++) {
    if (axis === 'h') playable.push({ x: x + i, y: y - 1 }, { x: x + i, y });
    else playable.push({ x: x - 1, y: y + i }, { x, y: y + i });
  }
  const fill = region.fillCells && new Set(region.fillCells.map(key));
  const inherited = [...(region.clearCells ?? []), ...(fill ? region.cells.filter(cell => !fill.has(key(cell))) : [])];
  return { ...region, ...applyClearConstraints(region.cells,
    clearFootprint([...region.portals, ...(region.internalGuaranteed ?? [])], playable), inherited) };
}

/** Apply inherited and new constraints once, preserving original ownership. */
export function applyClearConstraints(
  cells: readonly Cell[], clearCells: readonly Cell[], inheritedClear: readonly Cell[] = [],
): { fillCells: Cell[]; clearCells: Cell[] } {
  const owned = new Set(cells.map(key));
  const clear = new Map<string, Cell>();
  for (const cell of [...inheritedClear, ...clearCells]) {
    let nearby = false;
    for (let dy = -1; dy <= 1 && !nearby; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (owned.has(`${cell.x + dx},${cell.y + dy}`)) { nearby = true; break; }
    }
    if (nearby) clear.set(key(cell), cell);
  }
  return {
    fillCells: ordered(cells.filter((cell) => !clear.has(key(cell)))),
    clearCells: ordered(clear.values()),
  };
}
