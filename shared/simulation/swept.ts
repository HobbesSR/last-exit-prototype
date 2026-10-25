import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import { bounds, circle, polygon, rect, segmentShapeDistance } from '../shape.ts';
import type { Shape } from '../shape.ts';
import { seeThrough } from '../movement.ts';
import type { BodyDefinition } from '../physics/types.ts';
import type { CollisionMap, Gate, Role, Vec2 } from '../types.ts';

// The one owner of swept queries against actors and geometry: physical projectiles and the P6 hook
// tip/tether both ask the same questions, differing only in radius and which geometry blocks them.

const BISECTION_STEPS = 26;
const shotCache = new WeakMap<CollisionMap, Shape[]>();
const solidCache = new WeakMap<CollisionMap, Shape[]>();

/** Swept hit radius of an actor, shared by shots, the hook tip and legacy projectiles. */
export function actorHitRadius(role: Role): number { return role === 'gladiator' ? 26 : 15; }

export function shapeOfBody(body: BodyDefinition): Shape {
  if (body.shape.kind === 'circle') return circle(body.x, body.y, body.shape.radius);
  if (body.shape.kind === 'box') return rect(body.x - body.shape.hx, body.y - body.shape.hy,
    body.shape.hx * 2, body.shape.hy * 2);
  return polygon(body.x, body.y, body.shape.vertices);
}

/**
 * Static physics geometry as query shapes. Shots pass see-through obstacles (fences, windows); a
 * tether is physical and does not, so `passSeeThrough` is the caller's stated policy.
 */
export function staticShapes(map: CollisionMap, passSeeThrough: boolean): Shape[] {
  const cache = passSeeThrough ? shotCache : solidCache;
  let cached = cache.get(map);
  if (!cached) {
    const passable = passSeeThrough
      ? new Set(map.obstacles.filter(o => seeThrough(o.kind)).map(o => `obstacle:${o.id}`)) : new Set<string>();
    cached = buildPhysicsGeometry(map).filter(body => !passable.has(body.id)).map(shapeOfBody);
    cache.set(map, cached);
  }
  return cached;
}

export function closedGateShapes(gates: readonly Gate[]): Shape[] {
  return gates.filter(gate => !gate.open).map(gate => shapeOfBody(physicsGate(gate)));
}

/** First relative disk intersection of a moving point and a moving actor, including an initial overlap. */
export function impact(a: Vec2, b: Vec2, start: Vec2, end: Vec2, radius: number): number | null {
  const x = a.x - start.x, y = a.y - start.y;
  const dx = b.x - a.x - (end.x - start.x), dy = b.y - a.y - (end.y - start.y);
  const c = x * x + y * y - radius * radius;
  if (c <= 0) return 0;
  const aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy), d = bb * bb - 4 * aa * c;
  if (!aa || d < 0) return null;
  const t = (-bb - Math.sqrt(d)) / (2 * aa);
  return t >= 0 && t <= 1 ? t : null;
}

/** First contact of a radius-`radius` point swept from a to b with any shape; Infinity when clear. */
export function firstContact(a: Vec2, b: Vec2, shapes: readonly Shape[], radius: number): number {
  const left = Math.min(a.x, b.x) - radius;
  const right = Math.max(a.x, b.x) + radius;
  const top = Math.min(a.y, b.y) - radius;
  const bottom = Math.max(a.y, b.y) + radius;
  let first = Infinity;
  for (const shape of shapes) {
    const box = bounds(shape);
    if (box.x > right || box.y > bottom || box.x + box.w < left || box.y + box.h < top) continue;
    if (segmentShapeDistance(a, b, shape) > radius) continue;
    if (segmentShapeDistance(a, a, shape) <= radius) return 0;
    let lo = 0, hi = first < Infinity ? first : 1;
    // A prior collider may already be earlier than this one.
    const clipped = { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi };
    if (segmentShapeDistance(a, clipped, shape) > radius) continue;
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const mid = (lo + hi) / 2;
      const end = { x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid };
      if (segmentShapeDistance(a, end, shape) <= radius) hi = mid;
      else lo = mid;
    }
    // The lower bracket is conservatively before contact, so a mathematically
    // simultaneous actor and wall hit is awarded to geometry despite rounding.
    first = Math.min(first, lo);
  }
  return first;
}
