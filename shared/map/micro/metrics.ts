import { navigationClearance } from '../navigation.ts';
import type { RegionSpec } from './types.ts';

/** Explicit preview scale; omitted profile retains existing game geometry contracts. */
export function microMetrics(spec: Pick<RegionSpec, 'cellSize' | 'bodyProfile'>) {
  const cell = spec.bodyProfile === 'cell';
  const body = cell ? { contestant: spec.cellSize * .625, hunter: spec.cellSize * .875 } : { contestant: 12, hunter: 23 };
  const clearance = cell ? { contestant: body.contestant + spec.cellSize * .05, hunter: body.hunter + spec.cellSize * .05 }
    : { contestant: navigationClearance('contestant'), hunter: navigationClearance('gladiator') };
  return { body, clearance, doorway: cell ? spec.cellSize * 2 : 110, squeeze: cell ? spec.cellSize * 1.5 : 34,
    lootRadius: Math.max(24, clearance.contestant) };
}
