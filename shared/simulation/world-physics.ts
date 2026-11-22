import { itemLabel } from '../item-instances.ts';
import { canOccupy } from '../movement.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, GroundItem, MatchContent, GameMap, Vec2 } from '../types.ts';
import type { PhysicsWorld } from '../physics/world.ts';
import { hypot } from '../math.ts';
import { groundItem, replaceItem } from './ground-items.ts';

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const reserveActors = (s: Game, r: PhysicsRuntime) => Math.max(0, s.players.length - r.actors.size);
const ITEM_PREFIX = 'item:';
const bodyId = (s: Game, item: GroundItem) => `${ITEM_PREFIX}${itemLabel(s, item.id)}`;

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

export function addAuthoredProps(s: Game, r: PhysicsRuntime): void {
  const profile = s.content.worldPhysics;
  for (const prop of [...s.map.physicsProps ?? []].sort((a, b) => order(a.id, b.id))) {
    r.world.queueAddBody({ id: `prop:${prop.id}`, kind: 'prop', shape: { kind: 'box', hx: profile.prop.hx, hy: profile.prop.hy },
      x: prop.x, y: prop.y, angle: prop.angle ?? 0, mass: profile.prop.mass, friction: profile.prop.friction,
      linearDamping: profile.prop.linearDamping, angularDamping: profile.prop.angularDamping });
  }
  r.world.commitMutations();
}

/** Preflight staged swaps too: removed physical pickups release their body slots. */
export function canRepresentPhysicalDrop(s: Game, count: number, removed: GroundItem[] = []): boolean {
  const r = physicsRuntime(s);
  if (!r) return true;
  const released = removed.filter(item => r.items.has(bodyId(s, item))).length;
  return r.world.canAddBodies(Math.max(0, count - released) + reserveActors(s, r));
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

/**
 * Phase 4's ground poses, from the core (#1214 stage 6e.4): the core moved each record whose body the step moved, in its
 * ground store, and this mirrors them without writing them through. Call it right after `players_after_step`.
 */
export function adoptItemPoses(s: Game, r: PhysicsRuntime): void {
  const { core, world } = r.world.boundaryCall();
  const at = (core as typeof core & { ground_poses_after_step(world: number): number }).ground_poses_after_step(world) >>> 0;
  const count = new Float64Array(core.memory.buffer, at, 1)[0]!;
  applyItemPoses(s, new Float64Array(core.memory.buffer, at + 8, count * 3).slice());
}

/** The moved ground records (`id, x, y` each), mirrored without writing them through (6e.4). */
export function applyItemPoses(s: Game, moved: Float64Array): void {
  for (let k = 0; k < moved.length / 3; k++) {
    const item = groundItem(s, moved[k * 3]! as GroundItem['id']);
    if (item) replaceItem(s, item, { ...item, x: moved[k * 3 + 1]!, y: moved[k * 3 + 2]! }, true);
  }
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
export function ensureFloor(s: Game, r: PhysicsRuntime): void {
  const profile = s.content.worldPhysics, surfaces = s.map.motorSurfaces, sent = floors.get(r.world);
  if (!sent || sent.surfaces !== surfaces || sent.profile !== profile) {
    r.world.setFloor([...surfaces ?? []].sort((a, b) => b.priority - a.priority || order(a.id, b.id))
      .map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h, drag: f.drag ?? 1 })), profile.loot, profile.prop);
    floors.set(r.world, { surfaces, profile });
  }
}
