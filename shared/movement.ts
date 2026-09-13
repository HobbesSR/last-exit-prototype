import SAT from 'sat';
import type { Circle, Polygon } from 'sat';
import { count } from './profiler.ts';
import { finite } from './numbers.ts';
import { shapeOf, bounds, nearBounds, edgesOf, body, separate } from './shape.ts';
import type { Bounded, Edge, Shape } from './shape.ts';
import type { Box, CollisionMap, GateId, Obstacle, Player, PlayerInput, Vec2, World } from './types.ts';

// Geometry is described once in `shape.ts` and consumed here. This module owns what the simulation
// does with a shape -- occupancy, the movement sweep and sight -- not what a shape is.
/** One record resolved to its shape, bounds and SAT body, all kept for as long as the map lives. */
interface Collider {
  source?: Obstacle;
  shape: Shape;
  box: Box;
  body: Circle | Polygon;
  kind?: string | undefined;
}
/** A sight-blocking edge, tagged when it came from a gate so that gate can be excluded. */
interface SightEdge extends Edge {
  gateId?: GateId | undefined;
}
interface Geometry {
  source: Obstacle[];
  count: number;
  shapes: Collider[];
  /** Obstacle colliders indexed by `BUCKET`-sized cell, keyed `"<col>,<row>"`. */
  buckets: Map<string, Collider[]>;
  segments: Edge[];
}
/** A visibility polygon vertex, which keeps the ray angle that produced it. */
export interface VisibilityPoint extends Vec2 {
  angle: number;
  length: World;
}

export const TILE = 40; // Navigation sampling only, never a movement or rendering grid.
export const VISION = 620;
const shapeCache = new WeakMap<CollisionMap, Geometry>();
const BUCKET = 200;
const vec = (x: World, y: World) => new SAT.Vector(x, y);
/** Resolve a stored record -- an obstacle, or a closed gate's box -- into a reusable collider. */
function collider(source: Bounded & { kind?: string | undefined }): Collider {
  const shape = shapeOf(source);
  return { shape, box: bounds(shape), body: body(shape), kind: source.kind };
}
function geometry(map: CollisionMap): Geometry {
  let cached = shapeCache.get(map);
  if (cached && cached.source === map.obstacles && cached.count === map.obstacles.length) return cached;
  const shapes = map.obstacles.map(o => ({ ...collider(o), source: o }));
  const buckets = new Map<string, Collider[]>();
  for (const entry of shapes) {
    const { x: left, y: top, w, h } = entry.box;
    for (let x = Math.floor(left / BUCKET); x <= Math.floor((left + w) / BUCKET); x++) for (let y = Math.floor(top / BUCKET); y <= Math.floor((top + h) / BUCKET); y++) {
      const key = `${x},${y}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key)!.push(entry);
    }
  }
  cached = { source: map.obstacles, count: map.obstacles.length, shapes, buckets, segments: shapes.filter(o => o.kind !== 'window').flatMap(o => edgesOf(o.shape)) };
  shapeCache.set(map, cached); return cached;
}
function nearbyShapes(map: CollisionMap, x: World, y: World, radius: World): Set<Collider> {
  const found = new Set<Collider>(), { buckets } = geometry(map);
  for (let bx = Math.floor((x - radius) / BUCKET); bx <= Math.floor((x + radius) / BUCKET); bx++)
    for (let by = Math.floor((y - radius) / BUCKET); by <= Math.floor((y + radius) / BUCKET); by++)
      for (const shape of buckets.get(`${bx},${by}`) || []) found.add(shape);
  return found;
}
export function gateShape(g: Bounded): Box { const w = g.w || 26, h = g.h || 54; return { x: g.x - w / 2, y: g.y - h / 2, w, h }; }
export function insideMap(map: Pick<CollisionMap, 'width' | 'height'>, x: World, y: World, radius: World = 0): boolean {
  const hx = map.width / 2 - 40, hy = map.height / 2 - 40;
  return Math.abs(x - map.width / 2) / hx + Math.abs(y - map.height / 2) / hy + radius * Math.hypot(1 / hx, 1 / hy) <= 1;
}
export function canOccupy(map: CollisionMap, x: World, y: World, radius: World = 12, ignoreGates = false, projectile = false): boolean {
  count('calls.canOccupy');
  if (!insideMap(map, x, y, radius)) return false;
  const circle = new SAT.Circle(vec(x, y), radius), response = new SAT.Response();
  for (const o of nearbyShapes(map, x, y, radius)) {
    if (projectile && o.kind === 'window') continue;
    if (!nearBounds(o.box, x, y, radius)) continue;
    response.clear();
    if (separate(circle, o.shape, o.body, response) && response.overlap > 0.01) return false;
  }
  if (!ignoreGates) for (const g of map.gates) if (!g.open) {
    const box = gateShape(g);
    if (!nearBounds(box, x, y, radius)) continue;
    const o = collider(box);
    if (separate(circle, o.shape, o.body)) return false;
  }
  return true;
}
export function movePlayer(map: CollisionMap, p: Player, input: PlayerInput): Player {
  count('calls.movePlayer');
  let speed = p.role === 'contestant' ? 9 : 8;
  if (p.boost) speed *= p.role === 'contestant' ? 1.45 : 1.5;
  if (p.stun) speed *= 0.35;
  if (input.sneak && p.role === 'contestant') speed *= 0.55;
  const x = finite(input.x) ? input.x : 0, y = finite(input.y) ? input.y : 0;
  const norm = Math.max(1, Math.hypot(x, y));
  const radius = p.role === 'gladiator' ? 23 : 12;
  const circle = new SAT.Circle(vec(p.x + x / norm * speed, p.y + y / norm * speed), radius);
  const response = new SAT.Response();
  const colliders: Collider[] = [...nearbyShapes(map, circle.pos.x, circle.pos.y, radius + speed)].filter(o => nearBounds(o.box, circle.pos.x, circle.pos.y, radius + speed));
  for (const g of map.gates) if (!g.open) {
    const box = gateShape(g);
    if (nearBounds(box, circle.pos.x, circle.pos.y, radius + speed)) colliders.push(collider(box));
  }
  // SAT separation provides continuous sliding along walls and around obstacle corners.
  for (let pass = 0; pass < 3; pass++) for (const o of colliders) {
    response.clear();
    if (separate(circle, o.shape, o.body, response)) circle.pos.sub(response.overlapV);
  }
  const hx = map.width / 2 - 40, hy = map.height / 2 - 40, len = Math.hypot(1 / hx, 1 / hy);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const excess = sx * (circle.pos.x - map.width / 2) / hx + sy * (circle.pos.y - map.height / 2) / hy + radius * len - 1;
    if (excess > 0) { circle.pos.x -= excess * sx / hx / (len * len); circle.pos.y -= excess * sy / hy / (len * len); }
  }
  p.x = Math.round(circle.pos.x * 1000) / 1000; p.y = Math.round(circle.pos.y * 1000) / 1000;
  return p;
}
const TAU = Math.PI * 2;
const sightCache = new WeakMap<CollisionMap, { key: string; source: Obstacle[]; count: number; edges: SightEdge[] }>();
// Obstacle edges never change and gate edges only change when a gate opens, so the combined list is
// rebuilt on that event rather than on every sight query. It was being rebuilt a dozen-plus times a
// frame, once per lineClear call.
function sightEdges(map: CollisionMap): SightEdge[] {
  const key = map.gates.map(g => `${g.id}:${g.open ? 1 : 0}`).join('|');
  const cached = sightCache.get(map);
  if (cached && cached.key === key && cached.source === map.obstacles && cached.count === map.obstacles.length) return cached.edges;
  count('alloc.sightEdges');
  const list: SightEdge[] = [...geometry(map).segments, ...map.gates.filter(g => !g.open).flatMap(g => edgesOf(shapeOf(gateShape(g))).map(edge => ({ ...edge, gateId: g.id })))];
  sightCache.set(map, { key, source: map.obstacles, count: map.obstacles.length, edges: list });
  return list;
}
function hitRay(origin: Vec2, dx: number, dy: number, edge: Edge): number {
  const sx = edge.b.x - edge.a.x, sy = edge.b.y - edge.a.y;
  const cross = dx * sy - dy * sx;
  if (Math.abs(cross) < 1e-9) return Infinity;
  const ax = edge.a.x - origin.x, ay = edge.a.y - origin.y;
  const t = (ax * sy - ay * sx) / cross, u = (ax * dy - ay * dx) / cross;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}
export function lineClear(map: CollisionMap, a: Vec2, b: Vec2, ignoreGateId: GateId | null = null): boolean {
  count('calls.lineClear');
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 0.01) return true;
  const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
  const edges = sightEdges(map);
  count('work.rayEdgeTests', edges.length);
  return !edges.some(edge => edge.gateId !== ignoreGateId
    && Math.max(edge.a.x, edge.b.x) >= Math.min(a.x, b.x) && Math.min(edge.a.x, edge.b.x) <= Math.max(a.x, b.x)
    && Math.max(edge.a.y, edge.b.y) >= Math.min(a.y, b.y) && Math.min(edge.a.y, edge.b.y) <= Math.max(a.y, b.y)
    && hitRay(a, dx, dy, edge) < length - 0.1);
}
// Hands and dropped equipment cannot pass through a window even though sight and shots can.
export function reachClear(map: CollisionMap, a: Vec2, b: Vec2): boolean {
  if (!lineClear(map, a, b)) return false;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 0.01) return true;
  const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
  return !geometry(map).shapes.some(o => o.kind === 'window' && edgesOf(o.shape).some(edge => hitRay(a, dx, dy, edge) < length));
}
export function visibilityPolygon(map: CollisionMap, origin: Vec2, radius: World = VISION): VisibilityPoint[] {
  count('calls.visibilityPolygon');
  // A ray can only strike a segment from within the angular wedge its endpoints subtend. Rays are cast
  // in ascending angle, so sweeping the wedges in the same order keeps an active set of just the few
  // segments any one ray can reach, instead of testing every segment against every ray.
  const angles = Array.from({ length: 100 }, (_, i) => i * Math.PI / 50 - Math.PI);
  const spans: { edge: SightEdge; lo: number; hi: number }[] = [], always: SightEdge[] = [];
  const SEAM = Math.PI + 1e-4; // Sample angles straddle +-pi by the corner offset below; keep them covered.
  for (const edge of sightEdges(map)) {
    if (Math.min(edge.a.x, edge.b.x) >= origin.x + radius || Math.max(edge.a.x, edge.b.x) <= origin.x - radius
      || Math.min(edge.a.y, edge.b.y) >= origin.y + radius || Math.max(edge.a.y, edge.b.y) <= origin.y - radius) continue;
    const ea = Math.atan2(edge.a.y - origin.y, edge.a.x - origin.x), eb = Math.atan2(edge.b.y - origin.y, edge.b.x - origin.x);
    angles.push(ea - 0.00001, ea, ea + 0.00001, eb - 0.00001, eb, eb + 0.00001);
    // The wedge argument assumes the origin lies strictly off the segment. An origin on it — along an
    // edge or exactly at a corner — is grazed at distance zero from every direction and its endpoint
    // angles are degenerate, so such a segment is never culled.
    const sx = edge.b.x - edge.a.x, sy = edge.b.y - edge.a.y;
    const ox = origin.x - edge.a.x, oy = origin.y - edge.a.y;
    const cross = sx * oy - sy * ox, lengthSq = sx * sx + sy * sy, along = sx * ox + sy * oy;
    if (cross * cross <= 1e-12 * lengthSq && along >= -1e-9 && along <= lengthSq + 1e-9) { always.push(edge); continue; }
    const lo = Math.min(ea, eb), hi = Math.max(ea, eb);
    // A straight segment never subtends more than pi from outside itself, so a wider naive span means
    // the wedge crosses the -pi/pi seam. Split it there so every span is a plain ascending interval.
    if (hi - lo > Math.PI) { spans.push({ edge, lo: hi, hi: SEAM }, { edge, lo: -SEAM, hi: lo }); continue; }
    spans.push({ edge, lo, hi });
    // A direction is the same one turn either way, so a wedge touching a seam also has to catch the
    // sample angles sitting just past the opposite one. Ray -pi and ray +pi point the same way.
    if (hi >= Math.PI - 1e-4) spans.push({ edge, lo: lo - TAU, hi: hi - TAU });
    if (lo <= 1e-4 - Math.PI) spans.push({ edge, lo: lo + TAU, hi: hi + TAU });
  }
  angles.sort((a, b) => a - b);
  spans.sort((a, b) => a.lo - b.lo);
  const active: { edge: SightEdge; lo: number; hi: number }[] = [];
  let entering = 0, tests = 0;
  const points = angles.map(angle => {
    while (entering < spans.length && spans[entering].lo <= angle) active.push(spans[entering++]);
    for (let i = active.length - 1; i >= 0; i--) if (active[i].hi < angle) { active[i] = active[active.length - 1]; active.pop(); }
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let length = radius;
    for (const span of active) { tests++; const hit = hitRay(origin, dx, dy, span.edge); if (hit < length) length = hit; }
    for (const edge of always) { tests++; const hit = hitRay(origin, dx, dy, edge); if (hit < length) length = hit; }
    // Each vertex keeps the angle that produced it so the polygon can be queried directly, without
    // casting a fresh ray per entity the renderer wants to test.
    return { x: origin.x + dx * length, y: origin.y + dy * length, angle, length };
  });
  count('work.visibilityRays', tests);
  return points;
}


// Is a world point inside an already-computed visibility polygon? The vertices ascend by angle, so the
// bracketing pair is a binary search away and the test is which side of that boundary edge the point
// falls on. Reusing the polygon keeps the renderer's per-entity visibility exactly consistent with the
// fog it draws, and costs a log-time lookup instead of a ray cast per entity.
export function litPoint(points: VisibilityPoint[] | null | undefined, origin: Vec2, x: World, y: World): boolean {
  if (!points || points.length < 3) return false;
  const angle = Math.atan2(y - origin.y, x - origin.x);
  let lo: number, hi: number;
  if (angle < points[0].angle || angle > points[points.length - 1].angle) { lo = points.length - 1; hi = 0; }
  else {
    lo = 0; hi = points.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].angle <= angle) lo = mid; else hi = mid; }
  }
  const a = points[lo], b = points[hi];
  const ex = b.x - a.x, ey = b.y - a.y;
  const side = ex * (y - a.y) - ey * (x - a.x), inner = ex * (origin.y - a.y) - ey * (origin.x - a.x);
  // A degenerate boundary edge means the wedge has no interior — an eye buried in geometry collapses
  // the whole polygon to a point — so nothing in it is lit.
  if (inner === 0) return false;
  return side === 0 || side > 0 === inner > 0;
}
