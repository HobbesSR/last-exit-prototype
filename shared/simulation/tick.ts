import { applyFloorDrag, writePhysicalItemPoses } from './world-physics.ts';
import { phaseThree } from './phase-three.ts';
import { collectBotIntent } from './bots.ts';
import { beginDynamicNavigationCollection, endDynamicNavigationCollection } from './dynamic-navigation.ts';
import type { BotIntent } from './bots.ts';
import { consumeInput } from './input.ts';
import { finishMatch } from './lifecycle.ts';
import { beginTick } from './phase-one.ts';
import { damage } from './combat.ts';
import { castersInCore, solvePhysicsProjectiles } from './phase-five.ts';
import type { Caster } from './phase-five.ts';
import { prepareHooks, finishHooks } from './hook.ts';
import { interact, advanceCharging } from './interactions.ts';
import { transit } from './transit.ts';
import { automaticPickups } from './loot.ts';
import { effect } from './event-records.ts';
import { stepTraps } from '../traps.ts';
import { applyEnvironment, advanceDiscovery } from './tick-rules.ts';
import { playerIndex } from './relations.ts';
import { recordRewind } from './rewind.ts';
import { actorId, ordered, synchronize } from './game.ts';
import { admitPending } from './boundary.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game } from '../types.ts';
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
  // 1: all timers and previous-boundary lifecycle, before anyone decides: the tick, timers, respawn and arrival
  // (phase-one.ts), then the body sync and the pending admission (boundary.ts), all in the core; the hooks here.
  beginTick(s);
  // Each marker reaches exactly one stepped capture: its own tick's, or the next after a between-tick change.
  r.discontinuities = r.discontinuities.filter(entry => entry.tick >= s.tick);
  start('sim.sync'); synchronize(s, r, s.tick); stop('sim.sync');
  prepareHooks(s);
  // Trap spawns are projectile records, which stay here; impulses and attachments are admitted in the core.
  s.projectiles.push(...r.pendingSpawns.splice(0));
  admitPending(s, r);
  r.world.commitMutations();
  // 2: roster-order collection from the same pre-movement world.
  const intents = new Array<BotIntent | undefined>(s.players.length);
  start('sim.bots');
  start('sim.bots.collect'); beginDynamicNavigationCollection(s); stop('sim.bots.collect');
  try {
    for (let idx = 0; idx < s.players.length; idx++) {
      const p = s.players[idx];
      if (p.status === 'active') intents[idx] = p.bot ? collectBotIntent(s, p) : { input: consumeInput(p, s.tick) };
    }
  } finally { endDynamicNavigationCollection(s); stop('sim.bots'); }
  // 3: inventory then utilities/projectile admission, without damage callbacks during solve.
  start('sim.actions');
  phaseThree(s, intents);
  stop('sim.actions');
  // 4: all bodies together. Query projectiles use these actual substep paths.
  start('sim.solve');
  applyFloorDrag(s, r);
  // Events are facts only; gameplay has no contact damage, so the step keeps none (its capacity still holds).
  const result = r.world.step({ discardContacts: true });
  stop('sim.solve');
  start('sim.poses');
  // Poses are the ends of the step's paths: the bodies' poses after the solve, without reading each one back.
  writePhysicalItemPoses(s, r, result.paths);
  for (const p of s.players) if (p.status === 'active') {
    const at = result.paths[actorId(p)]?.at(-1);
    if (at) { p.x = at.x; p.y = at.y; p.movedThisTick = result.distance[actorId(p)] ?? 0; }
  }
  stop('sim.poses');
  // 5: physical TOI first, then finalized-pose abilities/melee by stable caster ID.
  start('sim.projectiles');
  // All in the core (`combat.rs`, 27 step 5d.2); each caster's status is read at its turn there, as an earlier
  // caster's hit may have removed it.
  solvePhysicsProjectiles(s, result.paths);
  finishHooks(s, result.paths);
  const casters: Caster[] = [];
  for (const p of ordered(s)) {
    const input = intents[playerIndex(s, p)]?.input;
    const skill = !!input?.skill && p.kit === 'warden', attack = !!input?.attack && p.role === 'gladiator';
    if (skill || attack) casters.push({ player: p, skill, attack });
  }
  castersInCore(s, casters);
  stop('sim.projectiles');
  // 6: interactions/pickups, environment, traps; trap spawns wait for next tick.
  start('sim.pickups');
  for (const p of ordered(s)) {
    const input = intents[playerIndex(s, p)]?.input;
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
