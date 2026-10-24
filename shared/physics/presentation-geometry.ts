import { litPoint } from '../movement.ts';
import { ENTITY_MARGIN, roofConceals } from '../view.ts';
import type { Sight } from '../view.ts';
import type { GameMap } from '../types.ts';
import type { BodyShape, Point } from './types.ts';

type RoofMap = Pick<GameMap, 'buildings'> & { roofs?: GameMap['roofs']; playableArea?: GameMap['playableArea'] };
type Pose = Point & { angle: number; shape: BodyShape };
const EPS = 1e-8;

/** Maximum distance from a body's anchor to its geometry, in world units. */
export function bodyRadius(shape: BodyShape): number {
  if (shape.kind === 'circle') return shape.radius;
  if (shape.kind === 'box') return Math.hypot(shape.hx, shape.hy);
  return Math.max(0, ...shape.vertices.map(vertex => Math.hypot(vertex.x, vertex.y)));
}

/** Renderable geometry transformed into world coordinates. */
export function bodyVertices(body: Pose): Point[] {
  const { shape, x, y, angle } = body;
  if (shape.kind === 'circle') return [];
  const vertices = shape.kind === 'box'
    ? [{ x: -shape.hx, y: -shape.hy }, { x: shape.hx, y: -shape.hy },
      { x: shape.hx, y: shape.hy }, { x: -shape.hx, y: shape.hy }]
    : shape.vertices;
  const c = Math.cos(angle), s = Math.sin(angle);
  return vertices.map(vertex => ({ x: x + vertex.x * c - vertex.y * s,
    y: y + vertex.x * s + vertex.y * c }));
}

function insideRect(p: Point, r: { x: number; y: number; width: number; height: number }): boolean {
  return p.x >= r.x - EPS && p.x <= r.x + r.width + EPS
    && p.y >= r.y - EPS && p.y <= r.y + r.height + EPS;
}
function insidePolygon(p: Point, vertices: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i], b = vertices[j];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) <= EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS
      && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function intersections(a: Point, b: Point, c: Point, d: Point): Point[] {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  const qx = c.x - a.x, qy = c.y - a.y;
  if (Math.abs(denominator) <= EPS) {
    if (Math.abs(qx * ry - qy * rx) > EPS) return [];
    return [a, b, c, d].filter(p => p.x >= Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) - EPS
      && p.x <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + EPS
      && p.y >= Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) - EPS
      && p.y <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + EPS);
  }
  const t = (qx * sy - qy * sx) / denominator, u = (qx * ry - qy * rx) / denominator;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS
    ? [{ x: a.x + t * rx, y: a.y + t * ry }] : [];
}
function edges(vertices: readonly Point[]): Array<[Point, Point]> {
  return vertices.map((point, i) => [point, vertices[(i + 1) % vertices.length]]);
}
function viewport(sight: Sight): Point[] {
  const { x, y, width, height } = sight.bounds;
  return [{ x: x - ENTITY_MARGIN, y: y - ENTITY_MARGIN },
    { x: x + width + ENTITY_MARGIN, y: y - ENTITY_MARGIN },
    { x: x + width + ENTITY_MARGIN, y: y + height + ENTITY_MARGIN },
    { x: x - ENTITY_MARGIN, y: y + height + ENTITY_MARGIN }];
}

/** A prop is visible only when its actual geometry touches both sight and camera coverage.
 * Roof concealment keeps the existing center-based policy independently of edge visibility. */
export function seesBody(sight: Sight | null | undefined, map: RoofMap, body: Pose): boolean {
  if (!sight || sight.points.length < 3 || roofConceals(map, sight.eye, body)) return false;
  const rect = viewport(sight), bounds = { x: rect[0].x, y: rect[0].y,
    width: rect[1].x - rect[0].x, height: rect[2].y - rect[1].y };
  const lit = (point: Point) => insideRect(point, bounds)
    && litPoint(sight.points, sight.eye, point.x, point.y);
  const sightEdges = edges(sight.points);
  if (body.shape.kind === 'circle') {
    const radius = body.shape.radius, within = (p: Point) => Math.hypot(p.x - body.x, p.y - body.y) <= radius + EPS;
    if (lit(body)) return true;
    if (sight.points.some(p => insideRect(p, bounds) && within(p))) return true;
    if (rect.some(p => within(p) && lit(p))) return true;
    for (const [a, b] of sightEdges) for (const [c, d] of edges(rect)) {
      if (intersections(a, b, c, d).some(p => within(p) && lit(p))) return true;
    }
    // An arc can cross either polygon boundary without containing any of its vertices.
    for (const [a, b] of [...sightEdges, ...edges(rect)]) {
      const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - body.x, fy = a.y - body.y;
      const aa = dx * dx + dy * dy;
      if (aa <= EPS) continue;
      const bb = 2 * (fx * dx + fy * dy), cc = fx * fx + fy * fy - radius * radius;
      const discriminant = bb * bb - 4 * aa * cc;
      if (discriminant < 0) continue;
      for (const t of [(-bb - Math.sqrt(discriminant)) / (2 * aa), (-bb + Math.sqrt(discriminant)) / (2 * aa)]) {
        if (t >= -EPS && t <= 1 + EPS && lit({ x: a.x + t * dx, y: a.y + t * dy })) return true;
      }
    }
    return false;
  }
  const shape = bodyVertices(body), shapeEdges = edges(shape);
  if (shape.some(lit)) return true;
  if (sight.points.some(p => insideRect(p, bounds) && insidePolygon(p, shape))) return true;
  if (rect.some(p => lit(p) && insidePolygon(p, shape))) return true;
  for (const [a, b] of shapeEdges) for (const [c, d] of [...sightEdges, ...edges(rect)]) {
    if (intersections(a, b, c, d).some(lit)) return true;
  }
  // The sight and viewport boundaries may cross inside a body without touching its edge.
  for (const [a, b] of sightEdges) for (const [c, d] of edges(rect)) {
    if (intersections(a, b, c, d).some(p => insidePolygon(p, shape) && lit(p))) return true;
  }
  return false;
}
