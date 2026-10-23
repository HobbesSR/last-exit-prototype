import type { Box, Vec2, World } from '../types.ts';

/**
 * The top level of navigation (22.6): the portals generation guarantees between regions. A
 * portal is a node in both regions it joins, and within a region every pair of its portals is
 * an edge, since a region promises each portal is reachable from every other (20.1). The graph
 * is plain data, derived from a built map's regions and portals, so it can cross a worker the
 * way the map does. It knows nothing of geometry: a planner measures its edges through the
 * level below, a caller-supplied `Reach`.
 */
export interface PortalNode {
  /** The portal's id in both regions' briefs. */
  id: string;
  /** Where a route crosses it, its representative: the middle stand, or the line's midpoint when no hunter fits. */
  x: World;
  y: World;
  /** Every hunter stand on the portal's line, in order along it; empty when no hunter fits (22.6, "Nodes and stands"). */
  stands: Vec2[];
  /** The two regions it joins, by index into `regions`, and its index in each region's `portals`. */
  regions: [number, number];
  slots: [number, number];
}
export interface PortalRegion {
  id: string;
  /** The region's cells' bounds in world units. */
  box: Box;
  /** Its portals, by index into `portals`, in brief order. */
  portals: number[];
}
export interface PortalGraph {
  /** The owner grid: `owner[row * cols + col]` is the region holding that world cell, or -1. */
  cellSize: World;
  cols: number;
  rows: number;
  owner: Int32Array;
  regions: PortalRegion[];
  portals: PortalNode[];
}

const attached = new WeakMap<object, PortalGraph>();

/**
 * Give a map its portal graph as a runtime resource (22.6): held beside the map object, never as
 * one of its fields, so no projection, snapshot, recording or clone carries it. A map that crosses
 * a worker arrives without it, and its receiver attaches what was posted alongside.
 */
export function attachPortalGraph(map: object, graph: PortalGraph): void { attached.set(map, graph); }
/** The portal graph attached to a map, or undefined: a map without regions, such as `content-1`'s. */
export function portalGraphOf(map: object): PortalGraph | undefined { return attached.get(map); }

/** The region a world point lies in, or -1 outside every region. */
export function regionAt(graph: PortalGraph, point: Vec2): number {
  const col = Math.floor(point.x / graph.cellSize), row = Math.floor(point.y / graph.cellSize);
  if (col < 0 || row < 0 || col >= graph.cols || row >= graph.rows) return -1;
  return graph.owner[row * graph.cols + col]!;
}

/**
 * The level below, for one body: the travel length from `from` to each of `targets`, searched
 * within region `region` (an index into `regions`) and its clear margin, or null for a target it cannot reach. Distances are
 * symmetric, so a planner measures each pair once.
 */
export type Reach = (from: Vec2, targets: readonly Vec2[], region: number) => (World | null)[];

export type PortalRouteStatus = 'complete' | 'no-route' | 'invalid-endpoint';
export interface PortalRoute {
  status: PortalRouteStatus;
  /** The crossings to pass, then the goal; empty unless complete. */
  waypoints: Vec2[];
  /** Total length over the level below; Infinity unless complete. */
  length: World;
}

/**
 * Each region's portal-to-portal distances, `table[region][i * k + j]` for its `k` portals,
 * Infinity where the level below finds no way. Infinity is unconfirmed, not a broken promise:
 * the level below may be too coarse to see the passage (22.6, "Safety"). One reach per portal,
 * less the last.
 */
export function regionTables(graph: PortalGraph, reach: Reach): Float64Array[] {
  return graph.regions.map((region, index) => {
    const k = region.portals.length, table = new Float64Array(k * k).fill(Infinity);
    const points = region.portals.map(p => graph.portals[p]!);
    for (let i = 0; i < k; i++) table[i * k + i] = 0;
    for (let i = 0; i < k - 1; i++) {
      const lengths = reach(points[i]!, points.slice(i + 1), index);
      for (let j = i + 1; j < k; j++) { const d = lengths[j - i - 1] ?? null; if (d !== null) table[i * k + j] = table[j * k + i] = d; }
    }
    return table;
  });
}

/** A portal whose stands the level below does not join to its representative where 20.1 promises they do: unconfirmed, not proven divided. */
export interface DividedPortal { portal: string; region: string; unreached: number; stands: number }

/**
 * Each portal's stands, checked against its representative within every region on either side
 * that has two or more portals, where 20.1 promises they join. The portal's node stands for the
 * group that does join; the rest are reported here and not used (22.6, "Nodes and stands").
 */
export function standJoins(graph: PortalGraph, reach: Reach): DividedPortal[] {
  const divided: DividedPortal[] = [];
  // Region by region, so a level below that prepares each region once does so here too.
  graph.regions.forEach((region, index) => {
    if (region.portals.length < 2) return;
    for (const node of region.portals) {
      const portal = graph.portals[node]!;
      if (!portal.stands.length) continue;
      const unreached = reach(portal, portal.stands, index).filter(d => d === null).length;
      if (unreached) divided.push({ portal: portal.id, region: region.id, unreached, stands: portal.stands.length });
    }
  });
  return divided;
}

/**
 * Plans over one graph for one body: the region tables are measured once, when the planner is
 * made; a query adds one reach from the start and one from the goal over their regions'
 * portals, then searches the graph. The caller owns invalidation: a door change makes a new
 * planner, or will rebuild only the regions it touches (22.6, "Doors").
 */
export function createPortalPlanner(graph: PortalGraph, reach: Reach, tables: Float64Array[] = regionTables(graph, reach)) {
  const count = graph.portals.length;
  // Node numbers: portals are 0..count-1, the start is count and the goal count + 1.
  const START = count, GOAL = count + 1;

  return {
    tables,
    route(from: Vec2, to: Vec2): PortalRoute {
      const fromRegion = regionAt(graph, from), toRegion = regionAt(graph, to);
      if (fromRegion < 0 || toRegion < 0) return { status: 'invalid-endpoint', waypoints: [], length: Infinity };
      const at = (node: number): Vec2 => node === START ? from : node === GOAL ? to : graph.portals[node]!;
      const exits = graph.regions[fromRegion]!.portals, entries = graph.regions[toRegion]!.portals;
      const leave = reach(from, [...exits.map(p => graph.portals[p]!), ...fromRegion === toRegion ? [to] : []], fromRegion);
      // Distances are symmetric, so the goal's reach to its region's portals is each portal's last leg.
      const arrive = reach(to, entries.map(p => graph.portals[p]!), toRegion);
      const last = new Map<number, World>();
      entries.forEach((p, i) => { const d = arrive[i] ?? null; if (d !== null) last.set(p, d); });

      const best = new Float64Array(count + 2).fill(Infinity);
      const parent = new Int32Array(count + 2).fill(-1);
      const closed = new Uint8Array(count + 2);
      const heap = new Heap();
      const relax = (node: number, via: number, g: World) => {
        if (g >= best[node]!) return;
        best[node] = g; parent[node] = via;
        heap.push({ f: g + Math.hypot(to.x - at(node).x, to.y - at(node).y), g, node });
      };
      best[START] = 0; closed[START] = 1;
      exits.forEach((p, i) => { const d = leave[i] ?? null; if (d !== null) relax(p, START, d); });
      if (fromRegion === toRegion) { const d = leave[exits.length] ?? null; if (d !== null) relax(GOAL, START, d); }
      while (heap.size) {
        const { node, g } = heap.pop()!;
        if (closed[node] || g > best[node]!) continue;
        closed[node] = 1;
        if (node === GOAL) break;
        const portal = graph.portals[node]!;
        if (last.has(node)) relax(GOAL, node, g + last.get(node)!);
        for (let side = 0; side < 2; side++) {
          if (side === 1 && portal.regions[1] === portal.regions[0]) break;
          const region = graph.regions[portal.regions[side]!]!, table = tables[portal.regions[side]!]!;
          const k = region.portals.length, row = portal.slots[side]! * k;
          for (let j = 0; j < k; j++) {
            const next = region.portals[j]!, d = table[row + j]!;
            if (d !== Infinity && !closed[next]) relax(next, node, g + d);
          }
        }
      }
      if (!closed[GOAL]) return { status: 'no-route', waypoints: [], length: Infinity };
      const waypoints: Vec2[] = [];
      for (let node = GOAL; node !== START; node = parent[node]!) waypoints.push({ x: at(node).x, y: at(node).y });
      return { status: 'complete', waypoints: waypoints.reverse(), length: best[GOAL]! };
    },
  };
}

export interface Entry { f: World; g: World; node: number }

/**
 * A binary min-heap on `f`. Ties go to the larger `g`, which is nearer the goal, then to the
 * lower node number, so the search order never depends on insertion order.
 */
export class Heap {
  private items: Entry[] = [];
  get size(): number { return this.items.length; }
  private less(a: Entry, b: Entry): boolean { return a.f < b.f || a.f === b.f && (a.g > b.g || a.g === b.g && a.node < b.node); }
  push(entry: Entry): void {
    const items = this.items;
    items.push(entry);
    for (let i = items.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (!this.less(items[i]!, items[up]!)) break;
      [items[i], items[up]] = [items[up]!, items[i]!]; i = up;
    }
  }
  pop(): Entry | undefined {
    const items = this.items, top = items[0], last = items.pop();
    if (!items.length || !last) return top;
    items[0] = last;
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < items.length && this.less(items[l]!, items[m]!)) m = l;
      if (r < items.length && this.less(items[r]!, items[m]!)) m = r;
      if (m === i) break;
      [items[i], items[m]] = [items[m]!, items[i]!]; i = m;
    }
    return top;
  }
}
