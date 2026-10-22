import { cellKey, type Cell } from '../kernel/cell.ts';
import { bounds, rect } from '../../shared/shape.ts';
import type { Shape } from '../../shared/shape.ts';
import { shapesOverlap, validShape } from './geometry.ts';
import { unusedComponents } from './components.ts';
import type { RegionMask } from './types.ts';

const EPS = 1e-7;

/**
 * What a builder has addressed with intent (#404, 20.2): the areas it built into or chose to
 * leave as they are. It is not occupancy or reachability; a deliberately empty court is
 * addressed. Areas are `shape.ts` shapes and never overlap one another, though several may
 * share a cell. A cell is either unaddressed, touched by no area, or addressed by any area
 * that overlaps it, so a sliver keeps its cell with that cell's owner (20.7 D2).
 */
export interface AddressedArea {
  /** Owned cells, in the order the record was made with; queries follow it. */
  readonly cells: readonly Cell[];
  /** Every recorded area, in the order it was marked. */
  readonly areas: readonly Shape[];
  /**
   * Record an area. It addresses only owned cells it overlaps with positive area; touching an
   * edge doesn't. An area overlapping an earlier one is refused and nothing is recorded.
   */
  mark(shape: Shape): boolean;
  /** Record each owned cell's square as an area, all or none. Unowned cells are skipped. */
  markCells(cells: Iterable<Cell>): boolean;
  addressed(x: number, y: number): boolean;
  /** Owned cells no area touches, in owned order. */
  unaddressed(): Cell[];
  /** The 4-connected components of unaddressed cells, as `unusedComponents` walks them. */
  unaddressedComponents(): Cell[][];
}

/** A fresh record over a mask's owned cells. Pure: it draws no random numbers and allocates no IDs. */
export function createAddressedArea(mask: Pick<RegionMask, 'cells' | 'cellSize' | 'has'>): AddressedArea {
  const size = mask.cellSize, areas: Shape[] = [];
  // The areas touching each owned cell: the overlap check and the cell queries read this index.
  const byCell = new Map<string, Shape[]>();
  const touched = (shape: Shape): string[] => {
    const b = bounds(shape), keys: string[] = [];
    for (let y = Math.floor((b.y + EPS) / size); y <= Math.floor((b.y + b.h - EPS) / size); y++) {
      for (let x = Math.floor((b.x + EPS) / size); x <= Math.floor((b.x + b.w - EPS) / size); x++) {
        if (mask.has(x, y) && shapesOverlap(shape, rect(x * size, y * size, size, size))) keys.push(cellKey({ x, y }));
      }
    }
    return keys;
  };
  const free = (shape: Shape, keys: readonly string[]) => keys.every(k => !byCell.get(k)?.some(o => shapesOverlap(shape, o)));
  const record = (shape: Shape, keys: readonly string[]) => {
    areas.push(shape);
    for (const k of keys) { const list = byCell.get(k); if (list) list.push(shape); else byCell.set(k, [shape]); }
  };
  return {
    cells: mask.cells, areas,
    mark(shape) {
      if (!validShape(shape)) throw new Error('An addressed area must be a valid convex shape.');
      const keys = touched(shape);
      if (!free(shape, keys)) return false;
      record(shape, keys);
      return true;
    },
    markCells(cells) {
      const squares: Array<[Shape, string]> = [], seen = new Set<string>();
      for (const c of cells) {
        const k = cellKey(c);
        if (!mask.has(c.x, c.y) || seen.has(k)) continue;
        seen.add(k);
        const square = rect(c.x * size, c.y * size, size, size);
        if (!free(square, [k])) return false;
        squares.push([square, k]);
      }
      for (const [square, k] of squares) record(square, [k]);
      return true;
    },
    addressed: (x, y) => byCell.has(cellKey({ x, y })),
    unaddressed: () => mask.cells.filter(c => !byCell.has(cellKey(c))),
    unaddressedComponents: () => unusedComponents(mask.cells, new Set(byCell.keys())),
  };
}
