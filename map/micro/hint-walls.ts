import { createFillMask, elementShapes, shapesOverlap } from './geometry.ts';
import { ownedOf, stretchesOf } from './hints.ts';
import { expectPlaced, placedElements } from './placeables/placeable.ts';
import { WALL_RUN } from './placeables/wall-run.ts';
import type { WallRunParams } from './placeables/wall-run.ts';
import { areasOverlap } from './addressed.ts';
import type { AddressedArea } from './addressed.ts';
import { rect } from '../../shared/shape.ts';
import type { Shape } from '../../shared/shape.ts';
import type { BuilderCanvas } from './canvas.ts';
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

/**
 * Commits `walls` through a builder canvas (20.2) as one assembly, since walls at a convex
 * corner overlap. Their addressed intent is their own shapes (`separateAreas`), as they share
 * cells with the builder's pieces. The walls avoided the builder's pieces and routes, so a
 * refusal is a broken placement invariant.
 */
export function commitHintWalls(canvas: BuilderCanvas, walls: HintWalls): void {
  if (walls.elements.length && !canvas.commit({ elements: walls.elements, areas: separateAreas(walls.shapes), extents: walls.shapes }))
    throw new Error('Hint walls failed their canvas commit.');
}

/**
 * Addressed areas (20.2) for pieces that may overlap one another, as walls meeting at a corner
 * do. Each rectangle stops short of an earlier area it runs into along its length, so the
 * earlier keeps the shared corner. Any other overlapping shape adds no area of its own: the
 * piece it overlaps already addresses that place.
 */
export function separateAreas(shapes: readonly Shape[]): Shape[] {
  const areas: Shape[] = [];
  for (const shape of shapes) {
    if (shape.kind !== 'rect') {
      if (!areas.some(area => areasOverlap(area, shape))) areas.push(shape);
      continue;
    }
    let { x, y, w, h } = shape;
    for (const area of areas) {
      if (!areasOverlap(area, rect(x, y, w, h))) continue;
      if (area.kind !== 'rect') { w = 0; break; }
      if (w >= h) [x, w] = area.x <= x ? [area.x + area.w, x + w - area.x - area.w] : [x, area.x - x];
      else [y, h] = area.y <= y ? [area.y + area.h, y + h - area.y - area.h] : [y, area.y - y];
      if (w <= 0 || h <= 0) break;
    }
    if (w > 0 && h > 0) areas.push(rect(x, y, w, h));
  }
  return areas;
}
