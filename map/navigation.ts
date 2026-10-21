/** Derive navigation's top level from a built map's regions and portals (22.6). Nothing here is saved. */
import { portalStands } from './micro/portals.ts';
import { builtMapFrame } from './micro/adapter.ts';
import type { PortalGraph, PortalNode, PortalRegion } from '../shared/navigation/portal-graph.ts';
import type { Vec2 } from '../shared/types.ts';
import type { BuiltMap, RegionElement } from './micro/types.ts';

/**
 * The portal graph of a built map, in the world `builtMapFrame` places it, the frame live
 * assembly uses. Each portal is crossed at its middle hunter stand, or its line's midpoint when
 * it is too short for a hunter, so a route passes where generation proved a body fits.
 * Deterministic: regions in id order and portals in each brief's order, as `BuiltMap` holds them.
 */
export function buildPortalGraph(built: BuiltMap<RegionElement>, origin: Vec2 = builtMapFrame(built).origin): PortalGraph {
  const { width, height } = builtMapFrame(built), size = built.cellSize;
  const cols = Math.ceil(width / size), rows = Math.ceil(height / size);
  const owner = new Int32Array(cols * rows).fill(-1);
  const portals: PortalNode[] = [], byId = new Map<string, number>();
  const regions: PortalRegion[] = built.regions.map((region, index) => {
    const { brief } = region;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cell of brief.cells) {
      const col = cell.x + origin.x / size, row = cell.y + origin.y / size;
      owner[row * cols + col] = index;
      minX = Math.min(minX, col); minY = Math.min(minY, row); maxX = Math.max(maxX, col); maxY = Math.max(maxY, row);
    }
    const ids: number[] = [];
    for (const { portal, points } of portalStands(brief)) {
      let node = byId.get(portal.id);
      if (node === undefined) {
        const crossing = points[Math.floor((points.length - 1) / 2)] ?? midpoint(portal, size);
        node = portals.push({ id: portal.id, x: crossing.x + origin.x, y: crossing.y + origin.y, regions: [index, index], slots: [ids.length, ids.length] }) - 1;
        byId.set(portal.id, node);
      } else { portals[node]!.regions[1] = index; portals[node]!.slots[1] = ids.length; }
      ids.push(node);
    }
    return { id: brief.id, box: { x: minX * size, y: minY * size, w: (maxX - minX + 1) * size, h: (maxY - minY + 1) * size }, portals: ids };
  });
  return { cellSize: size, cols, rows, owner, regions, portals };
}

/** The middle of a portal's line, in the brief's frame. */
function midpoint(portal: { axis: 'h' | 'v'; x: number; y: number; length: number }, size: number): Vec2 {
  return portal.axis === 'h' ? { x: (portal.x + portal.length / 2) * size, y: portal.y * size } : { x: portal.x * size, y: (portal.y + portal.length / 2) * size };
}
