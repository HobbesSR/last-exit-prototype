import { transform } from '../shape.ts';
import type { Shape } from '../shape.ts';
import type { BaseGenerationContext } from './context.ts';
import type { BuildingId, GateId, NodeId, ObstacleKind, World } from '../types.ts';

/**
 * A placeable element: one named assembly of geometry — a building, a cover cluster, a checkpoint —
 * described once and stamped wherever generation wants it. `shape.ts` owns what a single body is;
 * this owns what a group of bodies is, which is the level the map was previously missing. Before it,
 * the arena's only building existed as eight literal `rect` calls at one call site, so a second
 * building meant a second copy of those literals.
 *
 * Parts are positioned in coordinates local to the element's anchor and are emitted in array order.
 * **That order is part of the generated arena:** ids come from one counter shared by every stage, so
 * reordering a template's parts renumbers every object placed after it and changes each seeded map.
 * Treat a published template's part order as frozen, the same way [31](../../docs/31-verification.md)
 * treats the stage order.
 */
export type ElementPart =
  | { part: 'obstacle'; shape: Shape; kind: ObstacleKind }
  | { part: 'gate'; x: World; y: World; w: World; h: World }
  /** A candidate loot position, offered to the objectives stage rather than filled here. */
  | { part: 'spot'; x: World; y: World }
  /** Ground the element claims beyond its own geometry, to keep later placements clear of it. */
  | { part: 'reserve'; x: World; y: World; w: World; h: World };

export interface ElementTemplate {
  /** Footprint size, which is also the `Building` box when the element encloses one. */
  w: World;
  h: World;
  /**
   * Whether this element registers a `Building`: an enclosed interior that a roof hides and that
   * tags the loot and doors inside it. A cover cluster or a prop sets nothing.
   */
  encloses?: boolean;
  parts: ElementPart[];
}

export interface Placement {
  nodeId: NodeId;
  /** Whether this instance's doors start locked. A placement choice, not a property of the template. */
  locked?: boolean;
}

/** Stamp a template with its anchor at `x`,`y`, emitting every part into the map being generated. */
export function placeElement(context: BaseGenerationContext, template: ElementTemplate, x: World, y: World, placement: Placement): void {
  const { map, nextId, shape, spots, reservations } = context;
  let owner: { buildingId: BuildingId } | undefined;
  if (template.encloses) {
    const building = { id: nextId('building-') as BuildingId, x, y, w: template.w, h: template.h, nodeId: placement.nodeId };
    map.buildings.push(building);
    owner = { buildingId: building.id };
  }
  for (const part of template.parts) {
    if (part.part === 'obstacle') shape(transform(part.shape, x, y), part.kind, { ...owner });
    else if (part.part === 'gate') map.gates.push({ id: nextId('door-') as GateId, x: x + part.x, y: y + part.y, w: part.w, h: part.h, open: false, locked: !!placement.locked, kind: 'door', ...owner });
    else if (part.part === 'spot') spots.push({ x: x + part.x, y: y + part.y, nodeId: placement.nodeId, ...owner });
    else reservations.push({ x: x + part.x, y: y + part.y, w: part.w, h: part.h });
  }
}
