import { OUTSIDE } from './design.ts';
import type { BuildingAllocation } from './design.ts';
import type { BuildingOpeningResult } from './openings.ts';

/** A fade group for each space, by space id. A space left out fades alone. */
export type BuildingRoofGroups = Readonly<Record<string, string>>;

/**
 * Group the spaces one can walk between without leaving the building: those joined, directly or
 * through other spaces, by a placed passable opening (a door or an open side, never a window).
 * Rooms and opening kinds otherwise don't matter, and an opening to `OUTSIDE` joins nothing.
 * Each group of two or more spaces is named `<prefix>-<first space>`, in allocation order; keep
 * the prefix unique where the groups are scoped. A space nothing joins is left out.
 */
export function reachableRoofGroups(realization: BuildingOpeningResult, allocation: BuildingAllocation, prefix: string): BuildingRoofGroups {
  const parent = new Map<string, string>();
  const find = (id: string): string => { const p = parent.get(id) ?? id; if (p === id) return id; const root = find(p); parent.set(id, root); return root; };
  const order = allocation.spaces.map(space => space.id);
  for (const { a, b, kind } of realization.openings) {
    if (kind === 'window' || a === OUTSIDE || b === OUTSIDE) continue;
    const [ra, rb] = [find(a), find(b)];
    // The root is the earlier space, so a group's name doesn't depend on opening order.
    if (ra !== rb) order.indexOf(ra) <= order.indexOf(rb) ? parent.set(rb, ra) : parent.set(ra, rb);
  }
  const size = new Map<string, number>();
  for (const id of order) size.set(find(id), (size.get(find(id)) ?? 0) + 1);
  return Object.fromEntries(order.filter(id => size.get(find(id))! > 1).map(id => [id, `${prefix}-${find(id)}`]));
}
