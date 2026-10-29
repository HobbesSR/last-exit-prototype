import { canOccupy, reachClear } from '../movement.ts';
import { carriedCell, collectAmmo, collectEquipment, collectInstanceEquipment, syncWeapon } from '../equipment.ts';
import { allocateItemId, ensureItemIdentity, validateItemPayload } from '../item-instances.ts';
import { canRepresentPhysicalDrop, launchPhysicalDrops, physicalDropPlacementClear } from './world-physics.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { draftItem, groundList, replaceItem, settledItem } from './ground-items.ts';
import { HZ } from './rules.ts';
import { clearRoute, distance } from './geometry.ts';
import type { AmmoFamily, EffectKind, Game, GroundItem, InventoryItem, ItemId, Player, PlayerInput, Vec2, World } from '../types.ts';
import { cos, sin } from '../math.ts';

export function event(s: Game, text: string): void { s.events.push({ id: s.serial++, tick: s.tick, text }); s.events = s.events.slice(-6); }
export function effect(s: Game, p: Vec2, kind: EffectKind, radius: World = 60): void { s.effects.push({ id: s.serial++, x: p.x, y: p.y, kind, radius, life: 12 }); }
/** Legacy emission only: L0 drops go through dropInventorySlot, which may refuse. */
export function dropEquipment(s: Game, p: Player, item: InventoryItem): void {
  // Stacks drop one entry per unit; weapons and cells are single items.
  const copies = item.kind === 'med' || item.kind === 'shield' ? item.count || 1 : 1;
  for (let i = 0; i < copies; i++) {
    let point: Vec2 = p;
    for (let j = 0; j < 180; j++) {
      const angle = (s.serial + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
      const candidate = { x: p.x + cos(angle) * radius, y: p.y + sin(angle) * radius };
      if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, p, candidate) && s.map.items.every(other => distance(other, candidate) > 32)) { point = candidate; break; }
    }
    const dropped: GroundItem = { ...item, count: 1, id: `equipment-drop-${s.serial++}` as ItemId, x: point.x, y: point.y, droppedBy: p.id, pickupAfter: s.tick + HZ };
    groundList(s).push(dropped);
  }
}

/** The bounded L0 spiral search: a free, reachable point near `origin`, clear of both lists. */
export function scatterPoint(s: Game, origin: Vec2, phase: number, items: readonly Vec2[], points: readonly Vec2[] = []): Vec2 | undefined {
  const runtime = s.content.dynamicNavigation ? physicsRuntime(s) : undefined;
  for (let j = 0; j < 180; j++) {
    const angle = (phase + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
    const candidate = { x: origin.x + cos(angle) * radius, y: origin.y + sin(angle) * radius };
    if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, origin, candidate)
      && items.every(other => distance(other, candidate) > 32)
      && points.every(other => distance(other, candidate) > 32)
      && (!runtime || physicalDropPlacementClear(s, runtime, candidate.x, candidate.y))) return candidate;
  }
  return undefined;
}

/** An L0 drop, fully represented but not yet committed. */
export interface DropPlan { records: GroundItem[]; itemSerial: number }

/**
 * Validate, place and identify every ground record of one carried L0 item without changing the
 * match. `items` stands in for the ground list, so a swap can plan around the pickup it removes.
 */
export function planDrop(s: Game, p: Player, item: InventoryItem, mandatory = false, items: readonly GroundItem[] = s.map.items,
  stagedSerial = s.itemSerial ?? 0): DropPlan | null {
  if (!['weapon', 'med', 'shield', 'cell'].includes(item.kind) || ![p.x, p.y].every(Number.isFinite) || !validateItemPayload(item, s)) return null;
  const copies = item.kind === 'med' || item.kind === 'shield' ? item.count : 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 3
    || item.kind === 'weapon' && (!Number.isSafeInteger(item.ammo) || item.ammo < 0)
    || item.kind === 'cell' && (!Number.isSafeInteger(item.charge) || item.charge < 0)) return null;
  if (!mandatory && items.length + copies > s.content.itemInstances!.groundCapacity) return null;
  const points: Vec2[] = [];
  for (let i = 0; i < copies; i++) {
    const point = scatterPoint(s, p, stagedSerial + i, items, points);
    if (!point && !mandatory) return null;
    // Mandatory overflow is logical loot, not a promise that P5 can allocate a body here.
    points.push(point ?? { x: p.x, y: p.y });
  }
  if (item.instanceId && (items.some(other => other.id === item.instanceId)
    || s.players.some(player => player.inventory?.some(other => other && other !== item && other.instanceId === item.instanceId)))) return null;
  // Allocation is staged too: an exhausted counter cannot partly split a carried stack.
  const allocation = { ...s, itemSerial: stagedSerial }, identity = { ...item };
  try {
    ensureItemIdentity(allocation, identity);
    const records = points.map((point, i): GroundItem => ({
      kind: item.kind, id: i ? allocateItemId(allocation) : identity.instanceId!, lineageId: identity.lineageId,
      ...(item.quality !== undefined ? { quality: item.quality } : {}),
      ...(item.kind === 'weapon' ? { weaponType: item.weaponType, ammo: item.ammo }
        : item.kind === 'cell' ? { charge: item.charge } : { count: 1 }),
      ...point, droppedBy: p.id, pickupAfter: s.tick + HZ,
    }));
    return { records, itemSerial: allocation.itemSerial! };
  } catch { return null; }
}

/**
 * One L2 ammo pickup of `count` reserve rounds, planned like `planDrop`: an optional drop refuses
 * capacity or placement failure, a mandatory one falls back to the player's position.
 */
export function planAmmoDrop(s: Game, p: Player, family: AmmoFamily, count: number, mandatory = false): DropPlan | null {
  if (!Number.isSafeInteger(count) || count < 1 || ![p.x, p.y].every(Number.isFinite)) return null;
  if (!mandatory && s.map.items.length + 1 > s.content.itemInstances!.groundCapacity) return null;
  const point = scatterPoint(s, p, s.itemSerial ?? 0, s.map.items);
  if (!point && !mandatory) return null;
  const allocation = { ...s };
  try {
    const id = allocateItemId(allocation);
    const at = point ?? { x: p.x, y: p.y };
    return { records: [{ kind: 'ammo', id, lineageId: id, family, count, x: at.x, y: at.y, droppedBy: p.id, pickupAfter: s.tick + HZ }], itemSerial: allocation.itemSerial! };
  } catch { return null; }
}

/** Drop one slot. L0 commits only a complete plan and may refuse; legacy content always drops. */
export function dropInventorySlot(s: Game, p: Player, slot: number, mandatory = false): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= (p.inventory?.length ?? 0)) return false;
  const item = p.inventory![slot];
  if (!item) return false;
  let records: GroundItem[] = [];
  if (s.content.itemInstances) {
    const plan = planDrop(s, p, item, mandatory);
    if (!plan || !mandatory && !canRepresentPhysicalDrop(s, plan.records.length)) return false;
    s.itemSerial = plan.itemSerial;
    groundList(s).push(...plan.records); records = plan.records;
  } else dropEquipment(s, p, item);
  p.inventory![slot] = null; p.charging = null; syncWeapon(p, s.content.weapons);
  if (records.length) launchPhysicalDrops(s, records, p);
  return true;
}
export function automaticPickups(s: Game, p: Player, input: PlayerInput): void {
  if (p.role === 'contestant') {
    // What stays on the ground: the item itself, its partly taken record, or null once wholly taken.
    const remains = (item: GroundItem): GroundItem | null => {
      if (distance(p, item) > 38 || !reachClear(s.map, p, item) || item.droppedBy === p.id && item.pickupAfter! > s.tick || p.bot && item.kind === 'cell' && carriedCell(p)) return item;
      const draft = draftItem(item);
      if (item.kind === 'access') p.keys++;
      if (item.kind === 'ammo' && !(s.content.reloading && collectAmmo(s, p, draft, item))) return settledItem(item, draft);
      if (['weapon', 'med', 'shield', 'cell'].includes(item.kind)
        && !(s.content.itemInstances ? collectInstanceEquipment(s, p, draft, item) : collectEquipment(p, draft, s.content.weapons))) return settledItem(item, draft);
      if (item.kind === 'cell') clearRoute(p);
      effect(s, p, 'loot', 30); return null;
    };
    if (s.content.itemInstances) {
      // Commit each consumed instance before the next pickup inspects ownership or allocates IDs.
      for (let i = 0; i < s.map.items.length;) {
        const item = s.map.items[i]!, next = remains(item);
        if (next === item) i++;
        else if (next) { replaceItem(s, item, next); i++; }
        else { groundList(s).splice(i, 1); physicsRuntime(s)?.synchronize(); }
      }
    } else {
      // A new list only when something was taken or changed, so an untouched ground stays shared.
      const items = s.map.items;
      let next: GroundItem[] | undefined;
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!, kept = remains(item);
        if (kept !== item) next ??= items.slice(0, i);
        if (next && kept) next.push(kept);
      }
      if (next) s.map.items = next;
    }
    if (!input.sneak && !p.cloak && s.map.sensors.some(sensor => distance(p, sensor) < 180)) p.revealed = 65;
  }
}
