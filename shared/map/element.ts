import { transform } from '../shape.ts';
import type { Shape } from '../shape.ts';
import type { BaseGenerationContext } from './context.ts';
import type { Box, Cell, BuildingId, Decal, GateId, NodeId, ObstacleKind, Vec2, World } from '../types.ts';

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

export interface ElementRoof {
  /** Unique within the template; stamping prefixes it with the placement, so reuse never collides. */
  id?: string | undefined;
  /** Presentation (fade) group, unique within `groupScope`. Without one the roof fades alone. */
  groupId?: string | undefined;
  /**
   * Where `groupId` is unique. `element` (the default) is this placement alone, so instances of a
   * reused template never fade together. `region` spans every element its region stamps, for one
   * assembly placed as several elements (split building pieces); its builder keeps the id unique there.
   */
  groupScope?: 'element' | 'region' | undefined;
  cells: Cell[];
  bounds?: Box | undefined;
  cellSize?: number | undefined;
  origin?: Vec2 | undefined;
  overhang?: number | undefined;
  thresholds?: Cell[] | undefined;
}

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
  /** Declared roofs on the cell grid, supporting concave, holed, and grouped rooms. */
  roofs?: ElementRoof[] | undefined;
  /** Ground markings at its doors and windows, local to the anchor. They take no id (56.2). */
  decals?: Decal[] | undefined;
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
  if (template.roofs?.length) {
    if (!map.roofs) map.roofs = [];
    // Roof ids and element-scoped groups are namespaced by this placement: its building, else the
    // count of roofs before it. Never the shared id serial, which would renumber everything after.
    const scope = owner?.buildingId ?? `roofs-${map.roofs.length + 1}`;
    for (const [i, r] of template.roofs.entries()) {
      const roofId = owner && template.roofs.length === 1 ? owner.buildingId : `${scope}.${r.id ?? i + 1}`;
      const groupId = r.groupId === undefined ? roofId
        : `${r.groupScope === 'region' ? placement.nodeId : scope}/${r.groupId}`;
      const cellSize = r.cellSize ?? 40;
      const roofOrigin = { x: x + (r.origin?.x ?? 0), y: y + (r.origin?.y ?? 0) };
      const bounds = r.bounds
        ? { x: x + r.bounds.x, y: y + r.bounds.y, w: r.bounds.w, h: r.bounds.h }
        : { x, y, w: template.w, h: template.h };
      map.roofs.push({
        id: roofId,
        groupId,
        bounds,
        origin: roofOrigin,
        cellSize,
        cells: r.cells,
        ...(r.overhang !== undefined ? { overhang: r.overhang } : {}),
        ...(r.thresholds?.length ? { thresholds: r.thresholds } : {}),
        ...(owner ? { buildingId: owner.buildingId } : {}),
      });
    }
  }
  if (template.decals?.length) (map.decals ??= []).push(...template.decals.map(d => ({ ...d, x: x + d.x, y: y + d.y })));
  for (const part of template.parts) {
    if (part.part === 'obstacle') shape(transform(part.shape, x, y), part.kind, { ...owner });
    else if (part.part === 'gate') map.gates.push({ id: nextId('door-') as GateId, x: x + part.x, y: y + part.y, w: part.w, h: part.h, open: false, locked: !!placement.locked, kind: 'door', ...owner });
    else if (part.part === 'spot') spots.push({ x: x + part.x, y: y + part.y, nodeId: placement.nodeId, ...owner });
    else reservations.push({ x: x + part.x, y: y + part.y, w: part.w, h: part.h });
  }
}
