import SAT from 'sat';
import type { Circle, Polygon, Response } from 'sat';
import type { Vec2, World } from './types.ts';
import { hypot } from './math.ts';
import { edgesOf, type Shape } from './shape.ts';

/**
 * What a shape says about a point, a segment or another shape (29). `shape.ts` owns what a shape *is*;
 * this module asks questions of that description, and it alone holds the SAT library, so code that only
 * describes, moves or draws shapes does not depend on it (#1181).
 */

const vec = (x: World, y: World) => new SAT.Vector(x, y);
/** The SAT body for a shape. Callers that test a shape every tick should cache the result. */
export function body(shape: Shape): Circle | Polygon {
  if (shape.kind === 'circle') return new SAT.Circle(vec(shape.x, shape.y), shape.r);
  if (shape.kind === 'rect') return new SAT.Box(vec(shape.x, shape.y), shape.w, shape.h).toPolygon();
  return new SAT.Polygon(vec(shape.x, shape.y), shape.points.map(point => vec(point.x, point.y)));
}

// SAT has no shared supertype for circles and polygons, so the shape kind picks the test. Kept here
// because every caller that sweeps a body against world geometry needs exactly this dispatch.
export function separate(moving: Circle, shape: Shape, target: Circle | Polygon, response?: Response): boolean {
  return shape.kind === 'circle'
    ? SAT.testCircleCircle(moving, target as Circle, response)
    : SAT.testCirclePolygon(moving, target as Polygon, response);
}

/** Is a world point inside the shape? */
export function contains(shape: Shape, x: World, y: World, cached?: Circle | Polygon): boolean {
  if (shape.kind === 'circle') return hypot(x - shape.x, y - shape.y) <= shape.r;
  if (shape.kind === 'rect') return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  return SAT.pointInPolygon(vec(x, y), (cached || body(shape)) as Polygon);
}

/** Do two shapes overlap (including contact)? Optional SAT response exposes penetration depth. */
export function overlaps(a: Shape, b: Shape, bodyA: Circle | Polygon = body(a), bodyB: Circle | Polygon = body(b), response?: Response): boolean {
  if (a.kind === 'circle') return separate(bodyA as Circle, b, bodyB, response);
  if (b.kind === 'circle') return separate(bodyB as Circle, a, bodyA, response);
  return SAT.testPolygonPolygon(bodyA as Polygon, bodyB as Polygon, response);
}

/**
 * Do two shapes share area, penetrating deeper than `tolerance`? Unlike `overlaps`, contact at an
 * edge, a point or a tangent doesn't count. Authored areas use it (#404); collision does not.
 */
export function sharesArea(a: Shape, b: Shape, tolerance = 0): boolean {
  const response = new SAT.Response();
  return overlaps(a, b, undefined, undefined, response) && response.overlap > tolerance;
}

/** Exact Euclidean distance from a closed segment to a filled shape (29).
 * Circles stay analytic; their sight polygon is not a collision approximation.
 * Zero includes crossing, containment, degenerate segments and tangency.
 */
export function segmentShapeDistance(a: Vec2, b: Vec2, shape: Shape): number {
  const pointDistance = (p: Vec2, c: Vec2, d: Vec2): number => {
    const dx = d.x - c.x, dy = d.y - c.y, n = dx * dx + dy * dy;
    const t = n ? Math.max(0, Math.min(1, ((p.x - c.x) * dx + (p.y - c.y) * dy) / n)) : 0;
    return hypot(p.x - c.x - t * dx, p.y - c.y - t * dy);
  };
  if (shape.kind === 'circle') return Math.max(0, pointDistance(shape, a, b) - shape.r);
  if (contains(shape, a.x, a.y) || contains(shape, b.x, b.y)) return 0;
  let distance = Infinity;
  const cross = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  for (const { a: c, b: d } of edgesOf(shape)) {
    const x = cross(a, b, c), y = cross(a, b, d), u = cross(c, d, a), v = cross(c, d, b);
    // Strict crossing; collinear contact is covered by point distances below.
    if (((x < 0 && y > 0) || (x > 0 && y < 0)) && ((u < 0 && v > 0) || (u > 0 && v < 0))) return 0;
    distance = Math.min(distance, pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
  }
  return distance;
}
