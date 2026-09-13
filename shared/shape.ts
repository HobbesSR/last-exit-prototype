import SAT from 'sat';
import type { Circle, Polygon, Response } from 'sat';
import type { Box, Vec2, World } from './types.ts';

/**
 * The vector description of one piece of world geometry, and the only place the arena says what a
 * shape *is*. Collision, sight and rendering all read this rather than each re-deriving geometry
 * from raw `w`/`h`/`r` fields, which is what let the renderer and the physics disagree about what a
 * given obstacle looked like.
 *
 * A rect is anchored at its top-left corner and a circle at its centre, because that is how the map
 * already stores them; a polygon carries local points about an anchor so it can be moved or rotated
 * as a unit. Polygons must be convex and wound consistently — SAT separation is only defined for
 * convex bodies. Concave generated content has to be decomposed into convex pieces before it
 * becomes geometry; see [23](../docs/23-types.md).
 */
export type Shape =
  | { kind: 'rect'; x: World; y: World; w: World; h: World }
  | { kind: 'circle'; x: World; y: World; r: World }
  | { kind: 'polygon'; x: World; y: World; points: Vec2[] };

/** A world-space box that may instead be a circle or a polygon, which `r`/`points` decide. */
export interface Bounded extends Box {
  r?: number | undefined;
  points?: Vec2[] | undefined;
}
export interface Edge {
  a: Vec2;
  b: Vec2;
}

// A circle becomes this many segments wherever it has to be treated as an outline — sight edges,
// reach tests, drawn vectors. Changing it changes which rays graze a tree, so it is fixed here and
// shared rather than chosen per call site.
export const CIRCLE_SEGMENTS = 16;

export const rect = (x: World, y: World, w: World, h: World): Shape => ({ kind: 'rect', x, y, w, h });
export const circle = (x: World, y: World, r: World): Shape => ({ kind: 'circle', x, y, r });
export const polygon = (x: World, y: World, points: Vec2[]): Shape => ({ kind: 'polygon', x, y, points });

/** Read the shape out of a stored map record, whichever of the three forms it uses. */
export function shapeOf(source: Bounded): Shape {
  if (source.points?.length) return polygon(source.x, source.y, source.points);
  if (source.r) return circle(source.x, source.y, source.r);
  return rect(source.x, source.y, source.w, source.h);
}

/** Axis-aligned bounds, the broad-phase key for buckets, culling and nearness. */
export function bounds(shape: Shape): Box {
  if (shape.kind === 'circle') return { x: shape.x - shape.r, y: shape.y - shape.r, w: shape.r * 2, h: shape.r * 2 };
  if (shape.kind === 'rect') return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of shape.points) {
    left = Math.min(left, shape.x + point.x); right = Math.max(right, shape.x + point.x);
    top = Math.min(top, shape.y + point.y); bottom = Math.max(bottom, shape.y + point.y);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Does a circle of `radius` at `x`,`y` come within this shape's bounds? Broad phase only. */
export function nearBounds(box: Box, x: World, y: World, radius: World): boolean {
  return x + radius >= box.x && x - radius <= box.x + box.w && y + radius >= box.y && y - radius <= box.y + box.h;
}

/**
 * The shape as world-space points: its vector description, wound the same way every time. This is
 * what sight turns into edges and what a renderer draws, so a generated shape draws as exactly the
 * thing the simulation collides with.
 */
export function outline(shape: Shape): Vec2[] {
  if (shape.kind === 'circle') {
    const step = Math.PI * 2 / CIRCLE_SEGMENTS;
    return Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => ({ x: shape.x + Math.cos(i * step) * shape.r, y: shape.y + Math.sin(i * step) * shape.r }));
  }
  if (shape.kind === 'rect') {
    return [{ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y },
      { x: shape.x + shape.w, y: shape.y + shape.h }, { x: shape.x, y: shape.y + shape.h }];
  }
  return shape.points.map(point => ({ x: shape.x + point.x, y: shape.y + point.y }));
}

/** The outline as closed segments, in winding order. */
export function edgesOf(shape: Shape): Edge[] {
  const points = outline(shape);
  return points.map((a, i) => ({ a, b: points[(i + 1) % points.length] }));
}

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
  if (shape.kind === 'circle') return Math.hypot(x - shape.x, y - shape.y) <= shape.r;
  if (shape.kind === 'rect') return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  return SAT.pointInPolygon(vec(x, y), (cached || body(shape)) as Polygon);
}

/** Do two shapes overlap? The general primitive a physics step needs; the sweep above is the hot path. */
export function overlaps(a: Shape, b: Shape, bodyA: Circle | Polygon = body(a), bodyB: Circle | Polygon = body(b)): boolean {
  if (a.kind === 'circle') return separate(bodyA as Circle, b, bodyB);
  if (b.kind === 'circle') return separate(bodyB as Circle, a, bodyA);
  return SAT.testPolygonPolygon(bodyA as Polygon, bodyB as Polygon);
}

/**
 * Move and optionally rotate a shape, returning a new one. Rotation is about the shape's own anchor,
 * which is what a jointed assembly needs: a part keeps its local points and only its placement
 * changes. A rect rotates into a polygon, since an axis-aligned box cannot express the result.
 */
export function transform(shape: Shape, dx: World = 0, dy: World = 0, angle = 0): Shape {
  if (!angle) {
    if (shape.kind === 'circle') return circle(shape.x + dx, shape.y + dy, shape.r);
    if (shape.kind === 'rect') return rect(shape.x + dx, shape.y + dy, shape.w, shape.h);
    return polygon(shape.x + dx, shape.y + dy, shape.points);
  }
  if (shape.kind === 'circle') return circle(shape.x + dx, shape.y + dy, shape.r);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const local = shape.kind === 'rect'
    ? [{ x: 0, y: 0 }, { x: shape.w, y: 0 }, { x: shape.w, y: shape.h }, { x: 0, y: shape.h }]
    : shape.points;
  return polygon(shape.x + dx, shape.y + dy, local.map(point => ({ x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos })));
}

/**
 * Is this polygon convex and simple enough for SAT? Generated content should be checked once at
 * build time rather than trusted, because a concave body separates in the wrong direction instead
 * of failing loudly.
 */
export function convex(points: Vec2[]): boolean {
  if (points.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const turn = cross > 0 ? 1 : -1;
    if (!sign) sign = turn; else if (turn !== sign) return false;
  }
  return sign !== 0;
}
