import { applyClearConstraints, clearFootprint } from '../kernel/margins.ts';
import { checkedMargins } from './limits.ts';
import type { RegionBrief } from '../kernel/contract.ts';
import { createFillMask } from './geometry.ts';
import type { Shape } from '../../shared/shape.ts';

/**
 * Carry original ownership and inherited constraints to already assigned children.
 * New child portals add clearance across all affected children, including endpoint owners.
 * No margin becomes a child, portal or repeated inset (20.6).
 */
export function inheritBriefMargins(input: RegionBrief, children: readonly RegionBrief[]): RegionBrief[] {
  const parent = checkedMargins(input);
  const parentOwned = new Set(parent.cells.map(c => `${c.x},${c.y}`)), assigned = new Set<string>();
  for (const child of children) for (const cell of child.cells) {
    const key = `${cell.x},${cell.y}`;
    if (!parentOwned.has(key) || assigned.has(key)) throw new Error('Child ownership must be disjoint and inside the original parent.');
    assigned.add(key);
  }
  const allowed = new Set(parent.fillCells.map(c => `${c.x},${c.y}`));
  const inherited = [...parent.clearCells, ...parent.cells.filter(c => !allowed.has(`${c.x},${c.y}`))];
  const added = clearFootprint(children.flatMap(child => [...child.portals, ...(child.internalGuaranteed ?? [])]),
    [...parent.cells, ...parent.clearCells]);
  return children.map(input => {
    const child = structuredClone(input);
    const childFill = new Set((child.fillCells ?? child.cells).map(c => `${c.x},${c.y}`));
    Object.assign(child, applyClearConstraints(child.cells, added, [...inherited, ...(child.clearCells ?? []),
      ...child.cells.filter(c => !childFill.has(`${c.x},${c.y}`))]));
    // A parent's internal run stays internal only where one child owns both its sides. Where
    // a child boundary splits it, that piece is internal to no child and isn't a child portal:
    // internal runs carry no pair-connectivity (20.6), and its footprint, the one obligation
    // it does carry, is already in `inherited`.
    const owned = new Set(child.cells.map(c => `${c.x},${c.y}`));
    const requirements = [...(parent.internalGuaranteed ?? []), ...(child.internalGuaranteed ?? [])];
    child.internalGuaranteed = requirements.flatMap(run => {
      const runs = [];
      let start = -1;
      for (let i = 0; i <= run.length; i++) {
        const x = run.x + (run.axis === 'h' ? i : 0), y = run.y + (run.axis === 'v' ? i : 0);
        const keep = i < run.length && owned.has(`${x},${y}`)
          && owned.has(run.axis === 'h' ? `${x},${y - 1}` : `${x - 1},${y}`);
        if (keep && start < 0) start = i;
        if (!keep && start >= 0) {
          runs.push({ axis: run.axis, x: run.x + (run.axis === 'h' ? start : 0), y: run.y + (run.axis === 'v' ? start : 0), length: i - start });
          start = -1;
        }
      }
      return runs;
    });
    const unique = new Map(child.internalGuaranteed.map(run => [`${run.axis}:${run.x},${run.y},${run.length}`, run]));
    child.internalGuaranteed = [...unique.values()].sort((a, b) => a.axis.localeCompare(b.axis) || a.y - b.y || a.x - b.x);
    return child;
  });
}

/** Elective placement diagnosis, including one-portal regions and internal guarantees. */
export function validateFillConstraints(brief: RegionBrief, blockers: readonly Shape[]): string[] {
  const fill = createFillMask(brief);
  return blockers.some(shape => !fill.contains(shape)) ? ['Collision geometry leaves the allowed fill area.'] : [];
}
