import SAT from 'sat';
import type { Circle, Polygon, Response } from 'sat';
import type { Vec2, World } from './types.ts';
import { hypot } from './math.ts';
import { edgesOf, type Shape } from './shape.ts';

/**
 * What a shape says about a point, a segment, a disk or another shape (29). `shape.ts` owns what a shape
 * *is*; this module asks questions of that description. It is the game core's only user of the SAT
 * library, and nothing of SAT crosses its signatures: callers pass shapes and numbers and get booleans,
 * distances and plain vectors back (#1181), so the engine behind the queries can change without them.
 */

declare const preparedBrand: unique symbol;
/**
 * A shape readied for repeated queries, from {@link prepare}. Opaque: callers keep it beside the shape
 * it came from and hand both back, which spares rebuilding the shape's query form on every test.
 */
export type Prepared = { readonly [preparedBrand]: true };
type Body = Circle | Polygon;
const bodyOf = (prepared: Prepared): Body => prepared as unknown as Body;

const vec = (x: World, y: World) => new SAT.Vector(x, y);
function body(shape: Shape): Body {
  if (shape.kind === 'circle') return new SAT.Circle(vec(shape.x, shape.y), shape.r);
  if (shape.kind === 'rect') return new SAT.Box(vec(shape.x, shape.y), shape.w, shape.h).toPolygon();
  return new SAT.Polygon(vec(shape.x, shape.y), shape.points.map(point => vec(point.x, point.y)));
}

/** Ready a shape for repeated queries. Callers that test a shape every tick should keep the result. */
export function prepare(shape: Shape): Prepared {
  return body(shape) as unknown as Prepared;
}

// SAT has no shared supertype for circles and polygons, so the shape kind picks the test. Kept here
// because every query that tests a disk against world geometry needs exactly this dispatch.
function separate(moving: Circle, shape: Shape, target: Body, response?: Response): boolean {
  return shape.kind === 'circle'
    ? SAT.testCircleCircle(moving, target as Circle, response)
    : SAT.testCirclePolygon(moving, target as Polygon, response);
}

/** How deep a disk sits in a shape, and the move that takes it back out. */
export interface Penetration {
  /** Penetration depth along the separating axis. */
  depth: number;
  /** The displacement that separates the disk from the shape: add it to the disk's centre. */
  x: number;
  y: number;
}

// One disk and one response, reset before each test: the queries are synchronous and never re-entered.
const disk = new SAT.Circle(new SAT.Vector(), 0), response = new SAT.Response();
/**
 * Does a disk of `radius` centred at `x`,`y` touch the shape (contact counts)? Returns how far it
 * penetrates and the move that separates it, or `null` when the two are apart.
 */
export function diskPenetration(x: World, y: World, radius: World, shape: Shape, prepared: Prepared = prepare(shape)): Penetration | null {
  disk.pos.x = x; disk.pos.y = y; disk.r = radius;
  response.clear();
  if (!separate(disk, shape, bodyOf(prepared), response)) return null;
  return { depth: response.overlap, x: -response.overlapV.x, y: -response.overlapV.y };
}

/** Is a world point inside the shape? */
export function contains(shape: Shape, x: World, y: World, prepared?: Prepared): boolean {
  if (shape.kind === 'circle') return hypot(x - shape.x, y - shape.y) <= shape.r;
  if (shape.kind === 'rect') return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  return SAT.pointInPolygon(vec(x, y), (prepared ? bodyOf(prepared) : body(shape)) as Polygon);
}

function overlapsWith(a: Shape, b: Shape, bodyA: Body, bodyB: Body, result?: Response): boolean {
  if (a.kind === 'circle') return separate(bodyA as Circle, b, bodyB, result);
  if (b.kind === 'circle') return separate(bodyB as Circle, a, bodyA, result);
  return SAT.testPolygonPolygon(bodyA as Polygon, bodyB as Polygon, result);
}

/** Do two shapes overlap (including contact)? */
export function overlaps(a: Shape, b: Shape, preparedA: Prepared = prepare(a), preparedB: Prepared = prepare(b)): boolean {
  return overlapsWith(a, b, bodyOf(preparedA), bodyOf(preparedB));
}

/**
 * Do two shapes share area, penetrating deeper than `tolerance`? Unlike `overlaps`, contact at an
 * edge, a point or a tangent doesn't count. Authored areas use it (#404); collision does not.
 */
export function sharesArea(a: Shape, b: Shape, tolerance = 0): boolean {
  const result = new SAT.Response();
  return overlapsWith(a, b, body(a), body(b), result) && result.overlap > tolerance;
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
