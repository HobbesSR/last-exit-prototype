import { bounds, circle, convex, overlaps, polygon, rect, transform } from '../../shape.ts';
import type { Shape } from '../../shape.ts';
import type { Box, Vec2 } from '../../types.ts';
import type { RegionElement, RegionMask, RegionSpec } from './types.ts';

const EPS = 1e-7;
export const boxesOverlap = (a: Box, b: Box): boolean => a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
export const shapesOverlap = (a: Shape, b: Shape): boolean => boxesOverlap(bounds(a), bounds(b)) && overlaps(a, b);

export function validShape(shape: Shape): boolean {
  if (!shape || !Number.isFinite(shape.x) || !Number.isFinite(shape.y)) return false;
  if (shape.kind === 'rect') return Number.isFinite(shape.w) && Number.isFinite(shape.h) && shape.w > 0 && shape.h > 0;
  if (shape.kind === 'circle') return Number.isFinite(shape.r) && shape.r > 0;
  return shape.kind === 'polygon' && shape.points.length <= 64 && shape.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) && convex(shape.points);
}

export function createRegionMask(spec: Pick<RegionSpec, 'cells' | 'cellSize'>): RegionMask {
  const cells = [...spec.cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const size = spec.cellSize, owned = new Set(cells.map(c => `${c.x},${c.y}`));
  const minX = Math.min(...cells.map(c => c.x)), minY = Math.min(...cells.map(c => c.y));
  const maxX = Math.max(...cells.map(c => c.x)), maxY = Math.max(...cells.map(c => c.y));
  const has = (x: number, y: number) => owned.has(`${x},${y}`);
  const contains = (shape: Shape): boolean => {
    if (!validShape(shape)) return false;
    const b = bounds(shape);
    if (b.x < minX * size - EPS || b.y < minY * size - EPS || b.x + b.w > (maxX + 1) * size + EPS || b.y + b.h > (maxY + 1) * size + EPS) return false;
    for (let y = Math.floor((b.y + EPS) / size); y <= Math.floor((b.y + b.h - EPS) / size); y++) {
      for (let x = Math.floor((b.x + EPS) / size); x <= Math.floor((b.x + b.w - EPS) / size); x++) {
        if (!has(x, y) && shapesOverlap(shape, rect(x * size, y * size, size, size))) return false;
      }
    }
    return true;
  };
  return { cells, cellSize: size, bounds: { x: minX * size, y: minY * size, w: (maxX - minX + 1) * size, h: (maxY - minY + 1) * size }, has, contains,
    rectangles(widthCells, heightCells) {
      const result: Box[] = [];
      for (const c of cells) {
        let fits = true;
        for (let y = 0; y < heightCells && fits; y++) for (let x = 0; x < widthCells; x++) if (!has(c.x + x, c.y + y)) { fits = false; break; }
        if (fits) result.push({ x: c.x * size, y: c.y * size, w: widthCells * size, h: heightCells * size });
      }
      return result;
    },
  };
}

/** Exact swept disc as two circles and a convex strip, using the game's shape algebra. */
export function capsule(a: Vec2, b: Vec2, radius: number): Shape[] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < EPS) return [circle(a.x, a.y, radius)];
  const nx = -(b.y - a.y) / length * radius, ny = (b.x - a.x) / length * radius;
  return [circle(a.x, a.y, radius), circle(b.x, b.y, radius), polygon(0, 0, [
    { x: a.x + nx, y: a.y + ny }, { x: a.x - nx, y: a.y - ny },
    { x: b.x - nx, y: b.y - ny }, { x: b.x + nx, y: b.y + ny },
  ])];
}
export function travelClear(mask: RegionMask, blockers: readonly Shape[], a: Vec2, b: Vec2, radius: number): boolean {
  return capsule(a, b, radius).every(s => mask.contains(s) && !blockers.some(o => shapesOverlap(s, o)));
}

export function elementShapes(element: RegionElement, doors = false): Shape[] {
  return element.template.parts.flatMap(part => {
    if (part.part === 'obstacle') return [transform(part.shape, element.x, element.y)];
    if (part.part === 'gate' && doors) return [rect(element.x + part.x - part.w / 2, element.y + part.y - part.h / 2, part.w, part.h)];
    return [];
  });
}

/** Conservative half-cell search, every edge checked as a swept body, not just endpoints. */
export function findRegionRoute(mask: RegionMask, blockers: readonly Shape[], a: Vec2, b: Vec2, radius: number): Vec2[] | null {
  if (travelClear(mask, blockers, a, b, radius)) return [a, b];
  const step = mask.cellSize / 2, box = mask.bounds;
  const width = Math.round(box.w / step), height = Math.round(box.h / step);
  const point = (i: number): Vec2 => ({ x: box.x + (i % width + 0.5) * step, y: box.y + (Math.floor(i / width) + 0.5) * step });
  const walkable = new Map<number, boolean>();
  const free = (i: number): boolean => {
    if (!walkable.has(i)) { const p = point(i); walkable.set(i, travelClear(mask, blockers, p, p, radius)); }
    return walkable.get(i)!;
  };
  const nearby: number[] = [];
  for (let i = 0; i < width * height; i++) if (Math.hypot(point(i).x - a.x, point(i).y - a.y) <= step * 3) nearby.push(i);
  nearby.sort((i, j) => Math.hypot(point(i).x - a.x, point(i).y - a.y) - Math.hypot(point(j).x - a.x, point(j).y - a.y));
  const queue: number[] = [], previous = new Map<number, number>();
  for (const i of nearby) if (free(i) && travelClear(mask, blockers, a, point(i), radius)) { queue.push(i); previous.set(i, -1); }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], p = point(i);
    if (Math.hypot(p.x - b.x, p.y - b.y) <= step * 3 && travelClear(mask, blockers, p, b, radius)) {
      const path = [b]; let cursor = i;
      while (cursor !== -1) { path.push(point(cursor)); cursor = previous.get(cursor)!; }
      path.push(a); path.reverse();
      // Collapse only straight runs. Corners retain their swept clearance.
      return path.filter((p, j) => !j || j === path.length - 1 || Math.abs((p.x - path[j - 1].x) * (path[j + 1].y - p.y) - (p.y - path[j - 1].y) * (path[j + 1].x - p.x)) > EPS);
    }
    const x = i % width, y = Math.floor(i / width);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
      const next = i + dx + dy * width;
      if (previous.has(next) || !free(next) || !travelClear(mask, blockers, p, point(next), radius)) continue;
      previous.set(next, i); queue.push(next);
    }
  }
  return null;
}
