// Public compatibility surface and authoritative fixed-tick coordinator.
// Player iteration and phase ordering are gameplay: bot decisions may act before movement.
export { generateMap } from './map.ts';
export { TILE } from './movement.ts';
export { VERSION, HZ, DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS, KITS } from './simulation/rules.ts';
export { createGame, joinGame, setInput } from './simulation/state.ts';
export { POTENTIAL, couldSee, visibleTo, playerView, snapshot } from './simulation/visibility.ts';
import { movePlayer } from './movement.ts';
import { start, stop } from './profiler.ts';
import { equipped, syncWeapon, rearrangeEquipment, rearrangeInstanceEquipment } from './equipment.ts';
import { ensureItemIdentity } from './item-instances.ts';
import { stepTraps } from './traps.ts';
import { distance } from './simulation/geometry.ts';
import { effect, dropInventorySlot, automaticPickups } from './simulation/loot.ts';
import { respawn, finishMatch } from './simulation/lifecycle.ts';
import { damage, skill, attack, advanceProjectiles } from './simulation/combat.ts';
import { interact, advanceCharging } from './simulation/interactions.ts';
import { botInput } from './simulation/bots.ts';
import { consumeInput } from './simulation/input.ts';
import { recordRewind } from './simulation/rewind.ts';
import { advanceTick, advanceTimers, applyEnvironment, advanceDiscovery } from './simulation/tick-rules.ts';
import type { Game } from './types.ts';
import { PHYSICS_VERSION } from './simulation/physics-runtime.ts';
import { PHYSICS_CHARACTER_VERSION } from './simulation/actor-physics.ts';
import { stepPhysics } from './simulation/phased.ts';
export { createPhysicsGame, synchronizePhysics } from './simulation/phased.ts';
export { disposePhysics, enqueuePhysicsImpulse, enqueuePhysicsAttachment, PHYSICS_VERSION } from './simulation/physics-runtime.ts';

export function step(s: Game): void {
  if (s.version === PHYSICS_VERSION || s.version === PHYSICS_CHARACTER_VERSION) return stepPhysics(s);
  if (s.phase !== 'live') return;
  start('sim.step');
  advanceTick(s);
  const players = s.content.itemInstances ? [...s.players].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : s.players;
  if (s.content.itemInstances) for (const p of players) for (const item of p.inventory ?? []) if (item) ensureItemIdentity(s, item);
  for (const p of players) {
    p.movedThisTick = 0;
    respawn(s, p);
    if (p.status !== 'active') continue;
    advanceTimers(p);
    if (p.bot) start('sim.bots');
    const input = p.bot ? botInput(s, p) : consumeInput(p, s.tick);
    if (p.bot) stop('sim.bots');
    start('sim.move');
    const previousPosition = { x: p.x, y: p.y };
    p.heading = input.aim || 0; movePlayer(s.map, p, input); p.movedThisTick = distance(p, previousPosition);
    stop('sim.move');
    start('sim.actions');
    if (p.inventory && input.slot !== undefined) { p.selectedSlot = input.slot; syncWeapon(p, s.content.weapons); }
    if (input.moveSlot) {
      if (s.content.itemInstances) rearrangeInstanceEquipment(s, p, input.moveSlot.from, input.moveSlot.to);
      else rearrangeEquipment(p, input.moveSlot.from, input.moveSlot.to, s.content.weapons);
    }
    if (input.drop && equipped(p)) dropInventorySlot(s, p, p.selectedSlot!);
    if (input.skill) skill(s, p);
    if (input.attack) attack(s, p);
    if (input.interact) interact(s, p);
    advanceCharging(s, p, input);
    stop('sim.actions');
    start('sim.pickups');
    automaticPickups(s, p, input);
    stop('sim.pickups');
    if (p.status !== 'active') continue;
    applyEnvironment(s, p);
  }
  advanceDiscovery(s);
  stepTraps(s, damage, effect);
  start('sim.projectiles');
  advanceProjectiles(s);
  stop('sim.projectiles');
  finishMatch(s);
  // After every position this tick is final, because that is what the broadcast carries and so what
  // a client will have drawn by the time it aims at any of it.
  recordRewind(s);
  stop('sim.step');
}
