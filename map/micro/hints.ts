import { LIMITS } from './limits.ts';
import type { Cell, RegionBrief } from './types.ts';

/** What the hint helpers read of a brief. */
export type HintedRegion = Pick<RegionBrief, 'cells'> & Partial<Pick<RegionBrief, 'hints' | 'portals'>>;

/** A box of whole cells: `x`, `y` its top-left cell, `w` and `h` its size. */
export interface CellBox { x: number; y: number; w: number; h: number }

/** One segment of a run: the region's cell beside it, and which way the region lies from it. */
interface Stretch { cell: Cell; inward: Cell }

const keyOf = (x: number, y: number): string => `${x},${y}`;

/**
 * The segments of a run in order, each with the region's cell beside it. Throws unless every
 * segment lies on the perimeter with the region on one side, as a portal must.
 */
function stretchesOf(run: { axis: 'h' | 'v'; x: number; y: number; length: number }, owned: ReadonlySet<string>): Stretch[] {
  const { axis, x, y, length } = run;
  if (axis !== 'h' && axis !== 'v' || ![x, y, length].every(Number.isInteger) || length < 1 || length > LIMITS.run) throw new Error('A hint is not a run.');
  const stretches = Array.from({ length }, (_, i) => {
    const before = axis === 'h' ? { x: x + i, y: y - 1 } : { x: x - 1, y: y + i }, after = axis === 'h' ? { x: x + i, y } : { x, y: y + i };
    const b = owned.has(keyOf(before.x, before.y)), a = owned.has(keyOf(after.x, after.y));
    if (a === b) throw new Error('A hint must lie on the region\'s perimeter, with the region on one side.');
    return a ? { cell: after, inward: axis === 'h' ? { x: 0, y: 1 } : { x: 1, y: 0 } }
      : { cell: before, inward: axis === 'h' ? { x: 0, y: -1 } : { x: -1, y: 0 } };
  });
  // A concave region can lie on both sides of one line, so a run must keep to one.
  if (stretches.some(s => s.inward.x !== stretches[0]!.inward.x || s.inward.y !== stretches[0]!.inward.y))
    throw new Error('A hint must keep the region on one side along its whole length.');
  return stretches;
}

const ownedOf = (region: HintedRegion): Set<string> => new Set(region.cells.map(c => keyOf(c.x, c.y)));

/**
 * Why a brief's hints are malformed, or none. Each must be a run on the perimeter with the
 * region on one side, and none may overlap a portal: a hint is never a requirement, so it
 * can't claim a segment the portal promise already holds.
 */
export function hintErrors(region: HintedRegion): string[] {
  if (region.hints === undefined) return [];
  if (!Array.isArray(region.hints) || region.hints.length > LIMITS.portals) return ['Hints must be a bounded list of runs.'];
  const owned = ownedOf(region), promised = new Set<string>(), errors: string[] = [];
  const segmentKey = (axis: string, x: number, y: number) => `${axis}:${x},${y}`;
  for (const portal of region.portals ?? []) for (let i = 0; i < portal.length; i++)
    promised.add(portal.axis === 'h' ? segmentKey('h', portal.x + i, portal.y) : segmentKey('v', portal.x, portal.y + i));
  for (const hint of region.hints) {
    try { stretchesOf(hint, owned); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); continue; }
    for (let i = 0; i < hint.length; i++)
      if (promised.has(hint.axis === 'h' ? segmentKey('h', hint.x + i, hint.y) : segmentKey('v', hint.x, hint.y + i))) { errors.push('A hint overlaps a portal.'); break; }
  }
  return errors;
}

/**
 * The region's cells beside a hinted segment, in row order. A builder that wants to honour
 * its hints looks here first; one that ignores them is still correct (20.3).
 */
export function hintedCells(region: HintedRegion): Cell[] {
  const owned = ownedOf(region), found = new Map<string, Cell>();
  for (const hint of region.hints ?? []) for (const { cell } of stretchesOf(hint, owned)) found.set(keyOf(cell.x, cell.y), cell);
  return [...found.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Boxes of `w` by `h` cells that lie wholly in the region with a side flush against a hinted
 * run, touching at least one of its segments. The caller asks for each orientation it
 * accepts. Boxes come in hint order, then along the hint, without repeats, so a draw from
 * them is deterministic. This only offers places: whether to build there is the builder's.
 */
export function boxesAgainstHints(region: HintedRegion, w: number, h: number): CellBox[] {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error('A box needs a whole size.');
  const owned = ownedOf(region), boxes = new Map<string, CellBox>();
  for (const hint of region.hints ?? []) {
    const [{ inward }] = stretchesOf(hint, owned) as [Stretch];
    const along = hint.axis === 'h' ? w : h, across = hint.axis === 'h' ? h : w;
    for (let start = (hint.axis === 'h' ? hint.x : hint.y) - along + 1; start < (hint.axis === 'h' ? hint.x : hint.y) + hint.length; start++) {
      // The box's near edge is the hint's line, and it extends inward from there.
      const line = hint.axis === 'h' ? hint.y : hint.x, far = inward.x + inward.y > 0 ? line : line - across;
      const box: CellBox = hint.axis === 'h' ? { x: start, y: far, w, h } : { x: far, y: start, w, h };
      let inside = true;
      for (let y = box.y; y < box.y + h && inside; y++) for (let x = box.x; x < box.x + w; x++) if (!owned.has(keyOf(x, y))) { inside = false; break; }
      if (inside) boxes.set(`${box.x},${box.y}`, box);
    }
  }
  return [...boxes.values()];
}

/**
 * The region's cells within `depth` cells of a portal (Chebyshev, from the cell beside each
 * portal segment), apart from those beside a hinted run, in row order. This is the clear
 * space a builder keeps open in front of its portals. A hinted stretch is where geometry
 * belongs, so it isn't counted as margin even when a portal lies near it (20.3).
 */
export function portalMargin(region: HintedRegion, depth: number): Cell[] {
  if (!Number.isInteger(depth) || depth < 0) throw new Error('A margin needs a whole depth.');
  const owned = ownedOf(region), margin = new Map<string, Cell>(), hinted = new Set(hintedCells(region).map(c => keyOf(c.x, c.y)));
  for (const portal of region.portals ?? []) for (const { cell } of stretchesOf(portal, owned))
    for (let dy = -(depth - 1); dy <= depth - 1; dy++) for (let dx = -(depth - 1); dx <= depth - 1; dx++) {
      const x = cell.x + dx, y = cell.y + dy, key = keyOf(x, y);
      if (owned.has(key) && !hinted.has(key)) margin.set(key, { x, y });
    }
  return [...margin.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}
