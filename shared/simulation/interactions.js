import { lineClear, reachClear, gateShape, TILE } from '../movement.js';
import { carriedCell, equipped, collectEquipment, syncWeapon } from '../equipment.js';
import { CELL_CHARGE_TICKS } from './rules.js';
import { distance } from './geometry.js';
import { event, effect, dropEquipment } from './loot.js';
export function interact(s, p) {
  const cell = carriedCell(p);
  const charged = p.inventory?.find(item => item?.kind === 'cell' && item.charge >= CELL_CHARGE_TICKS);
  if (p.role === 'contestant' && distance(p, s.map.exit) < 65 && s.slots > 0 && charged && lineClear(s.map, p, s.map.exit)) {
    s.slots--; p.inventory[p.inventory.indexOf(charged)] = null; syncWeapon(p); p.charging = null; p.status = 'escaped';
    event(s, p.name + ' powered an escape pod. ' + s.slots + ' slots remain'); return;
  }
  if (cell && cell.charge < CELL_CHARGE_TICKS) {
    const station = s.map.chargers.find(st => distance(p, st) < 70 && lineClear(s.map, p, st));
    if (station) { p.charging = station.id; return; }
  }
  const pickup = p.inventory && s.map.items.filter(i => ['weapon', 'med', 'shield', 'cell'].includes(i.kind) && distance(p, i) < 45 && reachClear(s.map, p, i)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  if (!p.bot && pickup && p.inventory.every(Boolean)) {
    const index = p.selectedSlot, old = equipped(p); p.inventory[index] = null;
    if (collectEquipment(p, pickup)) { s.map.items = s.map.items.filter(i => i.id !== pickup.id); dropEquipment(s, p, old); }
    else p.inventory[index] = old;
    syncWeapon(p); return;
  }
  const gate = s.map.gates.filter(g => distance(p, g) < 85 && (!p.bot || !g.open) && lineClear(s.map, p, g, g.id)).sort((a, b) => distance(p, a) - distance(p, b))[0];
  if (gate) {
    const locked = gate.locked ?? gate.kind !== 'door';
    if (!gate.open && (!locked || p.keys > 0)) {
      gate.open = true; if (locked) { p.keys--; gate.locked = false; } p.path = [];
    } else if (gate.open && gate.kind === 'door' && !p.bot) {
      const box = gateShape(gate);
      const occupied = s.players.some(other => other.status === 'active' && Math.hypot(other.x - Math.max(box.x, Math.min(box.x + box.w, other.x)), other.y - Math.max(box.y, Math.min(box.y + box.h, other.y))) < (other.role === 'gladiator' ? 23 : 12));
      if (!occupied) { gate.open = false; p.path = []; }
    }
    return;
  }
  if (p.role === 'gladiator' && p.railCd === 0) {
    const station = s.map.stations.find(st => distance(p, st) < 70);
    if (station) {
      const candidates = s.map.stations.filter(st => st.x > s.hazardX + TILE && st.id !== station.id);
      const next = candidates.find(st => st.x > p.x + TILE) || candidates[0];
      if (next) { effect(s, p, 'rail', 60); p.x = next.x; p.y = next.y; p.path = []; p.railCd = 180; effect(s, p, 'rail', 60); }
    }
  }
}
export function advanceCharging(s, p, input) {
  if (p.charging) {
    const cell = carriedCell(p);
    const station = s.map.chargers.find(st => st.id === p.charging);
    if (!cell || cell.charge >= CELL_CHARGE_TICKS || input.x || input.y || !station || distance(p, station) >= 70 || !lineClear(s.map, p, station)) p.charging = null;
    else if (++cell.charge >= CELL_CHARGE_TICKS) { p.charging = null; event(s, `${p.name} charged a power cell`); effect(s, p, 'charge', 70); }
  }
}
