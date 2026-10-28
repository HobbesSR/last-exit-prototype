import { canOccupy } from '../movement.ts';
import { actorRadius } from './actor-physics.ts';
import { physicsRuntime, markPhysicsDiscontinuity } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, GroundItem, MatchContent, GameMap, Vec2 } from '../types.ts';
import { hypot } from '../math.ts';

export const PHYSICS_WORLD_VERSION = 'last-exit-0.8-physics-5';
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const reserveActors = (s: Game, r: PhysicsRuntime) => Math.max(0, s.players.length - r.actors.size);
const bodyId = (item: GroundItem) => `item:${item.id}`;

/** P8 drop admission uses the same footprint as scatter planning. Loot stays a sensor after admission. */
export function physicalDropPlacementClear(s: Game, r: PhysicsRuntime, x: number, y: number): boolean {
  const radius = s.content.worldPhysics?.loot.radius;
  if (!s.content.dynamicNavigation || radius === undefined) return true;
  return !r.world.overlapsProp(x, y, radius)
    && s.players.every(p => p.status !== 'active' || hypot(x - p.x, y - p.y) >= radius + actorRadius(s, p));
}

/** Reject authoring before allocating a solver. All numbers are match-pinned tuning. */
export function validateWorldPhysics(content: MatchContent, map: GameMap): void {
  const profile = content.worldPhysics;
  if (!profile) return;
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
  if (!profile) return;
  for (const prop of [...s.map.physicsProps ?? []].sort((a, b) => order(a.id, b.id))) {
    r.world.queueAddBody({ id: `prop:${prop.id}`, kind: 'prop', shape: { kind: 'box', hx: profile.prop.hx, hy: profile.prop.hy },
      x: prop.x, y: prop.y, angle: prop.angle ?? 0, mass: profile.prop.mass, friction: profile.prop.friction,
      linearDamping: profile.prop.linearDamping, angularDamping: profile.prop.angularDamping });
  }
  r.world.commitMutations();
}

/** Reconcile ownership at transfer boundaries. Mandatory overflow remains logical and pickable. */
export function synchronizePhysicalItems(s: Game, r: PhysicsRuntime, markTick: number, admit = true): void {
  const profile = s.content.worldPhysics;
  if (!profile) return;
  const wanted = new Set(s.map.items.map(bodyId));
  for (const id of [...r.items].sort(order)) if (!wanted.has(id)) {
    markPhysicsDiscontinuity(r, { id, generation: r.world.getGeneration(id)!, kind: 'removed', tick: markTick });
    r.world.queueRemoveBody(id); r.items.delete(id);
  }
  r.world.commitMutations();
  if (!admit) return;
  // A transfer that preflighted a batch owns its released slots before retrying overflow.
  for (const item of [...s.map.items].sort((a, b) => Number(r.itemLaunches.has(b.id)) - Number(r.itemLaunches.has(a.id)) || order(a.id, b.id))) {
    const id = bodyId(item);
    // A launched or dropped item may use the drop reserve; an ordinary map item must leave it free.
    const reserve = r.itemLaunches.has(item.id) ? 0 : profile.dropReserve ?? 0;
    if (r.items.has(id) || !r.world.canAddBodies(1 + reserveActors(s, r) + reserve) || !canOccupy(s.map, item.x, item.y, profile.loot.radius)
      || !physicalDropPlacementClear(s, r, item.x, item.y)) continue;
    const motion = r.itemLaunches.get(item.id);
    r.world.queueAddBody({ id, kind: 'prop', collisionProfile: 'loot', shape: { kind: 'circle', radius: profile.loot.radius },
      x: item.x, y: item.y, mass: profile.loot.mass, friction: 0, restitution: 0,
      linearDamping: profile.loot.linearDamping, angularDamping: profile.loot.angularDamping,
      vx: motion?.x ?? 0, vy: motion?.y ?? 0 });
    r.items.add(id);
    r.world.commitMutations();
    markPhysicsDiscontinuity(r, { id, generation: r.world.getGeneration(id)!, kind: 'placed', tick: markTick });
  }
  r.world.commitMutations();
  r.itemLaunches.clear();
}

/** Preflight staged swaps too: removed physical pickups release their body slots. */
export function canRepresentPhysicalDrop(s: Game, count: number, removed: GroundItem[] = []): boolean {
  const r = physicsRuntime(s);
  if (!s.content.worldPhysics || !r) return true;
  if (!s.content.dynamicNavigation) r.synchronize({ deferItemAdmission: true });
  const released = removed.filter(item => r.items.has(bodyId(item))).length;
  return r.world.canAddBodies(Math.max(0, count - released) + reserveActors(s, r));
}

export function launchPhysicalDrops(s: Game, items: GroundItem[], from: Vec2): void {
  const r = physicsRuntime(s), speed = s.content.worldPhysics?.loot.dropSpeed;
  if (!r || speed === undefined) return;
  for (const item of items) {
    const dx = item.x - from.x, dy = item.y - from.y, length = hypot(dx, dy);
    r.itemLaunches.set(item.id, { x: length ? dx / length * speed : 0, y: length ? dy / length * speed : 0 });
  }
  r.synchronize();
}

export function writePhysicalItemPoses(s: Game, r: PhysicsRuntime): void {
  for (const item of s.map.items) {
    if (!r.items.has(bodyId(item))) continue;
    const pose = r.world.getTransform(bodyId(item));
    if (pose) { item.x = pose.x; item.y = pose.y; }
  }
}

/** Same floor priority/ID convention as the motor. Damping changes never wake a sleeper. */
export function applyFloorDrag(s: Game, r: PhysicsRuntime): void {
  const profile = s.content.worldPhysics;
  if (!profile) return;
  const surfaces = [...s.map.motorSurfaces ?? []].sort((a, b) => b.priority - a.priority || order(a.id, b.id));
  for (const body of r.world.snapshot({ includeStatic: false }).bodies) {
    if (body.spec.kind !== 'prop') continue;
    const p = body.transform;
    const drag = surfaces.find(f => p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h)?.drag ?? 1;
    const base = body.spec.collisionProfile === 'loot' ? profile.loot : profile.prop;
    r.world.setDamping(body.spec.id, base.linearDamping * drag, base.angularDamping * drag);
  }
}
