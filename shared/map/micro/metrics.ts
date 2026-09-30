import { navigationClearance } from '../navigation.ts';
import { CELL_SCALE } from '../common/scale.ts';
import type { RegionSpec } from './types.ts';

/** Explicit preview scale; omitted profile retains existing game geometry contracts. */
export function microMetrics(spec: Pick<RegionSpec, 'cellSize' | 'bodyProfile'>) {
  const cell = spec.bodyProfile === 'cell', size = spec.cellSize, margin = size * CELL_SCALE.clearanceMargin;
  const body = cell ? { contestant: size * CELL_SCALE.contestantRadius, hunter: size * CELL_SCALE.hunterRadius } : { contestant: 12, hunter: 23 };
  const clearance = cell ? { contestant: body.contestant + margin, hunter: body.hunter + margin }
    : { contestant: navigationClearance('contestant'), hunter: navigationClearance('gladiator') };
  return { body, clearance, doorway: cell ? size * CELL_SCALE.doorway : 110, squeeze: cell ? size * CELL_SCALE.squeeze : 34,
    lootRadius: Math.max(24, clearance.contestant) };
}
