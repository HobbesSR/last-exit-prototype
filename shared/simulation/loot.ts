import { canOccupy, reachClear } from '../movement.ts';
import { carriedCell, collectEquipment, collectInstanceEquipment, syncWeapon } from '../equipment.ts';
import { allocateItemId, ensureItemIdentity, validateItemPayload } from '../item-instances.ts';
import { HZ } from './rules.ts';
import { clearRoute, distance } from './geometry.ts';
import type { EffectKind, Game, GroundItem, InventoryItem, ItemId, Player, PlayerInput, Vec2, World } from '../types.ts';

export function event(s: Game, text: string): void { s.events.push({ id: s.serial++, tick: s.tick, text }); s.events = s.events.slice(-6); }
export function effect(s: Game, p: Vec2, kind: EffectKind, radius: World = 60): void { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
/** Legacy emission only; L0 atomically removes its carried owner. Prefer dropInventorySlot. */
export function dropEquipment(s: Game, p: Player, item: InventoryItem, mandatory = false): boolean {
  if (s.content.itemInstances) return dropInstance(s, p, item, mandatory);
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
  return true;
}

/** Validate and stage every record before committing any inventory/world transfer. */
function dropInstance(s: Game, p: Player, item: InventoryItem, mandatory: boolean): boolean {
  if (!p.inventory?.includes(item) || !['weapon', 'med', 'shield', 'cell'].includes(item.kind)
    || ![p.x, p.y].every(Number.isFinite) || !validateItemPayload(item, s)) return false;
  const copies = item.kind === 'med' || item.kind === 'shield' ? item.count : 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 3
    || item.kind === 'weapon' && (!Number.isSafeInteger(item.ammo) || item.ammo < 0)
    || item.kind === 'cell' && (!Number.isSafeInteger(item.charge) || item.charge < 0)) return false;
  if (!mandatory && s.map.items.length + copies > s.content.itemInstances!.groundCapacity) return false;
  const points: Vec2[] = [];
  for (let i = 0; i < copies; i++) {
    let point: Vec2 | undefined;
    for (let j = 0; j < 180; j++) {
      const angle = ((s.itemSerial ?? 0) + i + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
      const candidate = { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius };
      if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, p, candidate)
        && s.map.items.every(other => distance(other, candidate) > 32)
        && points.every(other => distance(other, candidate) > 32)) { point = candidate; break; }
    }
    if (!point && !mandatory) return false;
    // Mandatory overflow is logical loot, not a promise that P5 can allocate a body here.
    points.push(point ?? { x: p.x, y: p.y });
  }
  if (item.instanceId && (s.map.items.some(other => other.id === item.instanceId)
    || s.players.some(player => player.inventory?.some(other => other && other !== item && other.instanceId === item.instanceId)))) return false;
  // Allocation is staged too: an exhausted counter cannot partly split a carried stack.
  const allocation = { ...s }, identity = { ...item };
  let records: GroundItem[];
  try {
    ensureItemIdentity(allocation, identity);
    records = points.map((point, i): GroundItem => ({
      kind: item.kind, id: i ? allocateItemId(allocation) : identity.instanceId!, lineageId: identity.lineageId,
      ...(item.quality !== undefined ? { quality: item.quality } : {}),
      ...(item.kind === 'weapon' ? { weaponType: item.weaponType, ammo: item.ammo }
        : item.kind === 'cell' ? { charge: item.charge } : { count: 1 }),
      ...point, droppedBy: p.id, pickupAfter: s.tick + HZ,
    }));
  } catch { return false; }
  s.itemSerial = allocation.itemSerial;
  s.map.items.push(...records);
  p.inventory[p.inventory.indexOf(item)] = null; p.charging = null; syncWeapon(p, s.content.weapons);
  return true;
}

/** The inventory owner commits the removal only after its entire drop has been represented. */
export function dropInventorySlot(s: Game, p: Player, slot: number, mandatory = false): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= (p.inventory?.length ?? 0)) return false;
  const item = p.inventory![slot];
  if (!item || !dropEquipment(s, p, item, mandatory)) return false;
  p.inventory![slot] = null; p.charging = null; syncWeapon(p, s.content.weapons);
  return true;
}
export function automaticPickups(s: Game, p: Player, input: PlayerInput): void {
  if (p.role === 'contestant') {
    const keep = (item: GroundItem): boolean => {
      if (distance(p, item) > 38 || !reachClear(s.map, p, item) || item.droppedBy === p.id && item.pickupAfter! > s.tick || p.bot && item.kind === 'cell' && carriedCell(p)) return true;
      if (item.kind === 'access') p.keys++;
      if (['weapon', 'med', 'shield', 'cell'].includes(item.kind)
        && !(s.content.itemInstances ? collectInstanceEquipment(s, p, item) : collectEquipment(p, item, s.content.weapons))) return true;
      if (item.kind === 'cell') clearRoute(p);
      effect(s, p, 'loot', 30); return false;
    };
    if (s.content.itemInstances) {
      // Commit each consumed instance before the next pickup inspects ownership or allocates IDs.
      for (let i = 0; i < s.map.items.length;) {
        if (keep(s.map.items[i]!)) i++;
        else s.map.items.splice(i, 1);
      }
    } else s.map.items = s.map.items.filter(keep);
    if (!input.sneak && !p.cloak && s.map.sensors.some(sensor => distance(p, sensor) < 180)) p.revealed = 65;
  }
}
