import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import { bounds, circle, polygon, rect, segmentShapeDistance } from '../shape.ts';
import type { Shape } from '../shape.ts';
import { seeThrough } from '../movement.ts';
import { damage } from './combat.ts';
import type { BodyDefinition } from '../physics/types.ts';
import type { CollisionMap, Game, Player, Projectile, Vec2 } from '../types.ts';

const PROJECTILE_RADIUS = 2;
const BISECTION_STEPS = 26;
const staticCache = new WeakMap<CollisionMap, Shape[]>();

function shapeOfBody(body: BodyDefinition): Shape {
  if (body.shape.kind === 'circle') return circle(body.x, body.y, body.shape.radius);
  if (body.shape.kind === 'box') return rect(body.x - body.shape.hx, body.y - body.shape.hy,
    body.shape.hx * 2, body.shape.hy * 2);
  return polygon(body.x, body.y, body.shape.vertices);
}

function staticShapes(map: CollisionMap): Shape[] {
  let cached = staticCache.get(map);
  if (!cached) {
    const passableToShots = new Set(map.obstacles.filter(o => seeThrough(o.kind)).map(o => `obstacle:${o.id}`));
    cached = buildPhysicsGeometry(map).filter(body => !passableToShots.has(body.id)).map(shapeOfBody);
    staticCache.set(map, cached);
  }
  return cached;
}

/** First contact of a radius-2 projectile with a static shape during one full tick. */
function geometryImpact(a: Vec2, b: Vec2, shapes: Shape[]): number {
  const left = Math.min(a.x, b.x) - PROJECTILE_RADIUS;
  const right = Math.max(a.x, b.x) + PROJECTILE_RADIUS;
  const top = Math.min(a.y, b.y) - PROJECTILE_RADIUS;
  const bottom = Math.max(a.y, b.y) + PROJECTILE_RADIUS;
  let first = Infinity;
  for (const shape of shapes) {
    const box = bounds(shape);
    if (box.x > right || box.y > bottom || box.x + box.w < left || box.y + box.h < top) continue;
    if (segmentShapeDistance(a, b, shape) > PROJECTILE_RADIUS) continue;
    if (segmentShapeDistance(a, a, shape) <= PROJECTILE_RADIUS) return 0;
    let lo = 0, hi = first < Infinity ? first : 1;
    // A prior collider may already be earlier than this one.
    const clipped = { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi };
    if (segmentShapeDistance(a, clipped, shape) > PROJECTILE_RADIUS) continue;
    for (let i = 0; i < BISECTION_STEPS; i++) {
      const mid = (lo + hi) / 2;
      const end = { x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid };
      if (segmentShapeDistance(a, end, shape) <= PROJECTILE_RADIUS) hi = mid;
      else lo = mid;
    }
    // The lower bracket is conservatively before contact, so a mathematically
    // simultaneous actor and wall hit is awarded to geometry despite rounding.
    first = Math.min(first, lo);
  }
  return first;
}

/** First relative disk intersection on a normalized segment, including an initial overlap. */
function impact(a: Vec2, b: Vec2, start: Vec2, end: Vec2, radius: number): number | null {
  const x = a.x - start.x, y = a.y - start.y;
  const dx = b.x - a.x - (end.x - start.x), dy = b.y - a.y - (end.y - start.y);
  const c = x * x + y * y - radius * radius;
  if (c <= 0) return 0;
  const aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy), d = bb * bb - 4 * aa * c;
  if (!aa || d < 0) return null;
  const t = (-bb - Math.sqrt(d)) / (2 * aa);
  return t >= 0 && t <= 1 ? t : null;
}

/** One swept owner for fast query projectiles; never also run legacy advanceProjectiles. */
export function solvePhysicsProjectiles(s: Game, paths: Record<string, Vec2[]>): void {
  const hits: { bullet: Projectile; target: Player; toi: number }[] = [];
  const expired = new Set<Projectile>();
  const shapes = [...staticShapes(s.map), ...s.map.gates.filter(g => !g.open).map(g => shapeOfBody(physicsGate(g)))];
  for (const bullet of s.projectiles) {
    const origin = { x: bullet.x, y: bullet.y };
    const end = { x: bullet.x + bullet.dx, y: bullet.y + bullet.dy };
    bullet.life--;
    if (bullet.life <= 0) { expired.add(bullet); continue; }
    const blockedAt = geometryImpact(origin, end, shapes);
    if (blockedAt < Infinity) expired.add(bullet);
    for (const target of s.players) {
      if (target.id === bullet.owner || target.status !== 'active') continue;
      const path = paths[`actor:${target.id}`] ?? Array.from({ length: 5 }, () => ({ x: target.x, y: target.y }));
      for (let k = 0; k < 4; k++) {
        const a = { x: origin.x + bullet.dx * k / 4, y: origin.y + bullet.dy * k / 4 };
        const b = { x: origin.x + bullet.dx * (k + 1) / 4, y: origin.y + bullet.dy * (k + 1) / 4 };
        const t = impact(a, b, path[k]!, path[k + 1]!, target.role === 'gladiator' ? 26 : 15);
        if (t === null) continue;
        const toi = (k + t) / 4;
        if (toi < blockedAt) hits.push({ bullet, target, toi });
        break;
      }
    }
    bullet.x = end.x; bullet.y = end.y;
  }
  const consumed = new Set<Projectile>();
  hits.sort((a, b) => a.toi - b.toi || a.bullet.id - b.bullet.id || compare(a.target.id, b.target.id));
  for (const { bullet, target } of hits) {
    if (consumed.has(bullet) || target.status !== 'active') continue;
    consumed.add(bullet);
    damage(s, target, bullet.damage, s.players.find(p => p.id === bullet.owner) ?? null);
  }
  s.projectiles = s.projectiles.filter(b => !consumed.has(b) && !expired.has(b));
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
