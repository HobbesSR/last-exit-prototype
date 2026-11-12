import { reachClear, movementSpeed } from '../movement.ts';
import { actorMotor } from './actor-physics.ts';
import { applyFloorDrag, writePhysicalItemPoses } from './world-physics.ts';
import { HZ } from './rules.ts';
import { syncWeapon, rearrangeInstanceEquipment } from '../equipment.ts';
import { collectBotIntent } from './bots.ts';
import { beginDynamicNavigationCollection, endDynamicNavigationCollection } from './dynamic-navigation.ts';
import type { BotIntent } from './bots.ts';
import { consumeInput } from './input.ts';
import { respawn, finishMatch } from './lifecycle.ts';
import { damage, skill, attack } from './combat.ts';
import { solvePhysicsProjectiles } from './physics-projectiles.ts';
import { prepareHooks, finishHooks } from './hook.ts';
import { interact, advanceCharging } from './interactions.ts';
import { arrive, transit } from './transit.ts';
import { automaticPickups, dropInventorySlot, effect } from './loot.ts';
import { advanceReload, dropReserve } from './ammo.ts';
import { stepTraps } from '../traps.ts';
import { advanceTick, advanceTimers, applyEnvironment, advanceDiscovery } from './tick-rules.ts';
import { recordRewind } from './rewind.ts';
import { actorId, compare, ordered, synchronize } from './game.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, Player } from '../types.ts';
import { hypot } from '../math.ts';
import { start, stop } from '../profiler.ts';

/** The seven-phase tick. Actors move only through the physics world, never `movePlayer`. */
export function stepGame(s: Game): void {
  const r = physicsRuntime(s);
  if (!r) throw new Error('physics world missing or disposed');
  if (s.phase !== 'live') return;
  r.stepping = true;
  start('sim.step');
  try { advanceGame(s, r); } finally { r.stepping = false; stop('sim.step'); }
}

// Timed by phase (sim.*; 42.22). Every synchronize call is counted in sim.sync.
function advanceGame(s: Game, r: PhysicsRuntime): void {
  // 1: all timers and previous-boundary lifecycle, before anyone decides.
  advanceTick(s);
  // Each marker reaches exactly one stepped capture: its own tick's, or the next after a between-tick change.
  r.discontinuities = r.discontinuities.filter(entry => entry.tick >= s.tick);
  for (const p of s.players) {
    p.movedThisTick = 0; respawn(s, p); arrive(s, p);
    if (p.status === 'active') advanceTimers(p);
  }
  start('sim.sync'); synchronize(s, r, s.tick); stop('sim.sync');
  prepareHooks(s);
  s.projectiles.push(...r.pendingSpawns.splice(0));
  for (const impulse of r.pendingImpulses.splice(0)) if ((r.actors.has(impulse.id) || r.world.hasBody(impulse.id)) && r.world.getGeneration(impulse.id) === impulse.generation) r.world.queueImpulse(impulse.id, impulse.value);
  for (const attachment of r.pendingAttachments.splice(0).sort((a, b) => compare(a.id, b.id))) {
    const a = r.world.getTransform(attachment.a), b = r.world.getTransform(attachment.b);
    if (a && b && r.actors.has(attachment.a) && r.actors.has(attachment.b)
      && r.world.getGeneration(attachment.a) === attachment.generationA && r.world.getGeneration(attachment.b) === attachment.generationB
      && hypot(a.x - b.x, a.y - b.y) <= attachment.maxDistance && reachClear(s.map, a, b)) r.world.queueAddConstraint(attachment);
  }
  r.world.commitMutations();
  // 2: roster-order collection from the same pre-movement world.
  const intents = new Map<Player, BotIntent>();
  start('sim.bots');
  start('sim.bots.collect'); beginDynamicNavigationCollection(s); stop('sim.bots.collect');
  try {
    for (const p of s.players) if (p.status === 'active') intents.set(p, p.bot ? collectBotIntent(s, p) : { input: consumeInput(p, s.tick) });
  } finally { endDynamicNavigationCollection(s); stop('sim.bots'); }
  // 3: inventory then utilities/projectile admission, without damage callbacks during solve.
  start('sim.actions');
  for (const p of ordered(s)) {
    const intent = intents.get(p); if (!intent) continue;
    const input = intent.input;
    p.heading = input.aim || 0;
    if (p.inventory && input.slot !== undefined) { p.selectedSlot = input.slot; syncWeapon(p, s.content.weapons); }
    if (input.moveSlot) rearrangeInstanceEquipment(s, p, input.moveSlot.from, input.moveSlot.to);
    if (intent.utilitySlot !== undefined && p.selectedSlot === intent.utilitySlot) attack(s, p);
    const discard = intent.discardSlot ?? (input.drop ? p.selectedSlot : undefined);
    if (discard !== undefined) dropInventorySlot(s, p, discard);
    if (input.dropAmmo) dropReserve(s, p, input.dropAmmo.family, input.dropAmmo.count);
    // After the tick's selection, move and drops, so each cancels a reload before it transfers; before attack, which it blocks.
    advanceReload(s, p, input);
    if (input.skill && p.kit !== 'warden') skill(s, p);
    if (input.attack && p.role === 'contestant') attack(s, p);
    const speed = movementSpeed(p, input, HZ);
    r.world.setMotor(actorId(p), actorMotor(s, p, input.x ?? 0, input.y ?? 0, speed));
  }
  stop('sim.actions');
  // 4: all bodies together. Query projectiles use these actual substep paths.
  start('sim.solve');
  applyFloorDrag(s, r);
  const result = r.world.step();
  stop('sim.solve');
  start('sim.poses');
  writePhysicalItemPoses(s, r);
  for (const p of s.players) if (p.status === 'active') {
    const at = r.world.getTransform(actorId(p));
    if (at) { p.x = at.x; p.y = at.y; p.movedThisTick = result.distance[actorId(p)] ?? 0; }
  }
  // Events are facts only; gameplay has no contact damage.
  r.world.drainContacts();
  stop('sim.poses');
  // 5: physical TOI first, then finalized-pose abilities/melee by stable caster ID.
  start('sim.projectiles');
  solvePhysicsProjectiles(s, result.paths);
  finishHooks(s, result.paths);
  for (const p of ordered(s)) {
    const input = intents.get(p)?.input;
    if (p.status !== 'active' || !input) continue;
    if (input.skill && p.kit === 'warden') skill(s, p);
    if (input.attack && p.role === 'gladiator') attack(s, p);
  }
  stop('sim.projectiles');
  // 6: interactions/pickups, environment, traps; trap spawns wait for next tick.
  start('sim.pickups');
  for (const p of ordered(s)) {
    const input = intents.get(p)?.input;
    if (p.status !== 'active' || !input) continue;
    if (input.interact) interact(s, p);
    if (input.transit && s.content.transit === 'selectable') transit(s, p, input.transit);
    if (p.status !== 'active') continue;
    // Ignore contact recovery jitter within the reviewed resting-contact tolerance.
    advanceCharging(s, p, (p.movedThisTick ?? 0) > 0.05 ? { x: 1 } : {});
    automaticPickups(s, p, input);
  }
  stop('sim.pickups');
  start('sim.environment');
  for (const p of ordered(s)) if (p.status === 'active') {
    applyEnvironment(s, p);
  }
  const admittedProjectiles = s.projectiles.length;
  stepTraps(s, damage, effect);
  r.pendingSpawns.push(...s.projectiles.splice(admittedProjectiles));
  stop('sim.environment');
  if (r.pendingSpawns.length > 128) throw new RangeError('pending projectile capacity');
  // 7: next-boundary body state, discovery, terminal result, rewind and capture readiness.
  start('sim.sync'); synchronize(s, r, s.tick); stop('sim.sync');
  advanceDiscovery(s);
  finishMatch(s);
  start('sim.sync'); synchronize(s, r, s.tick); stop('sim.sync');
  start('sim.rewind'); recordRewind(s); stop('sim.rewind');
}
