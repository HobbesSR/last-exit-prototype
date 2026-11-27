import { canOccupy } from '../movement.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, GroundItem, MatchContent, GameMap, Vec2 } from '../types.ts';
import type { PhysicsWorld } from '../physics/world.ts';
import type { BodySpec } from '../physics/types.ts';
import { hypot } from '../math.ts';

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Reject authoring before allocating a solver. All numbers are match-pinned tuning. */
export function validateWorldPhysics(content: MatchContent, map: Omit<GameMap, 'items' | 'traps'>): void {
  const profile = content.worldPhysics;
  if (!profile) throw new RangeError('world physics profile required');
  if (!content.itemInstances || !content.actorPhysics) throw new RangeError('world physics requires item instances and actor physics');
  if (![profile.loot.radius, profile.loot.mass, profile.prop.hx, profile.prop.hy, profile.prop.mass, profile.maxImpulse]
    .every(n => Number.isFinite(n) && n > 0 && n <= 10000)
    || ![profile.loot.linearDamping, profile.loot.angularDamping, profile.loot.dropSpeed,
      profile.prop.linearDamping, profile.prop.angularDamping, profile.prop.friction]
      .every(n => Number.isFinite(n) && n >= 0 && n <= 10000)
    || profile.loot.radius < 1 || profile.loot.radius > 16 || profile.prop.hx < 1 || profile.prop.hy < 1
    || profile.loot.mass < 1e-6 || profile.prop.mass < 1e-6 || profile.loot.dropSpeed > 60
    || profile.dropReserve !== undefined && (!Number.isInteger(profile.dropReserve) || profile.dropReserve < 0 || profile.dropReserve > 96)) throw new RangeError('invalid world physics profile');
  const ids = new Set<string>();
  if ((map.physicsProps?.length ?? 0) > 64) throw new RangeError('physics prop authoring capacity');
  // Conservative circumscribed footprint admits rotating crates without intersecting static geometry.
  const radius = hypot(profile.prop.hx, profile.prop.hy);
  for (const prop of map.physicsProps ?? []) {
    if (typeof prop.id !== 'string' || !prop.id || ids.has(prop.id) || prop.profile !== 'crate' || ![prop.x, prop.y, prop.angle ?? 0].every(Number.isFinite)
      || !canOccupy(map, prop.x, prop.y, radius)
      || (map.physicsProps ?? []).some(other => other !== prop && hypot(other.x - prop.x, other.y - prop.y) < radius * 2))
      throw new RangeError('invalid physics prop placement');
    ids.add(prop.id);
  }
  for (const surface of map.motorSurfaces ?? []) if (surface.drag !== undefined
    && (!Number.isFinite(surface.drag) || surface.drag < 0 || surface.drag > 1)) throw new RangeError('invalid floor drag');
}

/** The authored props' body specs in admission (ID) order, each with its authored label: one builder for the old world's admission and the new tick's loader. */
export function authoredProps(s: Game): Array<{ label: string; spec: BodySpec }> {
  const profile = s.content.worldPhysics;
  return [...s.map.physicsProps ?? []].sort((a, b) => order(a.id, b.id)).map(prop => ({ label: prop.id,
    spec: { id: `prop:${prop.id}`, kind: 'prop', shape: { kind: 'box', hx: profile.prop.hx, hy: profile.prop.hy },
      x: prop.x, y: prop.y, angle: prop.angle ?? 0, mass: profile.prop.mass, friction: profile.prop.friction,
      linearDamping: profile.prop.linearDamping, angularDamping: profile.prop.angularDamping } }));
}

export function addAuthoredProps(s: Game, r: PhysicsRuntime): void {
  for (const { spec } of authoredProps(s)) r.world.queueAddBody(spec);
  r.world.commitMutations();
}

export function launchPhysicalDrops(s: Game, items: GroundItem[], from: Vec2): void {
  const r = physicsRuntime(s), speed = s.content.worldPhysics.loot.dropSpeed;
  if (!r) return;
  for (const item of items) {
    const dx = item.x - from.x, dy = item.y - from.y, length = hypot(dx, dy);
    r.itemLaunches.set(item.id, { x: length ? dx / length * speed : 0, y: length ? dy / length * speed : 0 });
  }
  r.synchronize();
}

/** The floors and profiles each world was last given, so they cross once per match rather than once per tick. */
const floors = new WeakMap<PhysicsWorld, { surfaces: GameMap['motorSurfaces']; profile: MatchContent['worldPhysics'] }>();
/**
 * Floor drag runs in the core (`rust/core/src/floor_drag.rs`, #1226): a prop's damping is its profile's scaled by the
 * drag of the first floor containing it, in the motor's priority/ID order. Damping changes never wake a sleeper.
 */
export function applyFloorDrag(s: Game, r: PhysicsRuntime): void {
  ensureFloor(s, r);
  r.world.applyFloorDrag();
}

/** Hand the world its floors and profiles, once per match. */
function ensureFloor(s: Game, r: PhysicsRuntime): void {
  const profile = s.content.worldPhysics, surfaces = s.map.motorSurfaces, sent = floors.get(r.world);
  if (!sent || sent.surfaces !== surfaces || sent.profile !== profile) {
    r.world.setFloor([...surfaces ?? []].sort((a, b) => b.priority - a.priority || order(a.id, b.id))
      .map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h, drag: f.drag ?? 1 })), profile.loot, profile.prop);
    floors.set(r.world, { surfaces, profile });
  }
}
