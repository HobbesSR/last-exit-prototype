import { transform } from '../shape.ts';
import type { Shape } from '../shape.ts';
import type { BaseGenerationContext } from './context.ts';
import type { Box, Cell, BuildingAppearance, BuildingId, Decal, GateId, MapAppearance, NodeId, ObstacleAppearance, ObstacleKind, Vec2, World } from '../types.ts';

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
  | { part: 'obstacle'; shape: Shape; kind: ObstacleKind; appearance?: ObstacleAppearance | undefined }
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
  /** Optional presentation descriptor: building/obstacle appearance, ground marks, or lighting. */
  appearance?: BuildingAppearance | MapAppearance | undefined;
}

export interface Placement {
  nodeId: NodeId;
  /** Whether this instance's doors start locked. A placement choice, not a property of the template. */
  locked?: boolean;
}

/** Stamp a template with its anchor at `x`,`y`, emitting every part into the map being generated. */

function isMapAppearance(app: BuildingAppearance | MapAppearance): app is MapAppearance {
  return 'surfaces' in app || 'commercial' in app || 'wear' in app || 'scars' in app || 'lighting' in app || 'buildings' in app || 'obstacles' in app;
}

export function placeElement(context: BaseGenerationContext, template: ElementTemplate, x: World, y: World, placement: Placement): void {
  const { map, nextId, shape, spots, reservations } = context;
  let owner: { buildingId: BuildingId } | undefined;
  const buildingDesc: BuildingAppearance | undefined = template.appearance
    ? (isMapAppearance(template.appearance)
        ? (template.appearance.buildings?.main ?? template.appearance.buildings?.building ?? Object.values(template.appearance.buildings ?? {})[0])
        : template.appearance)
    : undefined;
  if (template.encloses) {
    const building = {
      id: nextId('building-') as BuildingId,
      x,
      y,
      w: template.w,
      h: template.h,
      nodeId: placement.nodeId,
      ...(buildingDesc ? { appearance: buildingDesc } : {}),
    };
    map.buildings.push(building);
    owner = { buildingId: building.id };
  }
  if (template.appearance) {
    if (isMapAppearance(template.appearance)) {
      const app = template.appearance;
      const target = (map.appearance ??= {});
      if (app.surfaces?.length) {
        (target.surfaces ??= []).push(...app.surfaces.map(s => ({
          ...s,
          bounds: { x: s.bounds.x + x, y: s.bounds.y + y, w: s.bounds.w, h: s.bounds.h },
        })));
      }
      if (app.commercial?.length) {
        (target.commercial ??= []).push(...app.commercial.map(c => ({
          ...c,
          bounds: { x: c.bounds.x + x, y: c.bounds.y + y, w: c.bounds.w, h: c.bounds.h },
        })));
      }
      if (app.wear?.length) {
        (target.wear ??= []).push(...app.wear.map(w => ({
          ...w,
          bounds: { x: w.bounds.x + x, y: w.bounds.y + y, w: w.bounds.w, h: w.bounds.h },
        })));
      }
      if (app.scars?.length) {
        (target.scars ??= []).push(...app.scars.map(s => ({
          ...s,
          bounds: { x: s.bounds.x + x, y: s.bounds.y + y, w: s.bounds.w, h: s.bounds.h },
        })));
      }
      if (app.lighting?.fields?.length) {
        const lighting = (target.lighting ??= {});
        (lighting.fields ??= []).push(...app.lighting.fields.map(f => ({
          ...f,
          bounds: { x: f.bounds.x + x, y: f.bounds.y + y, w: f.bounds.w, h: f.bounds.h },
          ...(f.focalEdge
            ? {
                focalEdge: {
                  ...f.focalEdge,
                  ...(f.focalEdge.x !== undefined ? { x: f.focalEdge.x + x } : {}),
                  ...(f.focalEdge.y !== undefined ? { y: f.focalEdge.y + y } : {}),
                  ...(f.focalEdge.rimLine
                    ? {
                        rimLine: {
                          ...f.focalEdge.rimLine,
                          x1: f.focalEdge.rimLine.x1 + x,
                          y1: f.focalEdge.rimLine.y1 + y,
                          x2: f.focalEdge.rimLine.x2 + x,
                          y2: f.focalEdge.rimLine.y2 + y,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        })));
      }
      if (app.buildings) {
        const bMap = (target.buildings ??= {});
        const single = Object.keys(app.buildings).length === 1;
        for (const [key, desc] of Object.entries(app.buildings)) {
          if (owner && (key === 'main' || key === 'building' || key === owner.buildingId || single)) {
            bMap[owner.buildingId] = desc;
          } else {
            bMap[key] = desc;
          }
        }
      }
      if (app.obstacles) {
        const oMap = (target.obstacles ??= {});
        for (const [key, desc] of Object.entries(app.obstacles)) {
          oMap[key] = desc;
        }
      }
    } else if (owner && buildingDesc) {
      const target = (map.appearance ??= {});
      (target.buildings ??= {})[owner.buildingId] = buildingDesc;
    }
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
    if (part.part === 'obstacle') {
      const o = shape(transform(part.shape, x, y), part.kind, { ...owner, ...(part.appearance ? { appearance: part.appearance } : {}) });
      if (part.appearance) {
        const target = (map.appearance ??= {});
        (target.obstacles ??= {})[o.id] = part.appearance;
      }
    }
    else if (part.part === 'gate') map.gates.push({ id: nextId('door-') as GateId, x: x + part.x, y: y + part.y, w: part.w, h: part.h, open: false, locked: !!placement.locked, kind: 'door', ...owner });
    else if (part.part === 'spot') spots.push({ x: x + part.x, y: y + part.y, nodeId: placement.nodeId, ...owner });
    else reservations.push({ x: x + part.x, y: y + part.y, w: part.w, h: part.h });
  }
}
