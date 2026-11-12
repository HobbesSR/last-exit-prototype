import { bodyRadius, sweptClear } from '../movement.ts';
import { navigationClearance, navigationMap } from '../map/navigation.ts';
import { freePaths, mapFreeSpace, type FreeSpace } from '../free-space.ts';
import type { Box, CollisionMap, DoorPermission, Role, Vec2, World } from '../types.ts';
import type { PortalGraph, Reach } from './portal-graph.ts';

/**
 * The bottom level (22.6): the shape module's free-space mesh of each region and its clear margin,
 * eroded by one body's navigation clearance and searched for it. Paths come from the mesh;
 * collision judges every one, so a distance is a route the body can travel (22.6, "Safety").
 */

/** How far past a region's cells a search may go: a portal's clear margin lies across it (20.6). */
const MARGIN: World = 96;

/** A path the mesh found that collision refused: a defect in the mesh or its paths, never a route. */
export interface MeshDefect { region: number; from: Vec2; to: Vec2; segment: [Vec2, Vec2]; radius: World }

export type MeshReach = Reach & { defects: MeshDefect[] };

/**
 * Distances over the mesh for one body, with the door permission today's planner uses. Every
 * segment of every path is swept at the body's navigation clearance, except an endpoint's
 * connector into the eroded free space: a portal's stands and crossings are held to navigation
 * clearance there too, and any other point, such as a bot pressed against a wall, to the body's
 * own collision radius, since the body is already there (#421's rule). A path collision refuses
 * is recorded in `defects` and counts as unreached; it is not repaired by another search.
 */
export function meshReach(map: CollisionMap, role: Role, graph: PortalGraph, openDoors: DoorPermission = true): MeshReach {
  const navMap = navigationMap(map, openDoors), clearance = navigationClearance(role), body = bodyRadius({ role });
  const strict = new Set(graph.portals.flatMap(p => [p, ...p.stands]).map(p => `${p.x},${p.y}`));
  const radiusOf = (p: Vec2) => strict.has(`${p.x},${p.y}`) ? clearance : body;
  const domains = new Map<number, Box[]>();
  const defects: MeshDefect[] = [];
  // Taut paths in one region share their legs between corners, so each leg is swept once. Only
  // the latest region's verdicts are kept: a planner's tables visit the regions in turn.
  let swept = new Map<string, boolean>(), sweptRegion = -1;
  const clear = (a: Vec2, b: Vec2, radius: World) => {
    const key = `${a.x},${a.y},${b.x},${b.y},${radius}`;
    let verdict = swept.get(key);
    if (verdict === undefined) swept.set(key, verdict = sweptClear(navMap, a, b, radius));
    return verdict;
  };
  const reach = (from: Vec2, targets: readonly Vec2[], region: number) => {
    if (region !== sweptRegion) { swept = new Map(); sweptRegion = region; }
    let domain = domains.get(region);
    if (!domain) domains.set(region, domain = regionDomain(graph, region));
    const space = mapFreeSpace(navMap, `region ${region}`, domain, clearance);
    const fromRadius = radiusOf(from);
    if (!sweptClear(navMap, from, from, fromRadius)) return targets.map(() => null);
    const standing = targets.map(to => sweptClear(navMap, to, to, radiusOf(to)));
    // A point clear at the body's radius is within the clearance of the eroded space's edge, or walled off from it.
    const paths = freePaths(space, from, targets.filter((_, i) => standing[i]), clearance + 1);
    let next = 0;
    return targets.map((to, i) => {
      if (!standing[i]) return null;
      const path = paths[next++];
      if (!path) return null;
      const { points, leads } = path, last = points.length - 2;
      for (let s = 0; s <= last; s++) {
        const radius = Math.min(clearance, s === 0 && leads[0] ? fromRadius : clearance, s === last && leads[1] ? radiusOf(to) : clearance);
        if (!clear(points[s]!, points[s + 1]!, radius)) {
          defects.push({ region, from, to, segment: [points[s]!, points[s + 1]!], radius });
          return null;
        }
      }
      return path.length;
    });
  };
  return Object.assign(reach, { defects });
}

/** Every region's mesh for one body, built now if not already: what a planner's tables will search. */
export function regionMeshes(map: CollisionMap, role: Role, graph: PortalGraph, openDoors: DoorPermission = true): FreeSpace[] {
  const navMap = navigationMap(map, openDoors), clearance = navigationClearance(role);
  return graph.regions.map((_, region) => mapFreeSpace(navMap, `region ${region}`, regionDomain(graph, region), clearance));
}

/** A region's cells, row by row, each run widened by the margin. */
export function regionDomain(graph: PortalGraph, region: number): Box[] {
  const size = graph.cellSize, box = graph.regions[region]!.box, boxes: Box[] = [];
  const firstCol = Math.floor(box.x / size), firstRow = Math.floor(box.y / size);
  for (let row = firstRow; row < firstRow + box.h / size; row++) {
    for (let col = firstCol; col < firstCol + box.w / size; col++) {
      if (graph.owner[row * graph.cols + col] !== region) continue;
      const start = col;
      while (col + 1 < firstCol + box.w / size && graph.owner[row * graph.cols + col + 1] === region) col++;
      boxes.push({ x: start * size - MARGIN, y: row * size - MARGIN, w: (col + 1 - start) * size + 2 * MARGIN, h: size + 2 * MARGIN });
    }
  }
  return boxes;
}
