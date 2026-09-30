/**
 * Where micro detail may and may not sit.
 *
 * These are placement rules, not one builder's taste: every builder that puts
 * anything solid on the ground needs them, and they were shared by being
 * imported out of `open-field`, which made the field builder a dependency of
 * five others that have nothing to do with it. They live here instead.
 *
 * The common thread is that containment is not enough. The canvas refuses a
 * declaration that reaches outside the area a builder owns; it cannot see that
 * a prop legally inside its own cell has taken the only standing room behind an
 * opening, or pinched the street running past, or left a loot slot no body can
 * reach. The clearance guard cannot repair any of that either -- it takes back
 * walls, and none of these are walls. So they are decided before anything is
 * placed rather than mourned afterwards.
 */
import { pointSegmentDistance } from "../geometry.ts";
import type { RegionContext, RegionMask } from "./types.ts";

/**
 * How far from the region border a prop must sit.
 *
 * A prop leaves a fifth of a cell either side of itself, so the span between
 * one at depth `d` and the sealed outside is `(d - 1) + 0.2` cells. The largest
 * body is two cells across, so depth 3 is the first depth that still lets a
 * hunter walk the region edge past a piece of cover -- and a hunter that cannot
 * is a region the clearance guard will strip every wall from to try to fix.
 */
export const PROP_MARGIN = 3;

/** Depth at which a cell is up against the sealed outside, and the berth it wants. */
const BORDER_DEPTH = 1;
const BORDER_BERTH = 2;

/**
 * Is this a cell a body can stand in, and get out of?
 *
 * A prop fills the middle of its cell, and every body in the brief is wider
 * than what that leaves, so a cell carrying one is not standing room. The
 * neighbours matter as much, and asymmetrically: an interior cell is approached
 * across four edges and needs those four cells clear, but a cell on the region
 * border has only its corner lattice nodes to stand on -- the sealed outside
 * takes the centre and the edge midpoints -- and the swept move onto a corner
 * node passes close enough to anything within two cells diagonally that the
 * largest body does not fit. So a border slot wants a wider berth than an
 * interior one, which is the reverse of what the geometry suggests.
 *
 * This is stricter than the clearance guard would be, on purpose: the guard
 * drops walls, and a stranded spawn is not a wall, so one unreachable slot
 * costs the region every barrier its builder stated.
 */
export function standableSlot(
  mask: RegionMask,
  blocked: ReadonlySet<number>,
  x: number,
  y: number,
): boolean {
  const index = mask.indexOf(x, y);
  if (index < 0 || blocked.has(index)) return false;
  const clear = (nx: number, ny: number): boolean => {
    const at = mask.indexOf(nx, ny);
    return at < 0 || !blocked.has(at);
  };
  if (mask.depthAt(x, y) <= BORDER_DEPTH) {
    for (let dy = -BORDER_BERTH; dy <= BORDER_BERTH; dy += 1)
      for (let dx = -BORDER_BERTH; dx <= BORDER_BERTH; dx += 1)
        if (!clear(x + dx, y + dy)) return false;
    return true;
  }
  return (
    clear(x - 1, y) && clear(x + 1, y) && clear(x, y - 1) && clear(x, y + 1)
  );
}

/**
 * Cells no prop may take: the cell inside each opening, and the four cells it
 * is approached from.
 *
 * An opening with no standing room behind it is a sealed region however open
 * the segment is, and the clearance guard cannot repair that by dropping walls.
 * A prop is cheap to put somewhere else, so this is decided before one is
 * placed rather than mourned afterwards.
 */
export function approachCells(context: RegionContext): Set<number> {
  const out = new Set<number>();
  for (const opening of context.openings)
    for (const [dx, dy] of [
      [0, 0],
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const index = context.mask.indexOf(
        opening.inside.x + dx,
        opening.inside.y + dy,
      );
      if (index >= 0) out.add(index);
    }
  return out;
}

/**
 * Cells the region must not build on: the standing room behind each opening,
 * and the streets crossing the area.
 *
 * `RegionContext.corridors` are routes that have to survive, and a builder may
 * build up to one but not across it. The clearance guard checks corridors after
 * the fact, but it can only take segments back: a prop lives in a cell and a
 * material cell is not geometry the guard reads at all, so anything solid has
 * to stay off the street by choosing to.
 *
 * The cells *beside* a reserved one go too. A reserved cell is standing room
 * another pass owns -- a tile anchor, a street -- and a prop sits at the centre
 * of its own cell and reaches a fifth of a cell from the corner, so a prop in
 * any of the four cells meeting that corner is inside the clearance a body
 * standing there needs. Containment alone does not see this: the prop never
 * leaves its own cell.
 */
export function keepClear(context: RegionContext): Set<number> {
  const out = approachCells(context);
  for (const cell of context.mask.cells) {
    const cx = cell.x + 0.5;
    const cy = cell.y + 0.5;
    let beside = context.isReserved(cell.x, cell.y);
    for (let dy = -1; dy <= 1 && !beside; dy += 1)
      for (let dx = -1; dx <= 1 && !beside; dx += 1)
        beside = context.isStandingRoom(cell.x + dx, cell.y + dy);
    if (beside) {
      out.add(cell.cellIndex);
      continue;
    }
    for (const corridor of context.corridors) {
      // Half a cell diagonal past the corridor half width: a prop sits at the
      // centre of its cell but reaches toward the corners.
      const reach = corridor.radius + Math.SQRT1_2;
      let hit = false;
      const points = corridor.points;
      for (let i = 0; i < points.length && !hit; i += 1) {
        const a = points[i]!;
        const b = points[i + 1] ?? a;
        hit = pointSegmentDistance(cx, cy, a.x, a.y, b.x, b.y) <= reach;
      }
      if (hit) {
        out.add(cell.cellIndex);
        break;
      }
    }
  }
  return out;
}

/**
 * Ground a structure may occupy: the block, less what another pass owns, less a
 * cell of berth around standing room.
 *
 * A wall or a pillar against a street is wanted -- that is what stops the street
 * being a clear shot -- so reserved ground costs only the cells it covers. This
 * deliberately does NOT also exclude the ring around standing room: the canvas
 * refuses to narrow any segment touching standing room, so a wall that would
 * crowd a tile anchor is already impossible, and paying for it twice is what
 * reduced a whole map to sixteen stated segments. A building beside an anchor
 * is simply left open where it meets it, which is the right answer anyway.
 *
 * `keepClear` is the rule for a prop and is stricter again; using it to site a
 * building excluded every cell beside any reserved ground, which on a map with
 * an anchor in every tile left nowhere to build at all.
 */
export function buildableCells(context: RegionContext): Set<number> {
  const out = new Set<number>();
  for (const cell of context.mask.cells)
    if (!context.isReserved(cell.x, cell.y)) out.add(cell.cellIndex);
  return out;
}
