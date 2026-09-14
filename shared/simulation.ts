// Public compatibility surface and authoritative fixed-tick coordinator.
// Player iteration and phase ordering are gameplay: bot decisions may act before movement.
export { generateMap } from './map.ts';
export { TILE } from './movement.ts';
export { VERSION, HZ, DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS, KITS } from './simulation/rules.ts';
export { createGame, joinGame, setInput } from './simulation/state.ts';
export { POTENTIAL, couldSee, visibleTo, playerView, snapshot } from './simulation/visibility.ts';
import { movePlayer } from './movement.ts';
import { start, stop } from './profiler.ts';
import { equipped, syncWeapon, rearrangeEquipment } from './equipment.ts';
import { stepTraps } from './traps.ts';
import { HAZARD_GRACE_TICKS, DURATION } from './simulation/rules.ts';
import { distance } from './simulation/geometry.ts';
import { effect, dropEquipment, automaticPickups } from './simulation/loot.ts';
import { respawn, finishMatch } from './simulation/lifecycle.ts';
import { damage, skill, attack, advanceProjectiles } from './simulation/combat.ts';
import { interact, advanceCharging } from './simulation/interactions.ts';
import { botInput } from './simulation/bots.ts';
import { consumeInput } from './simulation/input.ts';
import { recordRewind } from './simulation/rewind.ts';
import type { Game } from './types.ts';

/** Per-player countdown fields, all measured in ticks. */
const TIMERS = ['cooldown', 'attackCd', 'railCd', 'cloak', 'revealed', 'boost', 'stun'] as const;

export function step(s: Game): void {
  if (s.phase !== 'live') return;
  start('sim.step');
  s.tick++;
  s.hazardX = Math.round(-80 + Math.max(0, s.tick - HAZARD_GRACE_TICKS) / (DURATION - HAZARD_GRACE_TICKS) * (s.map.width + 100));
  s.effects = s.effects.filter(e => --e.life > 0);
  for (const p of s.players) {
    p.movedThisTick = 0;
    respawn(s, p);
    if (p.status !== 'active') continue;
    for (const key of TIMERS) p[key] = Math.max(0, p[key] - 1);
    if (p.bot) start('sim.bots');
    const input = p.bot ? botInput(s, p) : consumeInput(p, s.tick);
    if (p.bot) stop('sim.bots');
    start('sim.move');
    const previousPosition = { x: p.x, y: p.y };
    p.heading = input.aim || 0; movePlayer(s.map, p, input); p.movedThisTick = distance(p, previousPosition);
    stop('sim.move');
    start('sim.actions');
    if (p.inventory && input.slot !== undefined) { p.selectedSlot = input.slot; syncWeapon(p); }
    if (input.moveSlot) rearrangeEquipment(p, input.moveSlot.from, input.moveSlot.to);
    if (input.drop && equipped(p)) { dropEquipment(s, p, equipped(p)!); p.inventory![p.selectedSlot!] = null; p.charging = null; syncWeapon(p); }
    if (input.skill) skill(s, p);
    if (input.attack) attack(s, p);
    if (input.interact) interact(s, p);
    advanceCharging(s, p, input);
    stop('sim.actions');
    start('sim.pickups');
    automaticPickups(s, p, input);
    stop('sim.pickups');
    if (p.status !== 'active') continue;
    if (p.x < s.hazardX && s.tick % 5 === 0) damage(s, p, 9, null);
    if (s.tick % 12 === 0 && s.map.hazards.some(h => p.x > h.x && p.x < h.x + h.w && p.y > h.y && p.y < h.y + h.h)) damage(s, p, 5, null);
  }
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
