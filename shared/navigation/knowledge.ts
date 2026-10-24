import { discoveryGrid } from '../discovery.ts';
import { closestOnSegment, entry, freeSpaceTile, packTiles, pullTaut, type FreeTile, type PackedTiles } from '../free-space.ts';
import { navigationClearance } from '../map/navigation.ts';
import type { Box, CollisionMap, DiscoveryMemory, GateId, GateObservation, Role, Vec2, World } from '../types.ts';
import { Heap } from './portal-graph.ts';

/**
 * What one contestant may plan with (22.6, "Knowledge and optimistic planning"). The map is cut
 * into tiles on the discovery grid, each triangulated from the geometry within its reach alone
 * (`freeSpaceTile`), so a tile is known exactly when every cell its reach touches, its support,
 * is known: its triangles are then a function of what the contestant has seen. Unknown cells
 * inside the public world bounds are assumed open, costed in straight lines. Doors are edge
 * states: a tile is built with them open and each contestant applies its own last observation.
 * The planner reads the map only through known tiles and the map's public dimensions.
 */
export interface Knowledge {
  /** Whether a discovery cell's layout is known. */
  known(cell: number): boolean;
  /** A door as last observed; undefined when never observed, which a plan treats optimistically. */
  door(id: GateId): GateObservation | undefined;
  /** Keys held, each spent on one locked door. */
  keys: number;
  /** Changes whenever what is known does, so a route made under another revision is stale. */
  revision: number;
}

/** A contestant's knowledge: cells it has surveyed or discovered, doors as it observed them, its keys. */
export function contestantKnowledge(memory: DiscoveryMemory, keys: number): Knowledge {
  return {
    known: cell => memory.discovered.has(cell) || !!memory.surveyed?.has(cell),
    door: id => memory.gates?.get(id),
    keys,
    revision: memory.revision ?? 0,
  };
}

export type KnownRouteStatus = 'complete' | 'speculative' | 'no-known-route' | 'invalid-endpoint' | 'budget-exhausted' | 'stale';
export interface KnownRoute {
  status: KnownRouteStatus;
  /**
   * The tentative route from the start, taut, ending at the goal; for `budget-exhausted`, at the
   * point searched nearest the goal. Empty without one.
   */
  points: Vec2[];
  length: World;
  /**
   * The leading part of `points` the contestant knows it can travel: through known tiles and
   * doors it has observed, ending where the route first leaves them, at the frontier, or at the
   * goal when the whole route is confirmed.
   */
  prefix: Vec2[];
  /** The locked doors the route spends keys on, in order. */
  doors: GateId[];
  /** Places expanded: the deterministic measure a budget limits. */
  expansions: number;
  /** Known tiles the search read. */
  tiles: number;
  /** The knowledge revision and keys held it was planned under. */
  revision: number;
  keys: number;
}

/** A route query in progress (`createKnowledgePlanner(...).search`). */
export interface RouteSearch {
  /** Places expanded so far. */
  readonly expansions: number;
  /** Expand up to `limit` more places: the route once the search has ended, else null. */
  advance(limit: number): KnownRoute | null;
}

/**
 * A copy of `knowledge` as it stands, for a search spread over ticks: the cells it knows and the
 * doors it has observed now, whatever is learnt while the search runs.
 */
export function frozenKnowledge(knowledge: Knowledge, cells: number, doors: Iterable<GateId>): Knowledge {
  const known = new Uint8Array(cells), seen = new Map<GateId, GateObservation>();
  for (let cell = 0; cell < cells; cell++) known[cell] = +knowledge.known(cell);
  for (const id of doors) { const door = knowledge.door(id); if (door) seen.set(id, { open: door.open, locked: door.locked }); }
  return { known: cell => known[cell] === 1, door: id => seen.get(id), keys: knowledge.keys, revision: knowledge.revision };
}

/** Expansions a query may make before it reports `budget-exhausted`: a count, never a clock (22.6). */
export const ROUTE_BUDGET = 200_000;

/** A route planned under other knowledge than `knowledge` is stale, whatever its status was. */
export function checkRoute(route: KnownRoute, knowledge: Knowledge): KnownRoute {
  return route.revision === knowledge.revision && route.keys === knowledge.keys ? route : { ...route, status: 'stale' };
}

// A search state is a place, a known triangle or an unknown cell, with the keys spent reaching
// it. Its key is built from the cell and the triangle's number within its tile, both public or
// known, so the search order never depends on hidden geometry.
const TRI = 2 ** 20, USED = 16, GOAL = -1;
const keyOf = (cell: number, tri: number, used: number) => (cell * TRI + tri + 1) * USED + used;

interface State {
  g: World;
  /** Where the route enters the place. */
  x: World;
  y: World;
  parent: number;
  /** The portal entered through: left end, then right end. */
  portal: [number, number, number, number] | null;
  confirmed: boolean;
  spent: GateId[];
}

/**
 * Every tile a planner for `role` can read, built and packed to cross a worker (22.6, "Bot
 * adoption"). A gladiator plans over the whole map, so its first plan would otherwise build them all
 * on one tick; the map worker builds them beside the map, and the room adopts them.
 */
export function packedTilesFor(map: CollisionMap, role: Role): PackedTiles {
  const planner = createKnowledgePlanner(map, role), { cols, rows, size } = discoveryGrid(map);
  const all: Knowledge = { known: () => true, door: () => undefined, keys: 0, revision: 0 };
  return packTiles(Array.from({ length: cols * rows }, (_, cell) => planner.tile(all, cell)!), navigationClearance(role), size, cols);
}

/** Plans for one body over the knowledge a caller supplies at each query; the map is read only through known tiles. */
export function createKnowledgePlanner(map: CollisionMap, role: Role) {
  const clearance = navigationClearance(role), { cols, rows, size } = discoveryGrid(map);
  // How far a tile's geometry reaches past its cell, as `freeSpaceTile` widens it.
  const reach = clearance + 0.2 + 1;
  const boxOf = (cell: number): Box => {
    const col = cell % cols, row = Math.floor(cell / cols), x = col * size, y = row * size;
    return { x, y, w: Math.min(size, map.width - x), h: Math.min(size, map.height - y) };
  };
  const cellAt = (p: Vec2) => p.x < 0 || p.y < 0 || p.x >= map.width || p.y >= map.height ? -1 : Math.floor(p.y / size) * cols + Math.floor(p.x / size);

  /** The cells a tile's reach touches: it is known only when all of them are. */
  const support = (cell: number): number[] => {
    const box = boxOf(cell), cells: number[] = [];
    const c0 = Math.max(0, Math.floor((box.x - reach) / size)), c1 = Math.min(cols - 1, Math.floor((box.x + box.w + reach) / size));
    const r0 = Math.max(0, Math.floor((box.y - reach) / size)), r1 = Math.min(rows - 1, Math.floor((box.y + box.h + reach) / size));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(r * cols + c);
    return cells;
  };

  /** The tile of a cell if its whole support is known, else null. */
  const tile = (knowledge: Knowledge, cell: number): FreeTile | null =>
    support(cell).every(c => knowledge.known(c)) ? freeSpaceTile(map, boxOf(cell), clearance) : null;

  return {
    support,
    tile,
    route(knowledge: Knowledge, from: Vec2, to: Vec2, budget: number = ROUTE_BUDGET): KnownRoute {
      return search(knowledge, from, to, budget).advance(Infinity)!;
    },
    search,
  };

  /**
   * A route query that can be advanced a number of expansions at a time, so one search may span
   * several ticks (#470). Advanced in slices or all at once, it expands the same places in the same
   * order and returns the same route. It reads `knowledge` as it goes, so a caller spreading it over
   * ticks passes knowledge that does not change meanwhile (`frozenKnowledge`).
   */
  function search(knowledge: Knowledge, from: Vec2, to: Vec2, budget: number = ROUTE_BUDGET): RouteSearch {
    const tiles = new Map<number, FreeTile | null>();
    const tileAt = (cell: number) => {
      let found = tiles.get(cell);
      if (found === undefined) tiles.set(cell, found = tile(knowledge, cell));
      return found;
    };
    const result = (status: KnownRouteStatus, expansions = 0): KnownRoute =>
      ({ status, points: [], length: Infinity, prefix: [], doors: [], expansions, tiles: [...tiles.values()].filter(Boolean).length, revision: knowledge.revision, keys: knowledge.keys });

    // A point's place: the known triangle it enters, in its own tile or a known neighbour's, or its unknown cell.
    const placeOf = (p: Vec2): { cell: number; tri: number; point: Vec2; moved: boolean } | null => {
      const cell = cellAt(p);
      if (cell < 0) return null;
      if (!tileAt(cell)) return { cell, tri: -1, point: { x: p.x, y: p.y }, moved: false };
      let best: { cell: number; tri: number; point: Vec2; moved: boolean } | null = null, distance = Infinity;
      for (const c of support(cell)) {
        const tile = tileAt(c), found = tile && entry(tile, p, clearance + 1);
        if (!found) continue;
        const d = Math.hypot(found.point.x - p.x, found.point.y - p.y);
        if (d < distance) { distance = d; best = { cell: c, tri: found.triangle, point: { x: found.point.x, y: found.point.y }, moved: found.point !== p }; }
      }
      return best;
    };
    const start = placeOf(from), goal = placeOf(to);
    if (!start || !goal) { const done = result('invalid-endpoint'); return { expansions: 0, advance: () => done }; }

    const states = new Map<number, State>(), closed = new Set<number>(), heap = new Heap();
    const goalKey = (cell: number, tri: number) => cell === goal.cell && tri === goal.tri;
    const relax = (key: number, state: State) => {
      const old = states.get(key);
      if (old && old.g <= state.g || closed.has(key)) return;
      states.set(key, state);
      heap.push({ f: state.g + Math.hypot(goal.point.x - state.x, goal.point.y - state.y), g: state.g, node: key });
    };
    /** Enter a place through portal `p`–`q` from the state `parent` at `at`: costed to the portal's nearest point. */
    const enter = (parent: number, at: State, cell: number, tri: number, used: number, p: Vec2, q: Vec2, confirmed: boolean, spent: GateId[]) => {
      const centre = centreOf(cell, tri), crossing = closestOnSegment(at, p, q);
      const left = (q.x - p.x) * (centre.y - p.y) - (q.y - p.y) * (centre.x - p.x) > 0;
      relax(keyOf(cell, tri, used), {
        g: at.g + Math.hypot(crossing.x - at.x, crossing.y - at.y), x: crossing.x, y: crossing.y, parent,
        portal: left ? [p.x, p.y, q.x, q.y] : [q.x, q.y, p.x, p.y], confirmed: at.confirmed && confirmed, spent,
      });
    };
    const centreOf = (cell: number, tri: number): Vec2 => {
      if (tri < 0) { const b = boxOf(cell); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }
      const t = tileAt(cell)!, v = t.triangles;
      return { x: (t.points[v[tri * 3]! * 2]! + t.points[v[tri * 3 + 1]! * 2]! + t.points[v[tri * 3 + 2]! * 2]!) / 3,
        y: (t.points[v[tri * 3]! * 2 + 1]! + t.points[v[tri * 3 + 1]! * 2 + 1]! + t.points[v[tri * 3 + 2]! * 2 + 1]!) / 3 };
    };
    /**
     * Entering a known triangle from a place with doors `through`: null when a locked door needs
     * a key none is left for. A door already passed through costs nothing more; one never observed
     * is assumed openable but leaves the route unconfirmed.
     */
    const doorsInto = (tile: FreeTile, tri: number, used: number, through: readonly GateId[]) => {
      const set = tile.gateSet[tri]!;
      if (set < 0) return { used, confirmed: true, spent: [] as GateId[] };
      let confirmed = true;
      const spent: GateId[] = [];
      for (const id of tile.gateSets[set]! as GateId[]) {
        const seen = knowledge.door(id);
        if (!seen) { confirmed = false; continue; }
        if (seen.open || !seen.locked || through.includes(id)) continue;
        if (used + spent.length >= Math.min(knowledge.keys, USED - 1)) return null;
        spent.push(id);
      }
      return { used: used + spent.length, confirmed, spent };
    };
    const gatesOf = (cell: number, tri: number): readonly GateId[] => {
      if (tri < 0) return [];
      const tile = tileAt(cell)!, set = tile.gateSet[tri]!;
      return set < 0 ? [] : tile.gateSets[set]! as GateId[];
    };
    /** Enter a known triangle, through its doors. */
    const enterTriangle = (parent: number, at: State, used: number, through: readonly GateId[], cell: number, tri: number, p: Vec2, q: Vec2) => {
      const doors = doorsInto(tileAt(cell)!, tri, used, through);
      if (doors) enter(parent, at, cell, tri, doors.used, p, q, doors.confirmed, doors.spent);
    };

    const startDoors = start.tri < 0 ? { used: 0, confirmed: false, spent: [] } : doorsInto(tileAt(start.cell)!, start.tri, 0, []) ?? { used: 0, confirmed: false, spent: [] };
    relax(keyOf(start.cell, start.tri, startDoors.used), { g: 0, x: start.point.x, y: start.point.y, parent: GOAL, portal: null, confirmed: start.tri >= 0 && startDoors.confirmed, spent: startDoors.spent });

    let expansions = 0, nearest = -2, nearestH = Infinity;
    let reached = false, exhausted = false, done: KnownRoute | null = null;
    /** Expand up to `limit` more places; the route once the search has ended, else null. */
    const advance = (limit: number): KnownRoute | null => {
      if (done) return done;
      for (let n = 0; heap.size && n < limit;) {
        const { node: key, g } = heap.pop()!;
        if (closed.has(key) || g > (states.get(key)?.g ?? Infinity)) continue;
        if (key === GOAL) { reached = true; break; }
        // The budget is spent: report the place nearest the goal, never more expansions than the budget.
        if (expansions >= budget) { exhausted = true; break; }
        closed.add(key);
        expansions++; n++;
        const at = states.get(key)!, used = key % USED, place = Math.floor(key / USED), cell = Math.floor(place / TRI), tri = place % TRI - 1;
        const h = Math.hypot(goal.point.x - at.x, goal.point.y - at.y);
        if (h < nearestH) { nearestH = h; nearest = key; }
        if (goalKey(cell, tri)) {
          const g2 = at.g + Math.hypot(goal.point.x - at.x, goal.point.y - at.y), old = states.get(GOAL);
          if (!old || g2 < old.g) { states.set(GOAL, { g: g2, x: goal.point.x, y: goal.point.y, parent: key, portal: null, confirmed: at.confirmed, spent: [] }); heap.push({ f: g2, g: g2, node: GOAL }); }
        }
        const through = gatesOf(cell, tri);
        if (tri >= 0) {
          const tile = tileAt(cell)!, box = boxOf(cell);
          for (let k = 0; k < 3; k++) {
            const s = tri * 3 + k, twin = tile.twins[s]!, p = vertex(tile, tile.triangles[s]!), q = vertex(tile, tile.triangles[tri * 3 + (k + 1) % 3]!);
            if (twin >= 0) { enterTriangle(key, at, used, through, cell, Math.floor(twin / 3), p, q); continue; }
            const side = sideOf(box, p, q), next = side < 0 ? -1 : neighbour(cell, side);
            if (next < 0) continue;
            const other = tileAt(next);
            if (!other) { enter(key, at, next, -1, used, p, q, false, []); continue; }
            // Tiles meet edge to edge, but a seam's points may be rounded apart by a step of the integer grid: match by overlap.
            for (const s2 of sideEdges(other, boxOf(next), (side + 2) % 4)) {
              const overlap = overlapOf(p, q, vertex(other, other.triangles[s2]!), vertex(other, other.triangles[Math.floor(s2 / 3) * 3 + (s2 % 3 + 1) % 3]!), side);
              if (overlap) enterTriangle(key, at, used, through, next, Math.floor(s2 / 3), overlap[0], overlap[1]);
            }
          }
        } else {
          const box = boxOf(cell);
          for (let side = 0; side < 4; side++) {
            const next = neighbour(cell, side);
            if (next < 0) continue;
            const other = tileAt(next);
            if (!other) { const [p, q] = sideSegment(box, side); enter(key, at, next, -1, used, p, q, false, []); continue; }
            for (const s2 of sideEdges(other, boxOf(next), (side + 2) % 4))
              enterTriangle(key, at, used, through, next, Math.floor(s2 / 3), vertex(other, other.triangles[s2]!), vertex(other, other.triangles[Math.floor(s2 / 3) * 3 + (s2 % 3 + 1) % 3]!));
          }
        }
      }
      if (!reached && !exhausted && heap.size) return null;
      return done = finish();
    };
    const finish = (): KnownRoute => {
      const end = reached ? GOAL : exhausted ? nearest : -2;
      if (end === -2) return result(exhausted ? 'budget-exhausted' : 'no-known-route', expansions);
      const chain: State[] = [];
      for (let k = end; ; k = states.get(k)!.parent) { chain.push(states.get(k)!); if (states.get(k)!.parent === GOAL) break; }
      chain.reverse();
      const target = end === GOAL ? goal.point : { x: chain.at(-1)!.x, y: chain.at(-1)!.y };
      // Portals between places; the goal's own state has none.
      const portals = chain.slice(1).filter(s => s.portal).map(s => s.portal!);
      const ids = new Map<string, number>(), idOf = (x: number, y: number) => { const k = `${x},${y}`; let id = ids.get(k); if (id === undefined) ids.set(k, id = ids.size); return id; };
      const count = portals.length + 2, ends = new Int32Array(count * 2), xy = new Float64Array(count * 4);
      ends.set([-1, -1], 0); ends.set([-2, -2], (count - 1) * 2);
      xy.set([start.point.x, start.point.y, start.point.x, start.point.y], 0); xy.set([target.x, target.y, target.x, target.y], (count - 1) * 4);
      portals.forEach((portal, i) => { ends[(i + 1) * 2] = idOf(portal[0], portal[1]); ends[(i + 1) * 2 + 1] = idOf(portal[2], portal[3]); xy.set(portal, (i + 1) * 4); });
      const taut = pullTaut(start.point, target, ends, xy);

      // The prefix ends where the route crosses into the first unconfirmed place.
      const firstUnconfirmed = chain.findIndex(s => !s.confirmed);
      let prefix: Vec2[];
      if (firstUnconfirmed < 0) prefix = taut;
      else if (firstUnconfirmed === 0) prefix = [taut[0]!];
      else prefix = cutAt(taut, portals.slice(0, firstUnconfirmed));
      const points = [...start.moved ? [{ x: from.x, y: from.y }] : [], ...taut, ...end === GOAL && goal.moved ? [{ x: to.x, y: to.y }] : []];
      if (start.moved) prefix = [{ x: from.x, y: from.y }, ...prefix];
      if (firstUnconfirmed < 0 && end === GOAL && goal.moved) prefix = [...prefix, { x: to.x, y: to.y }];
      let length = 0;
      for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
      const status: KnownRouteStatus = end !== GOAL ? 'budget-exhausted' : firstUnconfirmed < 0 ? 'complete' : 'speculative';
      return { ...result(status, expansions), points, length, prefix, doors: chain.flatMap(s => s.spent) };
    };
    return { get expansions() { return expansions; }, advance };
  }

  /** The neighbouring cell across a side (0 west, 1 north, 2 east, 3 south), or -1 past the world's edge. */
  function neighbour(cell: number, side: number): number {
    const col = cell % cols, row = Math.floor(cell / cols);
    const c = col + (side === 0 ? -1 : side === 2 ? 1 : 0), r = row + (side === 1 ? -1 : side === 3 ? 1 : 0);
    return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
  }
}

const vertex = (tile: FreeTile, v: number): Vec2 => ({ x: tile.points[v * 2]!, y: tile.points[v * 2 + 1]! });

/** Which side of `box` an edge lies along (0 west, 1 north, 2 east, 3 south), or -1. */
function sideOf(box: Box, p: Vec2, q: Vec2): number {
  if (p.x === box.x && q.x === box.x) return 0;
  if (p.y === box.y && q.y === box.y) return 1;
  if (p.x === box.x + box.w && q.x === box.x + box.w) return 2;
  if (p.y === box.y + box.h && q.y === box.y + box.h) return 3;
  return -1;
}

function sideSegment(box: Box, side: number): [Vec2, Vec2] {
  const { x, y, w, h } = box;
  return side === 0 ? [{ x, y }, { x, y: y + h }] : side === 1 ? [{ x, y }, { x: x + w, y }]
    : side === 2 ? [{ x: x + w, y }, { x: x + w, y: y + h }] : [{ x, y: y + h }, { x: x + w, y: y + h }];
}

const sides = new WeakMap<FreeTile, number[][]>();
/** A tile's boundary edges along one side of its box, as edge slots. */
function sideEdges(tile: FreeTile, box: Box, side: number): number[] {
  let lists = sides.get(tile);
  if (!lists) {
    lists = [[], [], [], []];
    for (let s = 0; s < tile.twins.length; s++) {
      if (tile.twins[s]! >= 0) continue;
      const t = Math.floor(s / 3), k = s % 3, found = sideOf(box, vertex(tile, tile.triangles[s]!), vertex(tile, tile.triangles[t * 3 + (k + 1) % 3]!));
      if (found >= 0) lists[found]!.push(s);
    }
    sides.set(tile, lists);
  }
  return lists[side]!;
}

/** The shared stretch of two edges on one side line, or null when they share less than a millionth of a unit. */
function overlapOf(p: Vec2, q: Vec2, r: Vec2, s: Vec2, side: number): [Vec2, Vec2] | null {
  const along = side % 2 === 0 ? 'y' : 'x';
  const lo = Math.max(Math.min(p[along], q[along]), Math.min(r[along], s[along])), hi = Math.min(Math.max(p[along], q[along]), Math.max(r[along], s[along]));
  if (hi - lo <= 1e-6) return null;
  return along === 'y' ? [{ x: p.x, y: lo }, { x: p.x, y: hi }] : [{ x: lo, y: p.y }, { x: hi, y: p.y }];
}

/**
 * The taut path up to where it crosses the last of `portals`, which it crosses in order: each
 * segment is followed until it meets the next portal, and the path ends at its crossing of the last.
 */
function cutAt(path: readonly Vec2[], portals: readonly [number, number, number, number][]): Vec2[] {
  let segment = 0, crossing: Vec2 = path[0]!;
  for (const portal of portals) {
    for (; segment < path.length - 1; segment++) {
      const hit = meet(path[segment]!, path[segment + 1]!, { x: portal[0], y: portal[1] }, { x: portal[2], y: portal[3] });
      if (hit) { crossing = hit; break; }
    }
  }
  return [...path.slice(0, segment + 1), crossing].filter((p, i, all) => i === 0 || p.x !== all[i - 1]!.x || p.y !== all[i - 1]!.y);
}

/** Where segment ab meets segment cd, within a millionth of a unit, or null. */
function meet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
  const eps = 1e-6;
  if (Math.abs(den) > eps * Math.hypot(rx, ry) * Math.hypot(sx, sy)) {
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den, u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    const tol = eps / Math.max(eps, Math.hypot(rx, ry)), tolU = eps / Math.max(eps, Math.hypot(sx, sy));
    return t >= -tol && t <= 1 + tol && u >= -tolU && u <= 1 + tolU ? { x: a.x + t * rx, y: a.y + t * ry } : null;
  }
  // Parallel: the path runs along the portal, meeting it at its first point on it.
  for (const p of [a, b]) { const n = closestOnSegment(p, c, d); if (Math.hypot(n.x - p.x, n.y - p.y) <= eps) return p; }
  return null;
}
