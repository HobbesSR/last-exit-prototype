import { canOccupy } from '../movement.js';
import { syncWeapon } from '../equipment.js';
import { GLADIATOR_RESPAWN_TICKS, DURATION } from './rules.js';
import { distance } from './geometry.js';
import { event, effect, dropEquipment } from './loot.js';
export function eliminate(s, target, source) {
  target.status = 'eliminated'; event(s, `${target.name} ${source ? 'eliminated by ' + source.name : 'lost to the arena'}`);
  target.charging = null;
  if (target.role === 'gladiator') { target.status = 'respawning'; target.respawnAt = s.tick + GLADIATOR_RESPAWN_TICKS; target.input = {}; }
  for (const item of target.inventory || []) if (item) dropEquipment(s, target, item);
  if (target.inventory) { target.inventory.fill(null); syncWeapon(target); }
  if (source?.role === 'gladiator') {
    source.kills++; source.level = Math.min(4, 1 + source.kills); source.maxHp += 20; source.hp = Math.min(source.maxHp, source.hp + 45); source.cooldown = 0; effect(s, source, 'upgrade', 90);
  }
  else if (source?.role === 'contestant') source.kills++;
}
export function respawn(s, p) {
  if (p.status === 'respawning' && s.tick >= p.respawnAt) {
    const candidates = s.map.stations.filter(st => st.x > s.hazardX + 400 && canOccupy(s.map, st.x, st.y, 25)
      && s.players.every(other => other.role !== 'contestant' || other.status !== 'active' || distance(other, st) > 1000));
    const station = candidates.sort((a, b) => a.x - b.x)[0];
    if (station) { p.x = station.x; p.y = station.y; p.hp = p.maxHp; p.shield = 0; p.status = 'active'; p.respawnAt = null; p.input = {}; p.inputTick = s.tick; p.path = []; p.cooldown = 0; p.attackCd = 0; p.stun = 0; p.boost = 0; p.railCd = 0; event(s, `${p.name} returned to the hunt`); }
  }
}
export function finishMatch(s) {
  if (s.slots === 0 || !s.players.some(p => p.role === 'contestant' && p.status === 'active') || s.tick >= DURATION) {
    s.phase = 'finished'; for (const p of s.players) if (p.role === 'contestant' && p.status === 'active') p.status = 'stranded'; event(s, 'Broadcast complete');
  }
}
