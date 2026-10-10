import type { Cell } from './cell.ts';
import type { Run } from './run.ts';

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
