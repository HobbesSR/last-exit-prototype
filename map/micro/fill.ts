import { compareCells } from '../kernel/cell.ts';
import { rect } from '../../shared/shape.ts';
import { elementShapes, shapesOverlap } from './geometry.ts';
import type { RegionBrief, RegionElement } from './types.ts';

/** A free rectangle in cells: `x`, `y` the top-left owned cell, `w` and `h` its size. */
export interface FreeRect { x: number; y: number; w: number; h: number }

/** What a region's builder left unfilled. A design guideline's measure, never a refusal. */
export interface FillReport {
  region: string;
  /** Owned cells with no obstacle on them. */
  freeCells: number;
  cells: number;
  /** The largest free rectangle whose sides are both at least `minSide`, or null. */
  largest: FreeRect | null;
  /** Disjoint free rectangles of at least `minSide` × `minSide`, taken largest first. */
  rectangles: FreeRect[];
}

/**
 * Measure the empty space a region's builder left (the measuring tool for #243 and #214). A cell is
 * free when no obstacle touches it. Rectangles are then taken greedily, largest first, and
 * disjoint, so the count is how many gaps of that size the builder left, not how many overlap.
 * Only obstacles count: loot, doors and roofs do not fill space. Run it from builder-test tools;
 * the sweep's report view must not call it, or the report hash moves.
 */
export function measureFill(brief: Pick<RegionBrief, 'id' | 'cells' | 'cellSize'>, elements: readonly RegionElement[], minSide = 3): FillReport {
  const size = brief.cellSize, blockers = elements.flatMap(element => elementShapes(element));
  const free = new Set<string>();
  for (const c of brief.cells) {
    const cell = rect(c.x * size, c.y * size, size, size);
    if (!blockers.some(shape => shapesOverlap(shape, cell))) free.add(`${c.x},${c.y}`);
  }
  const freeCells = free.size, rectangles: FreeRect[] = [];
  for (;;) {
    const best = largestFree(brief.cells, free, minSide);
    if (!best) break;
    rectangles.push(best);
    for (let y = best.y; y < best.y + best.h; y++) for (let x = best.x; x < best.x + best.w; x++) free.delete(`${x},${y}`);
  }
  return { region: brief.id, cells: brief.cells.length, freeCells, largest: rectangles[0] ?? null, rectangles };
}

/** Largest-area free rectangle with both sides >= minSide; ties go to the first in row-major order. */
function largestFree(cells: readonly { x: number; y: number }[], free: ReadonlySet<string>, minSide: number): FreeRect | null {
  let best: FreeRect | null = null;
  const owned = [...cells].sort(compareCells);
  for (const c of owned) {
    if (!free.has(`${c.x},${c.y}`)) continue;
    // Grow right while the top row is free, tracking how far down every column stays free.
    let depth = Infinity;
    for (let w = 1; free.has(`${c.x + w - 1},${c.y}`); w++) {
      let column = 0;
      while (free.has(`${c.x + w - 1},${c.y + column}`)) column++;
      depth = Math.min(depth, column);
      if (w >= minSide && depth >= minSide && (!best || w * depth > best.w * best.h)) best = { x: c.x, y: c.y, w, h: depth };
    }
  }
  return best;
}
