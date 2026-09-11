import { canOccupy, reachClear } from '../movement.js';
import { carriedCell, collectEquipment } from '../equipment.js';
import { HZ } from './rules.js';
import { distance } from './geometry.js';
export function event(s, text) { s.events.push({ id: s.serial++, tick: s.tick, text }); s.events = s.events.slice(-6); }
export function effect(s, p, kind, radius = 60) { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
export function dropEquipment(s, p, item) {
  for (let i = 0; i < (item.count || 1); i++) {
    let point = p;
    for (let j = 0; j < 180; j++) {
      const angle = (s.serial + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
      const candidate = { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius };
      if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, p, candidate) && s.map.items.every(other => distance(other, candidate) > 32)) { point = candidate; break; }
    }
    s.map.items.push({ ...item, count: 1, id: `equipment-drop-${s.serial++}`, x: point.x, y: point.y, droppedBy: p.id, pickupAfter: s.tick + HZ });
  }
}
export function automaticPickups(s, p, input) {
  if (p.role === 'contestant') {
    s.map.items = s.map.items.filter(item => {
      if (distance(p, item) > 38 || !reachClear(s.map, p, item) || item.droppedBy === p.id && item.pickupAfter > s.tick || p.bot && item.kind === 'cell' && carriedCell(p)) return true;
      if (item.kind === 'access') p.keys++;
      if (['weapon', 'med', 'shield', 'cell'].includes(item.kind) && !collectEquipment(p, item)) return true;
      if (item.kind === 'cell') p.path = [];
      effect(s, p, 'loot', 30); return false;
    });
    if (!input.sneak && !p.cloak && s.map.sensors.some(sensor => distance(p, sensor) < 180)) p.revealed = 65;
  }
}
