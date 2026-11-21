import { createGameRecord } from './state.ts';
import { prepareMovementGeometry } from '../movement.ts';
import { prepareSightIndex } from '../sight.ts';
import { initCoreSight } from '../sight-core.ts';
import { initPhaseOne } from './phase-one.ts';
import { initItemAllocation } from '../item-allocation-core.ts';
import { attachSight } from './sight-runtime.ts';
import { ownDoors } from './doors.ts';
import { ownGround } from './ground-store.ts';
import { validateActorPhysics } from './actor-physics.ts';
import { addAuthoredProps, validateWorldPhysics } from './world-physics.ts';
import { placeInCore, synchronizeBodies, synchronizeItems, uploadGateBodies } from './boundary.ts';
import { reconcileHooks } from './hook.ts';
import { attachPhysics, physicsRuntime, PHYSICS_VERSION } from './physics-runtime.ts';
import { buildPhysicsGeometry } from './physics-geometry.ts';
import { prepareBotGates } from './bot-routes.ts';
import { prepareSweptGeometry, prepareSweptGates } from './swept.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, GameMap, GateIdx, MatchContent, Player, Vec2 } from '../types.ts';
import { start, stop, profiling, observe } from '../profiler.ts';
import { PhysicsIdentities } from './physics-identities.ts';

export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const actorId = (p: Player) => `actor:${p.id}`;
export const ordered = (s: Game) => [...s.players].sort((a, b) => compare(a.id, b.id));

/** Build a stepping match: `createGameRecord` builds its record, and this adds the engines it runs on: the
 * physics world, and the core's sight (`sight-runtime.ts`), which every caller gets without supplying it.
 * `yieldControl` is for private preparation of a caller-owned map; the caller must
 * not publish or mutate that map while construction is pending. It never runs in a tick. */
export async function createGame(seed: number, map: GameMap, content?: MatchContent, yieldControl?: () => Promise<void>): Promise<Game> {
  // Preparation is private until the factory resolves. Only the server supplies
  // event-loop yields; shared/browser callers retain the ordinary construction path.
  if (yieldControl) { await prepareMovementGeometry(map, yieldControl); await prepareSightIndex(map, yieldControl); }
  const sight = await initCoreSight();
  await initPhaseOne();
  const itemAllocator = await initItemAllocation();
  const s = createGameRecord(seed, map, content, sight, itemAllocator);
  attachSight(s, sight);
  if (yieldControl) await yieldControl();
  // The core's collision upload, sight index and gate set, which phase 1, the body sync and the placement search
  // query: built with the map, so neither the first sync below nor the first tick builds them (42.66).
  sight.prepareCollision(s.map);
  if (yieldControl) await yieldControl();
  validateActorPhysics(s.content.actorPhysics, s.map);
  validateWorldPhysics(s.content, s.map);
  // One door list: the records mirror the doors' state, which the core keeps (`doors.ts`), and collision and sight
  // read the same records as geometry.
  if (s.gates !== s.map.gates) throw new RangeError('gates must be the map gate list');
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
  const runtime: PhysicsRuntime = { identities: new PhysicsIdentities(), stepping: false, discontinuityCapacity: 256, world, actors: new Set(), items: new Set(), itemLaunches: new Map(),
    gateOrder: s.gates.map((_, i) => i as GateIdx).sort((a, b) => compare(s.gates[a].id, s.gates[b].id)), gates: new Uint8Array(s.gates.length), discontinuities: [],
    synchronize: options => synchronize(s, runtime, runtime.stepping ? s.tick : s.tick + 1, options?.deferItemAdmission),
    placement: (p, destination) => placement(s, runtime, p, ordered(s).filter(q => q !== p && q.status === 'active'), destination),
    pendingSpawns: [], pendingImpulses: [], pendingAttachments: [], hooks: [] };
  try {
    const geometry = buildPhysicsGeometry(s.map);
    // Sweeps preserve source order; native body admission preserves ID order.
    if (yieldControl) await prepareSweptGeometry(s.map, geometry, yieldControl);
    geometry.sort((a, b) => compare(a.id, b.id));
    if (yieldControl) await yieldControl();
    for (let i = 0; i < geometry.length; i++) {
      world.queueAddBody({ ...geometry[i]!, mapGeometry: true });
      if (i % 512 === 511) {
        world.commitMutations();
        if (yieldControl) await yieldControl();
      }
    }
    world.commitMutations();
    // Rapier's first step builds its broad phase over every map collider (#1087). Taken here, while only
    // statics exist, that work leaves tick 1; every frame, view and replay stays the same.
    {
      const before = profiling() ? performance.now() : undefined;
      world.prepareStatics();
      if (before !== undefined) observe('prepare.staticsStep', performance.now() - before);
    }
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
    for (const gate of s.gates) for (const key of ['id', 'x', 'y', 'w', 'h', 'kind'] as const) Object.defineProperty(gate, key, { writable: false, configurable: false });
    Object.freeze(s.gates);
    // The doors' state is the core's from here on; the records mirror it (#1214 stage 6a).
    ownDoors(s);
    for (const key of ['width', 'height', 'obstacles', 'playableArea', 'gates'] as const) Object.defineProperty(s.map, key, { writable: false, configurable: false });
    // Return control after pinning geometry; small gate caches may finish without yielding.
    if (yieldControl) await yieldControl();
    if (yieldControl) {
      const before = profiling() ? performance.now() : undefined;
      await prepareSweptGates(s.gates, yieldControl);
      if (before !== undefined) observe('prepare.sweptGates', performance.now() - before);
    }
    // The core's swept upload for the hook's rules, read from the swept caches just built while yielding (#1229).
    sight.prepareSwept(s.map);
    if (yieldControl) await yieldControl();
    if (yieldControl) {
      const before = profiling() ? performance.now() : undefined;
      await prepareBotGates(s.map, yieldControl);
      if (before !== undefined) observe('prepare.botGates', performance.now() - before);
    }
    addAuthoredProps(s, runtime);
    attachPhysics(s, runtime);
    // The ground helpers write through to the core's ground store from here on (#1214 stage 6d.1).
    ownGround(s);
    // The body sync reconciles the gates' bodies in the core, from their keys and closed rows (#1214 stage 6d.2).
    uploadGateBodies(s, runtime);
    Object.defineProperty(s, 'version', { value: PHYSICS_VERSION, enumerable: true, writable: false });
    synchronize(s, runtime, s.tick + 1);
    return s;
  } catch (error) { world.dispose(); throw error; }
}

/**
 * Bounded placement is explicit; failing admission never spawns an overlapping body. The search runs in the core
 * (`rust/core/src/placement.rs`), which the body sync and phase 1's landing share.
 */
function placement(s: Game, r: PhysicsRuntime, p: Player, admitted: Player[], origin: Vec2 = p): Vec2 | null {
  return placeInCore(s, r, p, admitted, origin);
}

/**
 * `markTick` is the last tick whose capture carries a discontinuity marked here: the current one
 * inside a step, the next one between ticks, whose capture has already been taken.
 *
 * The actors, gates and item bodies are synchronized in the core (`rust/core/src/boundary.rs`, #1234); the
 * pending queues, which this runtime owns, are filtered here, and the hooks reconciled, as before.
 */
export function synchronize(s: Game, r: PhysicsRuntime, markTick: number, deferItemAdmission = false): void {
  if (synchronizeBodies(s, r, markTick, !deferItemAdmission)) {
    start('sim.itemSync'); synchronizeItems(s, r, markTick); stop('sim.itemSync');
  }
  r.pendingImpulses = r.pendingImpulses.filter(entry => r.world.getGeneration(entry.id) === entry.generation);
  r.pendingAttachments = r.pendingAttachments.filter(entry => r.world.getGeneration(entry.a) === entry.generationA
    && r.world.getGeneration(entry.b) === entry.generationB);
  reconcileHooks(s);
}

/** Match seat/teleport boundaries reconcile game IDs before the first recorded frame. */
export function synchronizePhysics(s: Game): void { physicsRuntime(s)?.synchronize(); }
