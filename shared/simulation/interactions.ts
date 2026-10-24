import { lineClear, reachClear, gateShape, bodyRadius, TILE } from '../movement.ts';
import { carriedCell, equipped, collectEquipment, collectInstanceEquipment, syncWeapon } from '../equipment.ts';
import { nearbyGate } from '../gate-query.ts';
import { observeGate } from '../discovery.ts';
import { clearRoute, distance } from './geometry.ts';
import { CHARGE_REACH, EXTRACTION_REACH, PICKUP_REACH, TRANSIT_REACH } from './rules.ts';
import { event, effect, dropEquipment, dropInventorySlot } from './loot.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { actorRadius } from './actor-physics.ts';
import type { CellItem, Game, GroundItem, Player, PlayerInput } from '../types.ts';

/** Work on a detached transfer plan so partial refills or rejected drops cannot leak value. */
function swapInstanceEquipment(s: Game, p: Player, pickup: GroundItem): void {
  const index = p.selectedSlot ?? 0, old = p.inventory?.[index];
  if (!old) return;
  const draft = { ...p, inventory: structuredClone(p.inventory) };
  const plan: Game = { ...s, map: { ...s.map, items: structuredClone(s.map.items) }, players: s.players.map(other => other === p ? draft : { ...other, inventory: structuredClone(other.inventory) }) };
  const incoming = plan.map.items.find(item => item.id === pickup.id)!;
  const outgoing = draft.inventory![index]!;
  draft.inventory![index] = null;
  if (!collectInstanceEquipment(plan, draft, incoming)) return;
  plan.map.items = plan.map.items.filter(item => item.id !== incoming.id);
  const accepted = [...draft.inventory!], selectedSlot = draft.selectedSlot;
  draft.inventory![index] = outgoing;
  if (!dropInventorySlot(plan, draft, index)) return;
  p.inventory = accepted; p.selectedSlot = selectedSlot; p.charging = null;
  s.map.items = plan.map.items; s.itemSerial = plan.itemSerial;
  syncWeapon(p, s.content.weapons);
}

export function interact(s: Game, p: Player): void {
  const cell = carriedCell(p);
  const charged = p.inventory?.find((item): item is CellItem => item?.kind === 'cell' && item.charge >= s.content.cellChargeTicks);
  if (p.role === 'contestant' && distance(p, s.map.exit) < EXTRACTION_REACH && s.slots > 0 && charged && lineClear(s.map, p, s.map.exit)) {
    s.slots--; p.inventory![p.inventory!.indexOf(charged)] = null; syncWeapon(p, s.content.weapons); p.charging = null; p.status = 'escaped';
    event(s, p.name + ' powered an escape pod. ' + s.slots + ' slots remain'); return;
  }
  if (cell && cell.charge < s.content.cellChargeTicks) {
    const station = s.map.chargers.find(st => distance(p, st) < CHARGE_REACH && lineClear(s.map, p, st));
    if (station) { p.charging = station.id; return; }
  }
  const pickup = p.inventory && s.map.items.filter(i => ['weapon', 'med', 'shield', 'cell'].includes(i.kind) && distance(p, i) < PICKUP_REACH && reachClear(s.map, p, i)
    && (!s.content.itemInstances || i.droppedBy !== p.id || !(i.pickupAfter! > s.tick)))
    .sort((a, b) => distance(p, a) - distance(p, b) || (s.content.itemInstances ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : 0))[0];
  if (!p.bot && pickup && p.inventory!.every(Boolean)) {
    if (s.content.itemInstances) { swapInstanceEquipment(s, p, pickup); return; }
    const index = p.selectedSlot!, old = equipped(p); p.inventory![index] = null;
    if (collectEquipment(p, pickup, s.content.weapons)) { s.map.items = s.map.items.filter(i => i.id !== pickup.id); dropEquipment(s, p, old!); }
    else p.inventory![index] = old;
    syncWeapon(p, s.content.weapons); return;
  }
  // The nearest gate takes the interaction even when it cannot be used; it never falls through to transit.
  const gate = nearbyGate(s.map, p, { accepts: g => !p.bot || !g.open, order: 'nearest' });
  if (gate) {
    const locked = gate.locked ?? gate.kind !== 'door';
    if (!gate.open && (!locked || p.keys > 0)) {
      gate.open = true; if (locked) { p.keys--; gate.locked = false; } clearRoute(p);
    } else if (gate.open && gate.kind === 'door' && !p.bot) {
      const box = gateShape(gate);
      const runtime = s.content.actorPhysics ? physicsRuntime(s) : undefined;
      // Under P2 the players are tested as well as the bodies: a transit earlier this phase has moved
      // its player but not yet its body, and synchronize would refuse the close only after discovery saw it.
      const occupied = s.players.some(other => other.status === 'active' && Math.hypot(other.x - Math.max(box.x, Math.min(box.x + box.w, other.x)), other.y - Math.max(box.y, Math.min(box.y + box.h, other.y))) < (runtime ? actorRadius(s, other) : bodyRadius(other)))
        || !!runtime?.world.overlapsDynamicBox(box);
      if (!occupied) { gate.open = false; clearRoute(p); }
    }
    // Trying a door shows how it stands, locked or not, whatever sight showed before (22.6, "Doors").
    if (p.discovery) observeGate(p.discovery, gate);
    return;
  }
  if (p.role === 'gladiator' && p.railCd === 0) {
    const station = s.map.stations.find(st => distance(p, st) < TRANSIT_REACH);
    if (station) {
      const candidates = s.map.stations.filter(st => st.x > s.hazardX + TILE && st.id !== station.id);
      const next = candidates.find(st => st.x > p.x + TILE) || candidates[0];
      if (next) {
        const runtime = s.content.actorPhysics ? physicsRuntime(s) : undefined;
        const at = runtime ? runtime.placement(p, next) : next;
        if (!at) return; // No effects/cooldown when the physical landing cannot be represented.
        effect(s, p, 'rail', 60); p.x = at.x; p.y = at.y; clearRoute(p); p.railCd = 180; effect(s, p, 'rail', 60);
      }
    }
  }
}
export function advanceCharging(s: Game, p: Player, input: PlayerInput): void {
  if (p.charging) {
    const cell = carriedCell(p);
    const station = s.map.chargers.find(st => st.id === p.charging);
    if (!cell || cell.charge >= s.content.cellChargeTicks || input.x || input.y || !station || distance(p, station) >= CHARGE_REACH || !lineClear(s.map, p, station)) p.charging = null;
    else if (++cell.charge >= s.content.cellChargeTicks) { p.charging = null; event(s, `${p.name} charged a power cell`); effect(s, p, 'charge', 70); }
  }
}
