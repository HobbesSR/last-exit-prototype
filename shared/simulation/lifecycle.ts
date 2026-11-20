import { syncWeapon } from '../equipment.ts';
import { event, participant, effect, dropInventorySlot } from './loot.ts';
import { dropReserves } from './ammo.ts';
import type { Game, Player } from '../types.ts';

export function eliminate(s: Game, target: Player, source: Player | null): void {
  target.status = 'eliminated'; event(s, { kind: 'eliminated', target: participant(s, target), ...(source ? { source: participant(s, source) } : {}) });
  target.charging = null;
  if (target.role === 'gladiator') { target.status = 'respawning'; target.respawnAt = s.tick + s.content.gladiatorRespawnTicks; target.input = {}; }
  // A mandatory drop refuses only an entry no ground record can represent; that one is cleared
  // below rather than halting the room's tick (14).
  for (let slot = 0; slot < (target.inventory?.length ?? 0); slot++) dropInventorySlot(s, target, slot, true);
  dropReserves(s, target);
  if (target.inventory) { target.inventory.fill(null); syncWeapon(target, s.content.weapons); }
  if (source?.role === 'gladiator') {
    source.kills++; source.level = Math.min(4, 1 + source.kills); source.maxHp += 20; source.hp = Math.min(source.maxHp, source.hp + 45); source.cooldown = 0; effect(s, source, 'upgrade', 90);
  }
  else if (source?.role === 'contestant') source.kills++;
}
// Respawn runs in the core's phase 1 (`rust/core/src/phase_one.rs`, adapter `phase-one.ts`).
export function finishMatch(s: Game): void {
  if (s.slots === 0 || !s.players.some(p => p.role === 'contestant' && p.status === 'active') || s.tick >= s.content.durationTicks) {
    s.phase = 'finished'; for (const p of s.players) if (p.role === 'contestant' && p.status === 'active') p.status = 'stranded'; event(s, { kind: 'match_finished' });
  }
}
