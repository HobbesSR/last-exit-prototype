import { placeElement } from '../../shared/map/element.ts';
import { createGenerationContext } from '../../shared/map/context.ts';
import { validateMicroRegion } from './index.ts';
import type { BaseGenerationContext } from '../../shared/map/context.ts';
import type { CollisionMap, NodeId, Vec2 } from '../../shared/types.ts';
import type { BuiltMap, MicroResult, RegionElement } from './types.ts';

/** Emit elements and loot through the same element/shape emission as normal arena content. */
function stamp(context: BaseGenerationContext, elements: readonly RegionElement[], loot: readonly Vec2[], origin: Vec2, nodeId: NodeId): void {
  const firstBuilding = context.map.buildings.length;
  for (const element of elements) {
    // The result's budgeted, checked spawn list is authoritative, not template candidate spots.
    const template = { ...element.template, parts: element.template.parts.filter(p => p.part !== 'spot') };
    placeElement(context, template, origin.x + element.x, origin.y + element.y, { nodeId, locked: false });
  }
  for (const spot of loot) {
    const x = origin.x + spot.x, y = origin.y + spot.y;
    const building = context.map.buildings.slice(firstBuilding).find(b => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h);
    context.spots.push({ x, y, nodeId, ...(building ? { buildingId: building.id } : {}) });
  }
}

/** Resolve a generated region through the same element/shape emission as normal arena content. */
export function stampMicroRegion(context: BaseGenerationContext, result: MicroResult, origin: Vec2, nodeId: NodeId): void {
  const errors = validateMicroRegion(result);
  if (errors.length) throw new Error(`Cannot stamp invalid region: ${errors.join(' ')}`);
  stamp(context, result.elements, result.loot, origin, nodeId);
}

/**
 * Emit a composed map's geometry (51 stage 7), each region's under its own id as its node.
 * Nothing is validated first: a builder's promise is its own to check (51 principle 9).
 * Core element sites stay in the map for the report; the game places nothing for them yet.
 */
export function stampBuiltMap(context: BaseGenerationContext, map: BuiltMap<RegionElement>, origin: Vec2): void {
  for (const region of map.regions) stamp(context, region.elements, region.loot, origin, region.brief.id as NodeId);
}

/** A composed map's collision, in the real arena's shape/gate schema, sized to its cells with its least corner at the world origin. */
export function builtMapCollision(map: BuiltMap<RegionElement>): CollisionMap {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const region of map.regions) for (const c of region.brief.cells) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  // Stamping draws no randomness, so the context's seed doesn't matter.
  const context = createGenerationContext(1), size = map.cellSize;
  context.map.width = (maxX - minX + 1) * size;
  context.map.height = (maxY - minY + 1) * size;
  stampBuiltMap(context, map, { x: -minX * size, y: -minY * size });
  return { width: context.map.width, height: context.map.height, obstacles: context.map.obstacles, gates: context.map.gates };
}

/** Isolated preview collision uses the real arena's shape/gate schema and world scale. */
export function regionCollisionMap(result: MicroResult, origin: Vec2 = { x: 12000, y: 6000 }): CollisionMap {
  const context = createGenerationContext(result.spec.seed);
  stampMicroRegion(context, result, origin, 'micro-preview' as NodeId);
  return { width: context.map.width, height: context.map.height, obstacles: context.map.obstacles, gates: context.map.gates };
}
