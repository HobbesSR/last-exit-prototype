import { createFillMask, elementShapes, shapesOverlap } from './geometry.ts';
import { ownedOf, stretchesOf } from './hints.ts';
import { expectPlaced, placedElements } from './placeables/placeable.ts';
import { WALL_RUN } from './placeables/wall-run.ts';
import type { WallRunParams } from './placeables/wall-run.ts';
import type { AddressedArea } from './addressed.ts';
import type { Shape } from '../../shared/shape.ts';
import type { Cell, RegionBrief, RegionElement } from './types.ts';

export interface HintWallOptions {
  kind: WallRunParams['kind'];
  /** Cells across each wall. Default a quarter, as `hut`'s and `ruins`' walls are. */
  thickness?: number;
  /** Cells between a wall and the hint's line. Default none. */
  inset?: number;
  /** Shapes no wall may overlap: the builder's protected routes and its own pieces. */
  avoid?: readonly Shape[];
  /** The builder's addressed area (20.2): addressed cells get no wall, and the walled cells are marked. */
  addressed?: AddressedArea;
  /** The fewest cells a wall may run; shorter stretches are left bare. Default 1. */
  minLength?: number;
  /** Prefixed to each wall's label. Default `hint-wall`. */
  label?: string;
}

export interface HintWalls {
  /** One `wall-run` per walled stretch, in hint order, then along each hint. */
  elements: RegionElement[];
  /** Their collision shapes in world units, in the same order. */
  shapes: Shape[];
  /** The cells the walls stand in, without repeats. */
  cells: Cell[];
}

/**
 * Plain `wall-run`s along the brief's hinted runs (#407), for a builder with nothing more
 * particular planned there. Each wall stands in the region's cells beside a hint, against its
 * line. A cell gets no wall outside the fill area (20.6), so portal margins stay clear; nor
 * where it is addressed, or where its wall would overlap a shape in `avoid`. Passing the
 * builder's protected routes there keeps the portal promise as it keeps it for its own pieces.
 * What is left of each hint is walled in maximal stretches of `minLength` cells or more.
 *
 * It reads every hint; pass `hintsOfStrength(brief, 'mutual')` to wall only the stronger
 * ones. Hints stay guidance, and a builder opts in by calling it. Walls at a convex corner
 * share the corner cell and close it.
 */
export function wallHints(brief: RegionBrief, options: HintWallOptions): HintWalls {
  const { kind, thickness = 0.25, inset = 0, avoid = [], addressed, minLength = 1, label = 'hint-wall' } = options;
  if (!Number.isInteger(minLength) || minLength < 1) throw new RangeError('A hint wall needs a whole positive minimum length.');
  const fill = createFillMask(brief), size = brief.cellSize, owned = ownedOf(brief);
  const result: HintWalls = { elements: [], shapes: [], cells: [] }, walled = new Map<string, Cell>();
  for (const hint of brief.hints ?? []) {
    const stretches = stretchesOf(hint, owned), { inward } = stretches[0]!;
    const shape = { turned: hint.axis === 'v', side: inward.x + inward.y > 0 ? 'start' : 'end', thickness, inset, kind } as const;
    const place = (cells: readonly Cell[]) => expectPlaced(WALL_RUN.build({ length: cells.length, ...shape }, size));
    let run: Cell[] = [];
    const flush = () => {
      if (run.length >= minLength) {
        const [first] = run as [Cell];
        const elements = placedElements(place(run), `${label}-${hint.axis}-${first.x}-${first.y}`, first.x, first.y, size);
        result.elements.push(...elements);
        result.shapes.push(...elements.flatMap(e => elementShapes(e)));
        for (const c of run) walled.set(`${c.x},${c.y}`, c);
      }
      run = [];
    };
    for (const { cell } of stretches) {
      const fits = fill.has(cell.x, cell.y) && !addressed?.addressed(cell.x, cell.y)
        && !elementShapes(placedElements(place([cell]), label, cell.x, cell.y, size)[0]!).some(wall => avoid.some(o => shapesOverlap(wall, o)));
      if (fits) run.push(cell);
      else flush();
    }
    flush();
  }
  result.cells = [...walled.values()];
  if (addressed && !addressed.markCells(result.cells)) throw new Error('Hint walls overlap an area already addressed.');
  return result;
}
