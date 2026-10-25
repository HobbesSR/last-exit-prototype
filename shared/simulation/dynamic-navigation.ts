import { lineClear, sweptClear, VISION } from '../movement.ts';
import { bounds, segmentShapeDistance, type Shape } from '../shape.ts';
import { roofConceals } from '../view.ts';
import { discoveryGrid } from '../discovery.ts';
import { actorRadius } from './actor-physics.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { visibleTo } from './visibility.ts';
import type { CollisionMap, Game, Player, Vec2 } from '../types.ts';

// Local overlays never enter the static mesh, discovery, snapshots or replay state.
const RANGE = 192, MARGIN = 2, EDGES_PER_BOT = 192, EDGES_PER_TICK = 1536;
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
interface Detour { goal: Vec2; last: Vec2; route: Vec2[]; source: Player['route'] }
const detours = new WeakMap<Player, Detour>();
const work = new WeakMap<Game, { tick: number; edges: number }>();
const localMaps = new WeakMap<Player, { source: CollisionMap; doors: string; map: CollisionMap }>();
export function dynamicNavigationWork(s: Game): number { return work.get(s)?.tick === s.tick ? work.get(s)!.edges : 0; }

/** Current sight only, including for full-map gladiators; sleep never changes eligibility. */
export function observedBlockers(s: Game, p: Player): Shape[] {
  const shapes: Shape[] = [];
  for (const other of [...s.players].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) if (other !== p && other.status === 'active' && distance(p, other) <= RANGE
    && visibleTo(s, p, other)) shapes.push({ kind: 'circle', x: other.x, y: other.y, r: actorRadius(s, other) });
  const sees = (at: Vec2) => distance(p, at) <= RANGE && distance(p, at) < VISION
    && !roofConceals(s.map, p, at) && lineClear(s.map, p, at);
  const world = physicsRuntime(s)?.world;
  for (const body of world?.solidPropStates() ?? []) {
    if (!sees(body.transform)) continue;
    const at = body.transform, shape = body.spec.shape;
    if (shape.kind === 'circle') shapes.push({ kind: 'circle', x: at.x, y: at.y, r: shape.radius });
    else {
      const points = shape.kind === 'box' ? [{ x: -shape.hx, y: -shape.hy }, { x: shape.hx, y: -shape.hy },
        { x: shape.hx, y: shape.hy }, { x: -shape.hx, y: shape.hy }] : shape.vertices;
      const c = Math.cos(at.angle), sn = Math.sin(at.angle);
      shapes.push({ kind: 'polygon', x: at.x, y: at.y, points: points.map(q => ({ x: c * q.x - sn * q.y, y: sn * q.x + c * q.y })) });
    }
  }
  return shapes;
}

// A contestant's local static sweep must not learn a hidden door's current state.
function localMap(s: Game, p: Player): CollisionMap {
  if (p.role === 'gladiator' || !p.discovery) return s.map;
  const doors = s.map.gates.map(g => Number(p.discovery!.gates?.get(g.id)?.open ?? true)).join('');
  const old = localMaps.get(p);
  if (old?.source === s.map && old.doors === doors) return old.map;
  const map = { ...s.map, gates: s.map.gates.map(g => ({ ...g, open: p.discovery!.gates?.get(g.id)?.open ?? true })) };
  localMaps.set(p, { source: s.map, doors, map });
  return map;
}

// Static geometry is discovered through cover. Refuse a local sweep unless its entire support
// is surveyed, as the tile planner does: a hidden obstacle cannot select a different detour.
function knownSegment(s: Game, p: Player, a: Vec2, b: Vec2, radius: number): boolean {
  if (p.role === 'gladiator' || !p.discovery) return true;
  const { size, cols, rows } = discoveryGrid(s.map), surveyed = p.discovery.surveyed;
  for (let y = Math.max(0, Math.floor((Math.min(a.y, b.y) - radius) / size) - 1);
    y <= Math.min(rows - 1, Math.floor((Math.max(a.y, b.y) + radius) / size) + 1); y++) {
    for (let x = Math.max(0, Math.floor((Math.min(a.x, b.x) - radius) / size) - 1);
      x <= Math.min(cols - 1, Math.floor((Math.max(a.x, b.x) + radius) / size) + 1); x++) {
      if (!surveyed?.has(y * cols + x)) return false;
    }
  }
  return true;
}

/** Return a motor destination, or the current pose to queue. Never changes positions or the global route. */
export function dynamicWaypoint(s: Game, p: Player, destination: Vec2): Vec2 {
  if (!s.content.dynamicNavigation) return destination;
  const shapes = observedBlockers(s, p), radius = actorRadius(s, p);
  // Rejoin beyond the observed body's far side, even if its centre is at the observation horizon.
  const length = distance(p, destination), horizon = RANGE + 64, scale = length > horizon ? horizon / length : 1;
  const goal = { x: p.x + (destination.x - p.x) * scale, y: p.y + (destination.y - p.y) * scale };
  const footprints = shapes.map(shape => ({ shape, box: bounds(shape) }));
  const clearBodies = (a: Vec2, b: Vec2) => {
    const left = Math.min(a.x, b.x) - radius - MARGIN, right = Math.max(a.x, b.x) + radius + MARGIN;
    const top = Math.min(a.y, b.y) - radius - MARGIN, bottom = Math.max(a.y, b.y) + radius + MARGIN;
    return footprints.every(({ shape, box }) => {
      if (box.x > right || box.y > bottom || box.x + box.w < left || box.y + box.h < top) return true;
      const gap = segmentShapeDistance(a, b, shape);
      if (gap >= radius + MARGIN) return true;
      const start = segmentShapeDistance(a, a, shape);
      // Contact can leave a safety margin (or solver slop) by moving away, never deeper through it.
      return start > 0 && start < radius + MARGIN && gap >= start - 0.001
        && segmentShapeDistance(b, b, shape) > start + 0.001;
    });
  };
  if (clearBodies(p, goal)) { detours.delete(p); return destination; }
  const map = localMap(s, p);
  const clear = (a: Vec2, b: Vec2) => clearBodies(a, b) && knownSegment(s, p, a, b, radius) && sweptClear(map, a, b, radius);
  const old = detours.get(p);
  if (old && old.source === p.route && distance(old.last, p) < 64 && distance(old.goal, destination) < 24) {
    while (old.route.length && distance(p, old.route[0]!) < 3) old.route.shift();
    if (old.route.length && clear(p, old.route[0]!)) { old.last = { x: p.x, y: p.y }; return old.route[0]!; }
  }
  detours.delete(p);
  let allowance = work.get(s);
  if (allowance?.tick !== s.tick) work.set(s, allowance = { tick: s.tick, edges: 0 });
  // Round-robin admission keeps a crowded room from always spending its allowance on its first bots.
  if ((s.tick + s.players.indexOf(p)) % 4 !== 0) return p;
  const nodes: Vec2[] = [{ x: p.x, y: p.y }, goal];
  // Corners of conservative expanded bounds; all bodies still judge every edge, including overflow.
  for (const shape of shapes.slice().sort((a, b) => distance(p, a) - distance(p, b)).slice(0, 8)) {
    const box = bounds(shape), pad = radius + MARGIN + 1;
    for (const x of [box.x - pad, box.x + box.w + pad]) for (const y of [box.y - pad, box.y + box.h + pad])
      if (distance(p, { x, y }) <= RANGE + 64) nodes.push({ x, y });
  }
  const costs = nodes.map(() => Infinity), parents = nodes.map(() => -1), closed = new Set<number>();
  costs[0] = 0;
  let used = 0;
  while (closed.size < nodes.length) {
    let at = -1;
    for (let i = 0; i < nodes.length; i++) if (!closed.has(i) && Number.isFinite(costs[i])
      && (at < 0 || costs[i]! < costs[at]!)) at = i;
    if (at < 0) break;
    if (at === 1) {
      const route: Vec2[] = [];
      for (let i = 1; i !== 0; i = parents[i]!) route.unshift(nodes[i]!);
      detours.set(p, { goal: { ...destination }, last: { x: p.x, y: p.y }, route, source: p.route });
      return route[0]!;
    }
    closed.add(at);
    for (let i = 1; i < nodes.length; i++) {
      if (closed.has(i) || costs[at]! + distance(nodes[at]!, nodes[i]!) >= costs[i]!) continue;
      if (used >= EDGES_PER_BOT || allowance.edges >= EDGES_PER_TICK) return p;
      used++; allowance.edges++;
      if (!clear(nodes[at]!, nodes[i]!)) continue;
      costs[i] = costs[at]! + distance(nodes[at]!, nodes[i]!); parents[i] = at;
    }
  }
  return p;
}
