import { transform } from '../../../shared/shape.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { Vec2 } from '../../../shared/types.ts';
import { OUTSIDE } from './design.ts';
import type { BuildingAllocation } from './design.ts';
import type { BuildingRealization } from './realize.ts';

export interface BuildingPieceOptions {
  cellSize: number;
  /** Spaces that get a roof. Each must fill its bounding box, since a roof is a rectangle (L2). */
  roofed?: readonly string[];
}
/** One space's share of a realization, as its own element. */
export interface BuildingPiece {
  space: string;
  /** Anchor in world units, in the realization's frame: the space's bounding box corner. */
  origin: Vec2;
  template: ElementTemplate;
}

/**
 * Split a realization into one element per space, in the allocation's space order, so each
 * room can have its own roof. A wall on the outside belongs to its space. A wall between two
 * spaces is built once and belongs to one of them: a roofed one where there is one, else the
 * one the allocation lists first. Parts keep the realization's order within each piece. A space
 * left with no parts and no roof gives no piece.
 */
export function splitBuilding(realization: BuildingRealization, allocation: BuildingAllocation, options: BuildingPieceOptions): { pieces: BuildingPiece[]; issues: string[] } {
  const issues: string[] = [], { template, owners, origin } = realization, size = options.cellSize;
  if (!template || !owners || !origin || owners.length !== template.parts.length) return { pieces: [], issues: ['A building needs a realized template to split.'] };
  const roofed = new Set(options.roofed ?? []), order = allocation.spaces.map(space => space.id);
  for (const id of roofed) if (!order.includes(id)) issues.push(`Unknown roofed space: ${id}`);
  const owner = ({ a, b }: { a: string; b: string }) => {
    if (a === OUTSIDE || b === OUTSIDE) return a === OUTSIDE ? b : a;
    if (roofed.has(a) !== roofed.has(b)) return roofed.has(a) ? a : b;
    return order.indexOf(a) <= order.indexOf(b) ? a : b;
  };
  const pieces: BuildingPiece[] = [];
  for (const space of allocation.spaces) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of space.cells) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + 1); y1 = Math.max(y1, c.y + 1); }
    const roof = roofed.has(space.id);
    if (roof && (x1 - x0) * (y1 - y0) !== space.cells.length) { issues.push(`A roof needs a rectangular space: ${space.id}`); continue; }
    const at = { x: x0 * size, y: y0 * size }, dx = origin.x - at.x, dy = origin.y - at.y;
    const parts = template.parts.filter((_, i) => owner(owners[i]!) === space.id).map(part => part.part === 'obstacle'
      ? { ...part, shape: transform(part.shape, dx, dy) } : { ...part, x: part.x + dx, y: part.y + dy });
    if (!parts.length && !roof) continue;
    pieces.push({ space: space.id, origin: at, template: { w: (x1 - x0) * size, h: (y1 - y0) * size, ...(roof ? { encloses: true } : {}), parts } });
  }
  return { pieces, issues };
}
