import SAT from 'sat';
import { count } from './profiler.js';

export const TILE = 40; // Navigation sampling only, never a movement or rendering grid.
export const VISION = 620;
const shapeCache = new WeakMap();
const vec = (x, y) => new SAT.Vector(x, y);
function geometry(map) {
  let cached = shapeCache.get(map);
  if (cached && cached.source === map.obstacles && cached.count === map.obstacles.length) return cached;
  const shapes = map.obstacles.map(o => ({ ...o, shape: o.r ? new SAT.Circle(vec(o.x, o.y), o.r) : new SAT.Box(vec(o.x, o.y), o.w, o.h).toPolygon() }));
  cached = { source: map.obstacles, count: map.obstacles.length, shapes, segments: shapes.flatMap(edges) };
  shapeCache.set(map, cached); return cached;
}
function edges(o) {
  const points = o.r ? Array.from({ length: 16 }, (_, i) => ({ x: o.x + Math.cos(i * Math.PI / 8) * o.r, y: o.y + Math.sin(i * Math.PI / 8) * o.r })) : [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }];
  return points.map((a, i) => ({ a, b: points[(i + 1) % points.length] }));
}
function nearby(o, x, y, radius) {
  return o.r ? Math.abs(x - o.x) <= radius + o.r && Math.abs(y - o.y) <= radius + o.r : x + radius >= o.x && x - radius <= o.x + o.w && y + radius >= o.y && y - radius <= o.y + o.h;
}
function gateShape(g) { return { x: g.x - 13, y: g.y - 27, w: 26, h: 54 }; }
export function insideMap(map, x, y, radius = 0) {
  const hx = map.width / 2 - 40, hy = map.height / 2 - 40;
  return Math.abs(x - map.width / 2) / hx + Math.abs(y - map.height / 2) / hy + radius * Math.hypot(1 / hx, 1 / hy) <= 1;
}
export function canOccupy(map, x, y, radius = 12, ignoreGates = false) {
  count('calls.canOccupy');
  if (!insideMap(map, x, y, radius)) return false;
  const circle = new SAT.Circle(vec(x, y), radius), response = new SAT.Response();
  for (const o of geometry(map).shapes) {
    if (!nearby(o, x, y, radius)) continue;
    response.clear();
    if ((o.r ? SAT.testCircleCircle(circle, o.shape, response) : SAT.testCirclePolygon(circle, o.shape, response)) && response.overlap > 0.01) return false;
  }
  if (!ignoreGates) for (const g of map.gates) if (!g.open) {
    const o = gateShape(g);
    if (nearby(o, x, y, radius) && SAT.testCirclePolygon(circle, new SAT.Box(vec(o.x, o.y), o.w, o.h).toPolygon())) return false;
  }
  return true;
}
export function movePlayer(map, p, input) {
  count('calls.movePlayer');
  let speed = p.role === 'contestant' ? 9 : 8;
  if (p.boost) speed *= p.role === 'contestant' ? 1.45 : 1.5;
  if (p.stun) speed *= 0.35;
  if (input.sneak && p.role === 'contestant') speed *= 0.55;
  const x = Number.isFinite(input.x) ? input.x : 0, y = Number.isFinite(input.y) ? input.y : 0;
  const norm = Math.max(1, Math.hypot(x, y));
  const radius = p.role === 'gladiator' ? 23 : 12;
  const circle = new SAT.Circle(vec(p.x + x / norm * speed, p.y + y / norm * speed), radius);
  const response = new SAT.Response();
  const colliders = geometry(map).shapes.filter(o => nearby(o, circle.pos.x, circle.pos.y, radius + speed));
  for (const g of map.gates) if (!g.open) {
    const o = gateShape(g);
    if (nearby(o, circle.pos.x, circle.pos.y, radius + speed)) colliders.push({ ...o, shape: new SAT.Box(vec(o.x, o.y), o.w, o.h).toPolygon() });
  }
  // SAT separation provides continuous sliding along walls and around obstacle corners.
  for (let pass = 0; pass < 3; pass++) for (const o of colliders) {
    response.clear();
    if (o.r ? SAT.testCircleCircle(circle, o.shape, response) : SAT.testCirclePolygon(circle, o.shape, response)) circle.pos.sub(response.overlapV);
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
const sightCache = new WeakMap();
// Obstacle edges never change and gate edges only change when a gate opens, so the combined list is
// rebuilt on that event rather than on every sight query. It was being rebuilt a dozen-plus times a
// frame, once per lineClear call.
function sightEdges(map) {
  const key = map.gates.reduce((k, g) => k * 2 + (g.open ? 1 : 0), 1);
  const cached = sightCache.get(map);
  if (cached && cached.key === key && cached.source === map.obstacles && cached.count === map.obstacles.length) return cached.edges;
  count('alloc.sightEdges');
  const list = [...geometry(map).segments, ...map.gates.filter(g => !g.open).flatMap(g => edges(gateShape(g)))];
  sightCache.set(map, { key, source: map.obstacles, count: map.obstacles.length, edges: list });
  return list;
}
function hitRay(origin, dx, dy, edge) {
  const sx = edge.b.x - edge.a.x, sy = edge.b.y - edge.a.y;
  const cross = dx * sy - dy * sx;
  if (Math.abs(cross) < 1e-9) return Infinity;
  const ax = edge.a.x - origin.x, ay = edge.a.y - origin.y;
  const t = (ax * sy - ay * sx) / cross, u = (ax * dy - ay * dx) / cross;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}
export function lineClear(map, a, b) {
  count('calls.lineClear');
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 0.01) return true;
  const dx = (b.x - a.x) / length, dy = (b.y - a.y) / length;
  const edges = sightEdges(map);
  count('work.rayEdgeTests', edges.length);
  return !edges.some(edge => hitRay(a, dx, dy, edge) < length - 0.1);
}
export function visibilityPolygon(map, origin, radius = VISION) {
  count('calls.visibilityPolygon');
  // A ray can only strike a segment from within the angular wedge its endpoints subtend. Rays are cast
  // in ascending angle, so sweeping the wedges in the same order keeps an active set of just the few
  // segments any one ray can reach, instead of testing every segment against every ray.
  const angles = Array.from({ length: 100 }, (_, i) => i * Math.PI / 50 - Math.PI);
  const spans = [], always = [];
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
  const active = [];
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
export function litPoint(points, origin, x, y) {
  if (!points || points.length < 3) return false;
  const angle = Math.atan2(y - origin.y, x - origin.x);
  let lo, hi;
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
