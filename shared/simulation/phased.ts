import { createGame } from './state.ts';
import { canOccupy, reachClear, movementSpeed, gateShape } from '../movement.ts';
import { actorRadius, actorMotor, validateActorPhysics, PHYSICS_CHARACTER_VERSION } from './actor-physics.ts';
import { HZ } from './rules.ts';
import { syncWeapon, rearrangeEquipment } from '../equipment.ts';
import { collectBotIntent } from './bots.ts';
import type { BotIntent } from './bots.ts';
import { consumeInput } from './input.ts';
import { respawn, finishMatch } from './lifecycle.ts';
import { damage, skill, attack } from './combat.ts';
import { solvePhysicsProjectiles } from './physics-projectiles.ts';
import { interact, advanceCharging } from './interactions.ts';
import { automaticPickups, dropInventorySlot, effect } from './loot.ts';
import { stepTraps } from '../traps.ts';
import { advanceTick, advanceTimers, applyEnvironment, advanceDiscovery } from './tick-rules.ts';
import { recordRewind } from './rewind.ts';
import { buildPhysicsGeometry, physicsGate } from './physics-geometry.ts';
import { attachPhysics, physicsRuntime, markPhysicsDiscontinuity, PHYSICS_VERSION } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, GameMap, MatchContent, Player, Vec2 } from '../types.ts';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const actorId = (p: Player) => `actor:${p.id}`;
const ordered = (s: Game) => [...s.players].sort((a, b) => compare(a.id, b.id));
/** Games inside stepPhysics; a synchronize anywhere else is between ticks. */
const stepping = new WeakSet<Game>();

/** Explicit opt-in. Legacy createGame stays synchronous and never initializes WASM. */
export async function createPhysicsGame(seed = 4217, map?: GameMap, content?: MatchContent): Promise<Game> {
  if (content?.itemInstances) throw new RangeError('physical item integration requires P5; use createGame for L0');
  const s = createGame(seed, map, content);
  validateActorPhysics(s.content.actorPhysics, s.map);
  // P2 tuning is match-pinned, including caller-supplied profiles and floor regions.
  if (s.content.actorPhysics) {
    const profile = structuredClone(s.content.actorPhysics);
    Object.values(profile.geometry).forEach(Object.freeze); Object.freeze(profile.geometry); Object.freeze(profile);
    s.content = Object.freeze({ ...s.content, actorPhysics: profile });
    if (s.map.motorSurfaces) {
      s.map.motorSurfaces = structuredClone(s.map.motorSurfaces);
      s.map.motorSurfaces.forEach(Object.freeze); Object.freeze(s.map.motorSurfaces);
    }
    Object.defineProperty(s.map, 'motorSurfaces', { writable: false, configurable: false });
  }
  if (s.players.length > 27) throw new RangeError('physics actor capacity is 27');
  const { createPhysicsWorld } = await import('../physics/world.ts');
  const world = await createPhysicsWorld();
  const runtime: PhysicsRuntime = { world, actors: new Set(), gates: new Map(), discontinuities: [], synchronize: () => synchronize(s, runtime, stepping.has(s) ? s.tick : s.tick + 1),
    placement: (p, destination) => placement(s, runtime, p, ordered(s).filter(q => q !== p && q.status === 'active'), destination),
    pendingSpawns: [], pendingImpulses: [], pendingAttachments: [] };
  try {
    const geometry = buildPhysicsGeometry(s.map).sort((a, b) => compare(a.id, b.id));
    for (let i = 0; i < geometry.length; i++) {
      world.queueAddBody(geometry[i]!);
      if (i % 512 === 511) world.commitMutations();
    }
    world.commitMutations();
    // Static authoring is pinned until P8 introduces a shared geometry-revision transaction.
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
    attachPhysics(s, runtime);
    Object.defineProperty(s, 'version', { value: s.content.actorPhysics ? PHYSICS_CHARACTER_VERSION : PHYSICS_VERSION, enumerable: true, writable: false });
    synchronize(s, runtime, s.tick + 1);
    return s;
  } catch (error) { world.dispose(); throw error; }
}

/** Bounded placement is explicit; failing admission never spawns an overlapping body. */
function placement(s: Game, r: PhysicsRuntime, p: Player, admitted: Player[], origin: Vec2 = p): Vec2 | null {
  const radius = actorRadius(s, p);
  const free = (x: number, y: number) => canOccupy(s.map, x, y, radius)
    && admitted.every(q => Math.hypot(x - q.x, y - q.y) >= radius + actorRadius(s, q))
    && (!s.content.actorPhysics || !r.world.overlapsProp(x, y, radius));
  if (free(origin.x, origin.y)) return { x: origin.x, y: origin.y };
  for (let ring = 1; ring <= 24; ring++) {
    for (let i = 0; i < 32; i++) {
      const angle = i * Math.PI / 16, x = origin.x + Math.cos(angle) * ring * 4, y = origin.y + Math.sin(angle) * ring * 4;
      if (free(x, y)) return { x, y };
    }
  }
  return null;
}

/**
 * `markTick` is the last tick whose capture carries a discontinuity marked here: the current one
 * inside a step, the next one between ticks, whose capture has already been taken.
 */
function synchronize(s: Game, r: PhysicsRuntime, markTick: number): void {
  const active = ordered(s).filter(p => p.status === 'active');
  const wanted = new Set(active.map(actorId));
  for (const id of [...r.actors].sort(compare)) if (!wanted.has(id)) {
    if (s.content.actorPhysics) markPhysicsDiscontinuity(r, { id, generation: r.world.getGeneration(id)!, kind: 'removed', tick: markTick });
    r.world.queueRemoveBody(id); r.actors.delete(id);
  }
  r.world.commitMutations();
  const admitted: Player[] = [];
  for (const p of active) {
    const id = actorId(p), current = r.world.getTransform(id);
    if (current && Math.hypot(current.x - p.x, current.y - p.y) < 1e-6) { admitted.push(p); continue; }
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
      ...(s.content.actorPhysics ? { maxSpeed: s.content.actorPhysics.maxSpeed } : {}) }); r.actors.add(id); r.world.commitMutations(); }
    if (s.content.actorPhysics) markPhysicsDiscontinuity(r, { id, generation: r.world.getGeneration(id)!, kind: 'placed', tick: markTick });
    admitted.push(p);
  }
  for (const gate of [...s.map.gates].sort((a, b) => compare(a.id, b.id))) {
    if (r.gates.get(gate.id) === gate.open) continue;
    if (s.content.actorPhysics && !gate.open && r.world.overlapsDynamicBox(gateShape(gate))) {
      // Closing is refused while any active actor or solid prop occupies the footprint; nothing
      // retries it, so the gate stays open until someone closes it again.
      gate.open = true;
      r.gates.set(gate.id, true);
      continue;
    }
    if (r.gates.has(gate.id) && !r.gates.get(gate.id)) r.world.queueRemoveBody(`gate:${gate.id}`);
    if (!gate.open) r.world.queueAddBody(physicsGate(gate));
    r.gates.set(gate.id, gate.open);
    r.world.commitMutations();
  }
}

/** Match seat/teleport boundaries reconcile game IDs before the first recorded frame. */
export function synchronizePhysics(s: Game): void { physicsRuntime(s)?.synchronize(); }

/** The separately versioned seven-phase coordinator; never calls legacy movePlayer. */
export function stepPhysics(s: Game): void {
  const r = physicsRuntime(s);
  if (!r) throw new Error('physics world missing or disposed');
  if (s.phase !== 'live') return;
  stepping.add(s);
  try { advancePhysics(s, r); } finally { stepping.delete(s); }
}

function advancePhysics(s: Game, r: PhysicsRuntime): void {
  // 1: all timers and previous-boundary lifecycle, before anyone decides.
  advanceTick(s);
  // Each marker reaches exactly one stepped capture: its own tick's, or the next after a between-tick change.
  r.discontinuities = r.discontinuities.filter(entry => entry.tick >= s.tick);
  for (const p of s.players) {
    p.movedThisTick = 0; respawn(s, p);
    if (p.status === 'active') advanceTimers(p);
  }
  synchronize(s, r, s.tick);
  s.projectiles.push(...r.pendingSpawns.splice(0));
  for (const impulse of r.pendingImpulses.splice(0)) if (r.actors.has(impulse.id) && r.world.getGeneration(impulse.id) === impulse.generation) r.world.queueImpulse(impulse.id, impulse.value);
  for (const attachment of r.pendingAttachments.splice(0).sort((a, b) => compare(a.id, b.id))) {
    const a = r.world.getTransform(attachment.a), b = r.world.getTransform(attachment.b);
    if (a && b && r.actors.has(attachment.a) && r.actors.has(attachment.b)
      && r.world.getGeneration(attachment.a) === attachment.generationA && r.world.getGeneration(attachment.b) === attachment.generationB
      && Math.hypot(a.x - b.x, a.y - b.y) <= attachment.maxDistance && reachClear(s.map, a, b)) r.world.queueAddConstraint(attachment);
  }
  r.world.commitMutations();
  // 2: roster-order collection from the same pre-movement world.
  const intents = new Map<Player, BotIntent>();
  for (const p of s.players) if (p.status === 'active') intents.set(p, p.bot ? collectBotIntent(s, p) : { input: consumeInput(p, s.tick) });
  // 3: inventory then utilities/projectile admission, without damage callbacks during solve.
  for (const p of ordered(s)) {
    const intent = intents.get(p); if (!intent) continue;
    const input = intent.input;
    p.heading = input.aim || 0;
    if (p.inventory && input.slot !== undefined) { p.selectedSlot = input.slot; syncWeapon(p, s.content.weapons); }
    if (input.moveSlot) rearrangeEquipment(p, input.moveSlot.from, input.moveSlot.to, s.content.weapons);
    if (intent.utilitySlot !== undefined && p.selectedSlot === intent.utilitySlot) attack(s, p);
    const discard = intent.discardSlot ?? (input.drop ? p.selectedSlot : undefined);
    if (discard !== undefined) dropInventorySlot(s, p, discard);
    if (input.skill && p.kit !== 'warden') skill(s, p);
    if (input.attack && p.role === 'contestant') attack(s, p);
    const speed = movementSpeed(p, input, HZ);
    r.world.setMotor(actorId(p), actorMotor(s, p, input.x ?? 0, input.y ?? 0, speed));
  }
  // 4: all bodies together. Query projectiles use these actual substep paths.
  const result = r.world.step();
  for (const p of s.players) if (p.status === 'active') {
    const at = r.world.getTransform(actorId(p));
    if (at) { p.x = at.x; p.y = at.y; p.movedThisTick = result.distance[actorId(p)] ?? 0; }
  }
  // Events are facts only; gameplay has no contact damage profile in P1.
  r.world.drainContacts();
  // 5: physical TOI first, then finalized-pose abilities/melee by stable caster ID.
  solvePhysicsProjectiles(s, result.paths);
  for (const p of ordered(s)) {
    const input = intents.get(p)?.input;
    if (p.status !== 'active' || !input) continue;
    if (input.skill && p.kit === 'warden') skill(s, p);
    if (input.attack && p.role === 'gladiator') attack(s, p);
  }
  // 6: interactions/pickups, environment, traps; trap spawns wait for next tick.
  for (const p of ordered(s)) {
    const input = intents.get(p)?.input;
    if (p.status !== 'active' || !input) continue;
    if (input.interact) interact(s, p);
    if (p.status !== 'active') continue;
    // Ignore contact recovery jitter within the reviewed resting-contact tolerance.
    advanceCharging(s, p, (p.movedThisTick ?? 0) > 0.05 ? { x: 1 } : {});
    automaticPickups(s, p, input);
  }
  for (const p of ordered(s)) if (p.status === 'active') {
    applyEnvironment(s, p);
  }
  const admittedProjectiles = s.projectiles.length;
  stepTraps(s, damage, effect);
  r.pendingSpawns.push(...s.projectiles.splice(admittedProjectiles));
  if (r.pendingSpawns.length > 128) throw new RangeError('pending projectile capacity');
  // 7: next-boundary body state, discovery, terminal result, rewind and capture readiness.
  synchronize(s, r, s.tick);
  advanceDiscovery(s);
  finishMatch(s); synchronize(s, r, s.tick); recordRewind(s);
}
