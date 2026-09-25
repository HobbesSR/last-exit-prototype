import { createGenerationContext } from '../../context.ts';
import { stampMicroRegion } from '../adapter.ts';
import { createRegionMask } from '../geometry.ts';
import { validateRealization } from './realize.ts';
import type { RealizedDecomposition } from './realize.ts';
import type { CollisionMap, NodeId, Vec2 } from '../../../types.ts';

/** Stamp every child into one collision map; bound the demo to its owned polyomino. */
export function realizationCollisionMap(result: RealizedDecomposition): { map: CollisionMap; origin: Vec2 } {
  const errors = validateRealization(result);
  if (errors.length) throw new Error(`Cannot preview invalid realization: ${errors.join(' ')}`);
  const context = createGenerationContext(result.seed), size = result.plan.context.cellSize;
  const mask = createRegionMask({ cells: result.regions.flatMap(r => r.spec.cells), cellSize: size });
  const origin = { x: context.map.width / 2 - mask.bounds.x - mask.bounds.w / 2, y: context.map.height / 2 - mask.bounds.y - mask.bounds.h / 2 };
  for (const region of result.regions) stampMicroRegion(context, region, origin, region.spec.id as NodeId);
  // Tool-only void collision, not generated architecture. Draw it as outside/holes.
  for (let y = mask.bounds.y / size - 2; y < (mask.bounds.y + mask.bounds.h) / size + 2; y++) {
    for (let x = mask.bounds.x / size - 2; x < (mask.bounds.x + mask.bounds.w) / size + 2; x++) {
      if (!mask.has(x, y)) context.rect(origin.x + x * size, origin.y + y * size, size, size, 'ruin-wall');
    }
  }
  return { map: { width: context.map.width, height: context.map.height, obstacles: context.map.obstacles, gates: context.map.gates }, origin };
}
