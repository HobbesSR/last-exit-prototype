import { cellKey } from '../../kernel/cell.ts';
import type { Cell, Portal } from '../types.ts';

/**
 * Conservative ownership-only witness: each vertex owns its surrounding 2x2
 * square. Cardinal graph edges sweep a radius-one-cell disc through their union,
 * exceeding hunter clearance (0.925 cells). Diagonal corner joins are refused.
 * At most N vertices and four neighbors each: O(N + portal length) time, O(N)
 * storage. Numeric keys are relative to the bounded mask, never world addresses.
 */
export function hasWideCirculation(cells: readonly Cell[], claimed: ReadonlySet<string>, portals: readonly Portal[]): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity;
  for (const c of cells) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); }
  const stride = maxX - minX + 3;
  const key = (x: number, y: number) => (y - minY + 1) * stride + x - minX + 1;
  const remaining = new Set<number>();
  for (const c of cells) if (!claimed.has(cellKey(c))) remaining.add(key(c.x, c.y));
  const vertices = new Set<number>();
  for (const k of remaining) if (remaining.has(k - 1) && remaining.has(k - stride) && remaining.has(k - stride - 1)) vertices.add(k);
  if (!vertices.size) return false;
  // A complete two-deep inward strip joins the portal seam to the backbone.
  // Reserving a second approach row does not establish that it actually exists.
  for (const p of portals) {
    if (p.length < 2) return false;
    const after = remaining.has(key(p.x, p.y));
    for (let i = 1; i < p.length; i++) {
      const x = p.axis === 'h' ? p.x + i : p.x + (after ? 1 : -1);
      const y = p.axis === 'v' ? p.y + i : p.y + (after ? 1 : -1);
      if (!vertices.has(key(x, y))) return false;
    }
  }
  const start = vertices.values().next().value!, queue = [start];
  vertices.delete(start);
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head]!;
    for (const next of [k - 1, k + 1, k - stride, k + stride]) {
      if (vertices.delete(next)) queue.push(next);
    }
  }
  return vertices.size === 0;
}
