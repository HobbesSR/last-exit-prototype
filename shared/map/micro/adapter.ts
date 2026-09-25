import { placeElement } from '../element.ts';
import { createGenerationContext } from '../context.ts';
import { validateMicroRegion } from './index.ts';
import type { BaseGenerationContext } from '../context.ts';
import type { CollisionMap, NodeId, Vec2 } from '../../types.ts';
import type { RegionResult } from './types.ts';

/** Resolve a generated region through the same element/shape emission as normal arena content. */
export function stampMicroRegion(context: BaseGenerationContext, result: RegionResult, origin: Vec2, nodeId: NodeId): void {
  const errors = validateMicroRegion(result);
  if (errors.length) throw new Error(`Cannot stamp invalid region: ${errors.join(' ')}`);
  const firstBuilding = context.map.buildings.length;
  for (const element of result.elements) {
    // The result's budgeted, checked spawn list is authoritative, not template candidate spots.
    const template = { ...element.template, parts: element.template.parts.filter(p => p.part !== 'spot') };
    placeElement(context, template, origin.x + element.x, origin.y + element.y, { nodeId, locked: false });
  }
  for (const spot of result.loot) {
    const x = origin.x + spot.x, y = origin.y + spot.y;
    const building = context.map.buildings.slice(firstBuilding).find(b => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h);
    context.spots.push({ x, y, nodeId, ...(building ? { buildingId: building.id } : {}) });
  }
}

/** Isolated preview collision uses the real arena's shape/gate schema and world scale. */
export function regionCollisionMap(result: RegionResult, origin: Vec2 = { x: 12000, y: 6000 }): CollisionMap {
  const context = createGenerationContext(result.spec.seed);
  stampMicroRegion(context, result, origin, 'micro-preview' as NodeId);
  return { width: context.map.width, height: context.map.height, obstacles: context.map.obstacles, gates: context.map.gates };
}
