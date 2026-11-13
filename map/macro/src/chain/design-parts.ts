/**
 * A design's fixed parts: its cells that join inside it whatever lies around it, the same
 * class or a guaranteed segment between them, both stated by the design alone. An `any`
 * cell's class depends on its neighbours, so it is in no part. The open-face rule's floods
 * take a part as one node and leave it only by its exits; the skeleton's part filter asks
 * which part carries each forced crossing. Both read parts here, so they agree.
 */
import type { OrientedDesign } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import { guaranteesPassability } from "./resolution.ts";
import type { SegmentKey } from "./types.ts";

const S = CHAIN_TILE_SIZE;
/** The four sides, as the exits number them: `local * 4 + side`. */
export const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
/** Cells of one part, by local index, and its exits, the faces from its cells to cells outside it, `local * 4 + side`. */
export interface Part { cells: number[]; exits: number[] }
/** Each cell's part, by local index (-1 for `any`), and the parts in order of their first cell. */
export interface Parts { of: Int16Array; parts: Part[] }

// Designs are immutable once oriented, so parts are kept by design object.
const cache = new WeakMap<OrientedDesign, Parts>();

/** The fixed parts of `design`. */
export function partsOf(design: OrientedDesign): Parts {
  let found = cache.get(design);
  if (found) return found;
  const { cells } = design;
  const of = new Int16Array(S * S).fill(-1), parts: Part[] = [];
  const joinsInside = (local: number, k: number): number => {
    const x = local % S, y = (local - x) / S, [dx, dy] = SIDES[k]!, nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= S || ny >= S) return -1;
    const next = ny * S + nx;
    if (cells[next] === "any") return -1;
    if (cells[next] === cells[local]) return next;
    const segment = design.segments.get((dx ? `v:${x + Math.max(dx, 0)},${y}` : `h:${x},${y + Math.max(dy, 0)}`) as SegmentKey);
    return guaranteesPassability(segment?.passability, segment?.passability) ? next : -1;
  };
  for (let first = 0; first < S * S; first++) {
    if (cells[first] === "any" || of[first]! >= 0) continue;
    const part: Part = { cells: [first], exits: [] };
    of[first] = parts.length;
    for (let i = 0; i < part.cells.length; i++) for (let k = 0; k < SIDES.length; k++) {
      const next = joinsInside(part.cells[i]!, k);
      if (next >= 0 && of[next]! < 0) { of[next] = parts.length; part.cells.push(next); }
    }
    parts.push(part);
  }
  for (const [id, part] of parts.entries()) for (const local of part.cells) for (let k = 0; k < SIDES.length; k++) {
    const next = joinsInside(local, k);
    if (next < 0 || of[next] !== id) part.exits.push(local * 4 + k);
  }
  cache.set(design, found = { of, parts });
  return found;
}
