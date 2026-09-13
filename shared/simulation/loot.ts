import { canOccupy, reachClear } from '../movement.ts';
import { carriedCell, collectEquipment } from '../equipment.ts';
import { HZ } from './rules.ts';
import { distance } from './geometry.ts';
import type { EffectKind, Game, GroundItem, InventoryItem, ItemId, Player, PlayerInput, Vec2, World } from '../types.ts';

export function event(s: Game, text: string): void { s.events.push({ id: s.serial++, tick: s.tick, text }); s.events = s.events.slice(-6); }
export function effect(s: Game, p: Vec2, kind: EffectKind, radius: World = 60): void { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
export function dropEquipment(s: Game, p: Player, item: InventoryItem): void {
  // Stacks drop one entry per unit; weapons and cells are single items.
  const copies = item.kind === 'med' || item.kind === 'shield' ? item.count || 1 : 1;
  for (let i = 0; i < copies; i++) {
    let point: Vec2 = p;
    for (let j = 0; j < 180; j++) {
      const angle = (s.serial + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
      const candidate = { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius };
      if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, p, candidate) && s.map.items.every(other => distance(other, candidate) > 32)) { point = candidate; break; }
    }
    const dropped: GroundItem = { ...item, count: 1, id: `equipment-drop-${s.serial++}` as ItemId, x: point.x, y: point.y, droppedBy: p.id, pickupAfter: s.tick + HZ };
    s.map.items.push(dropped);
  }
}
export function automaticPickups(s: Game, p: Player, input: PlayerInput): void {
  if (p.role === 'contestant') {
    s.map.items = s.map.items.filter(item => {
      if (distance(p, item) > 38 || !reachClear(s.map, p, item) || item.droppedBy === p.id && item.pickupAfter! > s.tick || p.bot && item.kind === 'cell' && carriedCell(p)) return true;
      if (item.kind === 'access') p.keys++;
      if (['weapon', 'med', 'shield', 'cell'].includes(item.kind) && !collectEquipment(p, item)) return true;
      if (item.kind === 'cell') p.path = [];
      effect(s, p, 'loot', 30); return false;
    });
    if (!input.sneak && !p.cloak && s.map.sensors.some(sensor => distance(p, sensor) < 180)) p.revealed = 65;
  }
}
