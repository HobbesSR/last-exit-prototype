import { createGameRecord } from './state.ts';
import { canOccupy, gateShape, prepareMovementGeometry } from '../movement.ts';
import { actorRadius, validateActorPhysics } from './actor-physics.ts';
import { addAuthoredProps, synchronizePhysicalItems, validateWorldPhysics } from './world-physics.ts';
import { reconcileHooks } from './hook.ts';
import { attachPhysics, physicsRuntime, markPhysicsDiscontinuity, PHYSICS_VERSION } from './physics-runtime.ts';
import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, GameMap, MatchContent, Player, Vec2 } from '../types.ts';
import { cos, hypot, sin } from '../math.ts';
import { start, stop } from '../profiler.ts';

export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const actorId = (p: Player) => `actor:${p.id}`;
export const ordered = (s: Game) => [...s.players].sort((a, b) => compare(a.id, b.id));

/** Build a stepping match: `createGameRecord` builds its record, and this adds the physics world.
 * `yieldControl` is for private preparation of a caller-owned map; the caller must
 * not publish or mutate that map while construction is pending. It never runs in a tick. */
export async function createGame(seed: number, map: GameMap, content?: MatchContent, yieldControl?: () => Promise<void>): Promise<Game> {
  // Preparation is private until the factory resolves. Only the server supplies
  // event-loop yields; shared/browser callers retain the ordinary construction path.
  if (yieldControl) await prepareMovementGeometry(map, yieldControl);
  const s = createGameRecord(seed, map, content);
  if (yieldControl) await yieldControl();
  validateActorPhysics(s.content.actorPhysics, s.map);
  validateWorldPhysics(s.content, s.map);
  // Bots plan over tiles, a repath spread over ticks: the only planner since #920 retired the grid search and one-tick repaths.
  if (s.content.navigation !== 'tiles' || (s.content.replanning !== 'sliced' && s.content.replanning !== 'repair')) throw new RangeError('physics content plans over tiles with sliced or repair replanning');
  if (s.content.dynamicNavigation !== true) throw new RangeError('dynamic navigation required');
  if (!s.content.itemInstances || typeof s.content.itemInstances !== 'object'
    || !Number.isSafeInteger(s.content.itemInstances.groundCapacity) || s.content.itemInstances.groundCapacity < 0)
    throw new RangeError('item instances required');
  const h = s.content.hook;
  if (!h || !s.content.kits?.hook || ![h.range, h.speed, h.maxForce, h.stiffness, h.damping,
    h.pullSpeed, h.durationTicks, h.cooldownTicks, h.standoff, h.targetDistance, h.breakDistance].every(n => Number.isFinite(n) && n > 0 && n <= 100000)
    || !Number.isInteger(h.durationTicks) || !Number.isInteger(h.cooldownTicks) || h.breakDistance < h.range
    || h.standoff > h.range || h.targetDistance >= h.standoff
    || h.targetDistance < s.content.actorPhysics.geometry.contestant.bodyRadius + s.content.actorPhysics.geometry.gladiator.bodyRadius)
    throw new RangeError('invalid hook profile');
  // Character and world physics profiles, hook tuning and authored props/surfaces are match-pinned.
  const profile = structuredClone(s.content.actorPhysics);
  Object.values(profile.geometry).forEach(Object.freeze); Object.freeze(profile.geometry); Object.freeze(profile);
  s.content = Object.freeze({ ...s.content, hook: Object.freeze({ ...h }),
    worldPhysics: Object.freeze({ ...s.content.worldPhysics, loot: Object.freeze({ ...s.content.worldPhysics.loot }), prop: Object.freeze({ ...s.content.worldPhysics.prop }) }),
    actorPhysics: profile });
  s.map.physicsProps = structuredClone(s.map.physicsProps ?? []);
  s.map.physicsProps.forEach(Object.freeze); Object.freeze(s.map.physicsProps);
  Object.defineProperty(s.map, 'physicsProps', { writable: false, configurable: false });
  if (s.map.motorSurfaces) {
    s.map.motorSurfaces = structuredClone(s.map.motorSurfaces);
    s.map.motorSurfaces.forEach(Object.freeze); Object.freeze(s.map.motorSurfaces);
  }
  Object.defineProperty(s.map, 'motorSurfaces', { writable: false, configurable: false });
  if (s.players.length > 27) throw new RangeError('physics actor capacity is 27');
  const { createPhysicsWorld } = await import('../physics/world.ts');
  const world = await createPhysicsWorld();
  const runtime: PhysicsRuntime = { stepping: false, discontinuityCapacity: 256, world, actors: new Set(), items: new Set(), itemLaunches: new Map(),
    gateOrder: [...s.map.gates].sort((a, b) => compare(a.id, b.id)), gates: new Uint8Array(s.map.gates.length), discontinuities: [],
    synchronize: options => synchronize(s, runtime, runtime.stepping ? s.tick : s.tick + 1, options?.deferItemAdmission),
    placement: (p, destination) => placement(s, runtime, p, ordered(s).filter(q => q !== p && q.status === 'active'), destination),
    pendingSpawns: [], pendingImpulses: [], pendingAttachments: [], hooks: [] };
  try {
    const geometry = buildPhysicsGeometry(s.map).sort((a, b) => compare(a.id, b.id));
    if (yieldControl) await yieldControl();
    for (let i = 0; i < geometry.length; i++) {
      world.queueAddBody({ ...geometry[i]!, mapGeometry: true });
      if (i % 512 === 511) {
        world.commitMutations();
        if (yieldControl) await yieldControl();
      }
    }
    world.commitMutations();
    // Authored static geometry stays pinned; bots' detours overlay what they observe of dynamic bodies locally.
    for (const obstacle of s.map.obstacles) {
      if (obstacle.points) { obstacle.points.forEach(Object.freeze); Object.freeze(obstacle.points); }
      Object.freeze(obstacle);
    }
    Object.freeze(s.map.obstacles);
    if (s.map.playableArea) {
      for (const row of s.map.playableArea.rows) { row.runs.forEach(Object.freeze); Object.freeze(row.runs); Object.freeze(row); }
      Object.freeze(s.map.playableArea.rows); Object.freeze(s.map.playableArea);
    }
    for (const gate of s.map.gates) for (const key of ['id', 'x', 'y', 'w', 'h', 'kind'] as const) Object.defineProperty(gate, key, { writable: false, configurable: false });
    Object.freeze(s.map.gates);
    for (const key of ['width', 'height', 'obstacles', 'playableArea', 'gates'] as const) Object.defineProperty(s.map, key, { writable: false, configurable: false });
    if (yieldControl) await yieldControl();
    addAuthoredProps(s, runtime);
    attachPhysics(s, runtime);
    Object.defineProperty(s, 'version', { value: PHYSICS_VERSION, enumerable: true, writable: false });
    synchronize(s, runtime, s.tick + 1);
    return s;
  } catch (error) { world.dispose(); throw error; }
}

/** Bounded placement is explicit; failing admission never spawns an overlapping body. */
function placement(s: Game, r: PhysicsRuntime, p: Player, admitted: Player[], origin: Vec2 = p): Vec2 | null {
  const radius = actorRadius(s, p);
  const free = (x: number, y: number) => canOccupy(s.map, x, y, radius)
    && admitted.every(q => hypot(x - q.x, y - q.y) >= radius + actorRadius(s, q))
    && !r.world.overlapsProp(x, y, radius);
  if (free(origin.x, origin.y)) return { x: origin.x, y: origin.y };
  for (let ring = 1; ring <= 24; ring++) {
    for (let i = 0; i < 32; i++) {
      const angle = i * Math.PI / 16, x = origin.x + cos(angle) * ring * 4, y = origin.y + sin(angle) * ring * 4;
      if (free(x, y)) return { x, y };
    }
  }
  return null;
}

/**
 * `markTick` is the last tick whose capture carries a discontinuity marked here: the current one
 * inside a step, the next one between ticks, whose capture has already been taken.
 */
export function synchronize(s: Game, r: PhysicsRuntime, markTick: number, deferItemAdmission = false): void {
  const active = ordered(s).filter(p => p.status === 'active');
  const wanted = new Set(active.map(actorId));
  for (const id of [...r.actors].sort(compare)) if (!wanted.has(id)) {
    markPhysicsDiscontinuity(r, { id, generation: r.world.getGeneration(id)!, kind: 'removed', tick: markTick });
    r.world.queueRemoveBody(id); r.actors.delete(id);
  }
  r.world.commitMutations();
  const admitted: Player[] = [];
  for (const p of active) {
    const id = actorId(p), current = r.world.getTransform(id);
    if (current && hypot(current.x - p.x, current.y - p.y) < 1e-6) { admitted.push(p); continue; }
    const at = placement(s, r, p, [...admitted, ...active.filter(q => q !== p && r.actors.has(actorId(q)))]);
    if (!at) {
      if (current) { p.x = current.x; p.y = current.y; admitted.push(p); continue; }
      // Gladiator respawns retry at a future boundary. Initial invalid contestant placement is refused.
      if (p.role === 'gladiator' && s.tick > 0) { p.status = 'respawning'; p.respawnAt = s.tick + 1; continue; }
      throw new Error(`no legal physics placement for ${p.id}`);
    }
    p.x = at.x; p.y = at.y;
    if (current) r.world.setTransform(id, { ...at, angle: 0 });
    else { r.world.queueAddBody({ id, kind: 'actor', shape: { kind: 'circle', radius: actorRadius(s, p) }, ...at, mass: 1, friction: 0, restitution: 0,
      maxSpeed: s.content.actorPhysics.maxSpeed }); r.actors.add(id); r.world.commitMutations(); }
    markPhysicsDiscontinuity(r, { id, generation: r.world.getGeneration(id)!, kind: 'placed', tick: markTick });
    admitted.push(p);
  }
  for (let i = 0; i < r.gateOrder.length; i++) {
    const gate = r.gateOrder[i]!, pushed = r.gates[i]!;
    if (pushed === (gate.open ? 1 : 2)) continue;
    if (!gate.open && r.world.overlapsDynamicBox(gateShape(gate))) {
      // Closing is refused while any active actor or solid prop occupies the footprint; nothing
      // retries it, so the gate stays open until someone closes it again.
      gate.open = true;
      r.gates[i] = 1;
      continue;
    }
    if (pushed === 2) r.world.queueRemoveBody(`gate:${gate.id}`);
    if (!gate.open) r.world.queueAddBody(physicsGate(gate));
    r.gates[i] = gate.open ? 1 : 2;
    r.world.commitMutations();
  }
  start('sim.itemSync'); synchronizePhysicalItems(s, r, markTick, !deferItemAdmission); stop('sim.itemSync');
  r.pendingImpulses = r.pendingImpulses.filter(entry => r.world.getGeneration(entry.id) === entry.generation);
  r.pendingAttachments = r.pendingAttachments.filter(entry => r.world.getGeneration(entry.a) === entry.generationA
    && r.world.getGeneration(entry.b) === entry.generationB);
  reconcileHooks(s);
}

/** Match seat/teleport boundaries reconcile game IDs before the first recorded frame. */
export function synchronizePhysics(s: Game): void { physicsRuntime(s)?.synchronize(); }
