import { AMMO_FAMILIES, EFFECT_KINDS, ITEM_KINDS, WEAPONS } from '../enum-tables.ts';
import { observeGate } from '../discovery.ts';
import { physicsRefusal } from '../physics/world.ts';
import type { Game, GroundItem, InventoryItem, ItemId, ItemLabel, Player, StationId } from '../types.ts';
import { actorRadius } from './actor-physics.ts';
import { event, participant } from './event-records.ts';
import { clearRoute } from './geometry.ts';
import { writeDoor } from './doors.ts';
import { addItems, addItemsFromCore, draftItem, groundItem, itemsNear, removeItem, replaceItem, settledItem } from './ground-items.ts';
import { applySyncLog, prepareInRunSync } from './boundary.ts';
import { configure, ground, putItem } from './phase-three.ts';
import type { ActionsCore } from './phase-three.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { ensureGround } from './ground-store.ts';
import { sawCoreRegistrations, syncRegistry } from './registry-store.ts';
import { adoptCarried, carriedItem, carriedToken, playersStale, replaceCarried, uploadPlayers } from './player-store.ts';
import { playerIndex } from './relations.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import { sightOf } from './sight-runtime.ts';
import { launchPhysicalDrops } from './world-physics.ts';
import { start as profileStart, stop as profileStop } from '../profiler.ts';

// Phase 6's per-actor loop runs in the core (`rust/core/src/phase_six.rs`, #1230, docs/27 "The state flip", step 5e.1):
// `interact`, the chosen `transit`, `advanceCharging` and `automaticPickups`, with the swap's staged pickup and drop.
// The records stay here (D1). Each call packs the actors still to run, and the core reports every write as an
// ordered fact, which this applies in order, so keys are created where the TypeScript created them and D4's
// Node-owned fields (`route`, `input`) are written here. A pickup taken whole, a committed swap and an instant
// transit's landing are carried out inside the core's run (#1214 stage 6d.6c.2): the core writes its ground store and
// syncs, and this mirrors the records without writing them through and applies the sync's log.
interface SixExports {
  interactions_input(world: number, words: number): number;
  interactions_run(world: number, collision: number, index: number, gates: number, swept: number): number;
  gate_set_details(gates: number): number;
}
type Core = ActionsCore & SixExports;

export const STEP_INTERACT = 1, STEP_TRANSIT = 2, STEP_CHARGING = 4, STEP_PICKUPS = 8;
const HEADER = 32, OUT_HEADER = 11;
/** An inventory the core takes from its player store (`phase_three::FROM_STORE`). */
const FROM_STORE = -2;
const ABSENT_AMMO = 1, ABSENT_CHARGE = 2, ABSENT_INSTANCE = 4, ABSENT_LINEAGE = 8, ABSENT_QUALITY = 16, ABSENT_WEAPON = 32, ABSENT_COUNT = 64;
/** `automaticPickups`' reach. */
const AUTOMATIC_REACH = 38;

/** One actor's turn: which of phase 6's steps it takes, and what its input chose. */
export interface Turn { player: Player; steps: number; choice?: StationId | undefined; sneak?: boolean; moved?: boolean }

const n = (value: number | null | undefined): number => typeof value === 'number' ? value : NaN;

/** The input, written in place and copied into the core's buffer once: a call packs hundreds of words a tick. */
class Writer {
  buf = new Float64Array(1024);
  len = 0;
  reset(header: number): void { this.len = header; }
  put(value: number): void {
    if (this.len === this.buf.length) { const grown = new Float64Array(this.len * 2); grown.set(this.buf); this.buf = grown; }
    this.buf[this.len++] = value;
  }
}
const writer = new Writer();
/** Records that cross for no one. */
const NONE: GroundItem[] = [];

/** A resumed pickup's rest record (`GROUND_ROW`): its body and rank are not read, so both are 0. */
function putGround(w: Writer, p: Player, item: GroundItem): void {
  const kind = ITEM_KINDS.indexOf(item.kind as typeof ITEM_KINDS[number]);
  const absent = (item.ammo == null ? ABSENT_AMMO : 0) | (item.charge == null ? ABSENT_CHARGE : 0) | (item.instanceId == null ? ABSENT_INSTANCE : 0)
    | (item.lineageId == null ? ABSENT_LINEAGE : 0) | (item.quality == null ? ABSENT_QUALITY : 0) | (item.weaponType == null ? ABSENT_WEAPON : 0)
    | (item.count == null ? ABSENT_COUNT : 0);
  w.put(item.id); w.put(item.x); w.put(item.y); w.put(item.droppedBy === p.id ? 1 : 0); w.put(n(item.pickupAfter));
  w.put(item.family === undefined ? -1 : AMMO_FAMILIES.indexOf(item.family)); w.put(0);
  w.put(0); w.put(kind === -1 ? -2 : kind); w.put(item.weaponType == null ? NaN : WEAPONS.indexOf(item.weaponType));
  w.put(n(item.ammo)); w.put(n(item.count)); w.put(n(item.charge)); w.put(n(item.instanceId)); w.put(n(item.lineageId));
  w.put(n(item.quality)); w.put(NaN); w.put(absent);
}

/**
 * The records the grid offers that can be within `automaticPickups`' reach: a box one unit wider, so the core's own
 * distance test decides. A record with a NaN coordinate stays, since that test does not refuse it.
 */
const inReach = (items: GroundItem[], p: Player): GroundItem[] =>
  items.filter(item => !(Math.abs(item.x - p.x) > AUTOMATIC_REACH + 1 || Math.abs(item.y - p.y) > AUTOMATIC_REACH + 1));

/** A new carried record in the key order `collectInstanceEquipment` built it. */
function newItem(row: Float64Array, at: number): InventoryItem {
  const kind = ITEM_KINDS[row[at]!]!;
  const identity = { instanceId: row[at + 5]! as ItemId, lineageId: row[at + 6]! as ItemId, ...(row[at + 9]! & ABSENT_QUALITY ? {} : { quality: row[at + 7]! }) };
  if (kind === 'weapon') return { kind, weaponType: WEAPONS[row[at + 1]!]!, ammo: row[at + 2]!, ...identity };
  if (kind === 'cell') return { kind, charge: row[at + 4]!, ...identity };
  return { kind: kind as 'med' | 'shield', count: row[at + 3]!, ...identity };
}

/**
 * Write an inventory row (`inventory_row` in phase_six.rs) into `inventory`, reading carried records by the store's tokens
 * (`player-store.ts`, #1214 stage 6c.3c.2). A new item is built and filed under the next token, as the store gives it; a
 * swap's clone takes its original's token.
 */
function putInventory(inventory: (InventoryItem | null)[], r: PhysicsRuntime, out: Float64Array, at: number, clone: boolean): number {
  const count = out[at]!; at++;
  for (let k = 0; k < count; k++, at += 10) {
    if (out[at] === -1) { inventory[k] = null; continue; }
    const token = out[at + 8]!;
    let item: InventoryItem;
    if (token < 0) { item = newItem(out, at); adoptCarried(r, item); }
    else if (clone) { item = structuredClone(carriedItem(r, token)!); replaceCarried(r, token, item); }
    else item = carriedItem(r, token)!;
    if (token >= 0) putItem(item, out, at);
    inventory[k] = item;
  }
  return at;
}

/**
 * Whether a call syncs its stops inside the core's run (#1214 stage 6d.6c.2). Only `tests/phase-six-core.test.js` turns
 * it off, to hold the run's continuation equal to the stop and resume it replaced.
 */
let inRunStops = true;
export function setInRunStops(on: boolean): void { inRunStops = on; }

/** Runs once with the given start; returns where it stopped, if it did, and the records still to visit then. */
function call(s: Game, turns: readonly Turn[], tickMode: boolean, rest: readonly GroundItem[] | undefined, step: number):
  { resume: number; step: number; rest?: GroundItem[] } {
  const r = physicsRuntime(s);
  if (!r) throw new Error('phase 6 needs the game\'s physics world');
  // The ground store is current before the core reads it (6d.6c.1).
  ensureGround(s, r);
  const native = r.world.boundaryCall(), core = native.core as Core, world = native.world;
  // Between ticks the store is uploaded first (`player-store.ts`), before anything names a carried record by its token,
  // since the upload numbers them afresh; inside a tick the store and the tokens are current.
  if (playersStale(r)) uploadPlayers(s, r, core, world);
  configure(s, r, core, world);
  // The core's item registry follows the game's (#1214 stage 6e.1): the run allocates and checks identities there.
  syncRegistry(s, r);
  const near: GroundItem[][] = [];
  let swaps = false, interacting = false;
  for (let i = 0; i < turns.length; i++) {
    const { player: p, steps } = turns[i]!;
    const interact = (steps & STEP_INTERACT) !== 0;
    const pickups = (steps & STEP_PICKUPS) !== 0 && p.role === 'contestant';
    const list = !pickups ? NONE : i === 0 && rest ? rest.map(item => groundItem(s, item.id) ?? item) : inReach(itemsNear(s, p, AUTOMATIC_REACH), p);
    near.push(list);
    const swap = interact && !p.bot && !!p.inventory?.every(Boolean);
    swaps ||= swap;
    interacting ||= interact;
  }
  // A call that can stop syncs inside the core's run instead (#1214 stage 6d.6c.2): a pickup, a swap or a gladiator's
  // landing. Its own stops are carried out there, so it reads the ground, the players and the hooks as they then stand.
  const inRun = inRunStops && (swaps || near.some(list => list.length > 0)
    || turns.some(t => (t.steps & STEP_TRANSIT) !== 0 && t.player.role === 'gladiator'));
  if (inRun) prepareInRunSync(s, r);
  const map = sightOf(s).queryHandles(s.map);
  if (map.core !== core) throw new Error('phase 6 and sight are bound to different cores');
  const w = writer;
  w.reset(HEADER);
  const h = w.buf;
  h[0] = tickMode ? 0 : 1; h[1] = 0; h[2] = step; h[3] = s.tick; h[4] = s.serial; h[5] = s.itemSerial ?? 1; h[6] = s.scatterSerial ?? 0;
  h[7] = s.slots; h[8] = s.hazardX; h[9] = s.content.cellChargeTicks; h[10] = s.content.transitTime ? 1 : 0;
  h[11] = n(s.content.transitTime?.base); h[12] = n(s.content.transitTime?.perUnit); h[13] = s.items.length;
  h[14] = Math.max(0, s.players.length - r.actors.size); h[15] = s.map.exit.x; h[16] = s.map.exit.y;
  for (let k = 0; k < 3; k++) h[17 + k] = n(s.content.reloading?.reserves[AMMO_FAMILIES[k]!]);
  h[20] = turns.length; h[21] = s.players.length; h[22] = s.map.stations.length; h[23] = s.map.chargers.length;
  // The label phases and registered identities are the core's registry's (`FROM_STORE`, 6e.1).
  h[24] = s.map.sensors.length; h[25] = FROM_STORE; h[26] = 0; h[27] = 0; h[28] = 0; h[29] = inRun ? 1 : 0; h[30] = 0; h[31] = 0;
  for (let i = 0; i < turns.length; i++) {
    const { player: p, steps, choice, sneak, moved } = turns[i]!;
    const interact = (steps & STEP_INTERACT) !== 0;
    const list = near[i]!;
    const swap = interact && !p.bot && !!p.inventory?.every(Boolean);
    // An actor sends its inventory only when a rule can read it: pickups, charging, a swap, or an interaction that may
    // extract or start charging, which need a carried cell. Gates and transit never read it.
    const readable = list.length || swap || p.charging || interact && p.inventory?.some(item => item?.kind === 'cell');
    const inventory = readable ? p.inventory : undefined;
    // The core reads the ground from its store (#1214 stage 6d.6c.1): a swap's candidates, spacing spots and the outgoing
    // item's ground check, and the near records, except a resumed pickup's rest, which still crosses.
    const rested = i === 0 && rest !== undefined;
    // Role, status, pose, `railCd` and `cloak` come from the core's player store (`player-store.ts`, #1214 stage 6c.3b);
    // their words stay 0.
    w.put(playerIndex(s, p)); w.put(0); w.put(0); w.put(p.bot ? 1 : 0);
    // The equipment comes from the store too (6c.3c.2): keys, charging, selection, weapon and reserves always, and the
    // inventory where a rule can read it (`FROM_STORE`), as it was packed before.
    w.put(0); w.put(0); w.put(0); w.put(0); w.put(0); w.put(0);
    w.put(0); w.put(0); w.put(moved ? 1 : 0); w.put(p.discovery ? 1 : 0); w.put(steps);
    w.put(choice === undefined ? NaN : s.map.stations.findIndex(st => st.id === choice)); w.put(sneak ? 1 : 0); w.put(0);
    w.put(inventory ? FROM_STORE : -1); w.put(swap ? FROM_STORE : 0); w.put(0); w.put(0);
    w.put(rested ? list.length : inRun || list.length ? FROM_STORE : 0);
    // A resumed pickup's rest: the near records' bodies are not read.
    if (rested) for (const item of list) putGround(w, p, item);
  }
  // Each player's status and pose come from the store too; only the radius crosses.
  for (const p of s.players) { w.put(0); w.put(0); w.put(0); w.put(actorRadius(s, p)); }
  for (const list of [s.map.stations, s.map.chargers, s.map.sensors]) for (const at of list) { w.put(at.x); w.put(at.y); }
  if (swaps) for (const p of s.players) for (const item of p.inventory ?? []) if (item?.instanceId) {
    w.put(carriedToken(r, item)!); w.put(item.instanceId); w.buf[27]++;
  }
  // The core finds the gates near an interacting actor in its own gate set. Their positions and kinds cross once per
  // gate set; their state is the set's own (stage 6a, `doors.ts`), so nothing about it crosses.
  if (interacting && core.gate_set_details(map.gates) !== s.map.gates.length) {
    w.buf[28] = s.map.gates.length;
    for (const gate of s.map.gates) { w.put(gate.x); w.put(gate.y); w.put(gate.kind === 'door' ? 1 : 0); }
  }
  if (inRun) {
    // The sync's markers; the body keys a swap's drop takes are the core's registry's (6e.1).
    const markers = r.discontinuities.map(entry => r.world.key(entry.id));
    for (const value of [r.discontinuityCapacity, s.players.length, s.content.worldPhysics.loot.dropSpeed, swaps ? 1 : 0, markers.length, ...markers]) w.put(value);
  }
  const ptr = core.interactions_input(world, w.len) >>> 0;
  new Float64Array(core.memory.buffer, ptr, w.len).set(w.buf.subarray(0, w.len));
  if (tickMode) profileStart('sim.pickups.core');
  const outPtr = core.interactions_run(world, map.collision, map.index, map.gates, inRun ? sightOf(s).sweptHandle(s.map) : 0) >>> 0;
  if (tickMode) profileStop('sim.pickups.core');
  // Applying a stop synchronizes and can grow memory: then this call's facts are kept.
  const view = new Float64Array(core.memory.buffer, outPtr, new Float64Array(core.memory.buffer, outPtr, 1)[0]!);
  const out = view[4]! >= 0 || inRun ? view.slice() : view;
  s.serial = out[1]!;
  s.itemSerial = out[2]!; s.scatterSerial = out[3]!;
  s.itemIdentities ??= { ids: new Map(), labels: new Map() };
  let at = OUT_HEADER;
  // Each allocation with its body key, which the core interned and registered (6e.1).
  const registered = s.itemIdentities.labels.size;
  for (let i = 0; i < out[7]!; i++, at += 3) {
    const id = out[at]! as ItemId, label = `instance-${out[at + 1]!}` as ItemLabel;
    s.itemIdentities.ids.set(label, id); s.itemIdentities.labels.set(id, label);
    if (!Number.isNaN(out[at + 2]!)) r.world.adoptKey(out[at + 2]!, `item:${label}`);
  }
  sawCoreRegistrations(s, r, registered);
  const logEnd = at + out[8]!;
  const resume = out[4]!, resumeStep = out[5]!;
  let restAfter: GroundItem[] | undefined;
  const withSerial = (id: number, write: () => void): void => { const kept = s.serial; s.serial = id; write(); s.serial = kept; };
  while (at < logEnd) {
    const op = out[at]!, len = out[at + 1]!; at += 2;
    const p = s.players[out[at]!]!;
    switch (op) {
      case 1: s.effects.push({ id: out[at]!, x: out[at + 1]!, y: out[at + 2]!, kind: EFFECT_KINDS[out[at + 3]!]!, radius: out[at + 4]!, life: 12 }); break;
      case 2: {
        // `interact`'s extraction, in its order.
        s.slots = out[at + 4]!; p.inventory![out[at + 1]!] = null; p.weapon = out[at + 2]!; p.charging = null; p.status = 'escaped';
        withSerial(out[at + 3]!, () => event(s, { kind: 'pod_powered', actor: participant(s, p), slotsRemaining: s.slots }));
        break;
      }
      case 3: withSerial(out[at + 1]!, () => event(s, { kind: 'cell_charged', actor: participant(s, p) })); break;
      case 4: clearRoute(p); break;
      case 5: p.charging = out[at + 1]! < 0 ? null : s.map.chargers[out[at + 1]!]!.id; break;
      case 6: {
        // A delayed transit; `input` is Node-owned (27, D4's table).
        p.status = 'transit'; p.transit = { to: s.map.stations[out[at + 1]!]!.id, arriveAt: out[at + 2]! }; p.charging = null; p.input = {};
        break;
      }
      case 7: p.x = out[at + 1]!; p.y = out[at + 2]!; p.railCd = out[at + 3]!; break;
      case 8: {
        const gate = s.gates[out[at + 1]!]!;
        // The core has written its gate set already; the mirror follows, in `interact`'s order.
        if (out[at + 2]) { writeDoor(gate, 'open', true); if (out[at + 3]) { p.keys--; writeDoor(gate, 'locked', false); } } else writeDoor(gate, 'open', false);
        clearRoute(p);
        break;
      }
      case 9: if (p.discovery) observeGate(p.discovery, s.gates[out[at + 1]!]!); break;
      case 10: (p.inventory![out[at + 1]!] as { charge: number }).charge = out[at + 2]!; break;
      case 11: p.keys = out[at + 1]!; break;
      case 12: {
        const sel = out[at + 1]!, weapon = out[at + 2]!;
        putInventory(p.inventory!, r, out, at + 7, false);
        if (!Object.is(n(p.selectedSlot), sel)) p.selectedSlot = sel;
        if (!Object.is(p.weapon, weapon)) p.weapon = weapon;
        if (out[at + 3]) AMMO_FAMILIES.forEach((f, k) => { if (!Object.is(p.reserves![f], out[at + 4 + k])) p.reserves![f] = out[at + 4 + k]!; });
        break;
      }
      case 13: {
        // A ground record partly taken: its draft, kept only if it differs.
        const id = out[at]! as ItemId, current = groundItem(s, id)!, draft = draftItem(current);
        if (out[at + 1] === 0) draft.ammo = out[at + 2]!; else draft.count = out[at + 2]!;
        const next = settledItem(current, draft);
        // Inside a run that syncs itself, the core wrote its store already (6d.6c.2).
        if (next !== current) replaceItem(s, current, next, inRun);
        break;
      }
      case 14: {
        // Taken whole inside a run that syncs itself: the core took it off its store, and its sync follows (op 17).
        if (inRun) { removeItem(s, groundItem(s, out[at + 1]! as ItemId)!, true); break; }
        // Taken whole: off the ground, then the sync, as `automaticPickups` did (5c.2's boundary).
        const listed = near[resume]!, id = out[at + 1]! as ItemId;
        const index = listed.findIndex(item => item.id === id);
        const removed = removeItem(s, groundItem(s, id)!), { x, y } = p;
        r.synchronize();
        // Synchronizing can place the player again; the records still to visit are then those after it near where it stands.
        if (!Object.is(p.x, x) || !Object.is(p.y, y)) {
          const later = new Set(s.items.slice(removed));
          restAfter = inReach(itemsNear(s, p, AUTOMATIC_REACH), p).filter(other => later.has(other));
        } else restAfter = listed.slice(index + 1);
        break;
      }
      case 15: {
        // A committed swap, in `swapInstanceEquipment`'s order.
        const pickup = groundItem(s, out[at + 1]! as ItemId)!;
        const sel = out[at + 2]!, weapon = out[at + 3]!;
        const inventory = new Array<InventoryItem | null>(out[at + 8]!);
        const end = putInventory(inventory, r, out, at + 8, true);
        p.inventory = inventory;
        p.selectedSlot = Object.is(n(p.selectedSlot), sel) ? p.selectedSlot : sel;
        const reserves = p.reserves && { ...p.reserves };
        if (reserves && out[at + 4]) AMMO_FAMILIES.forEach((f, k) => { if (!Object.is(reserves[f], out[at + 5 + k])) reserves[f] = out[at + 5 + k]!; });
        p.reserves = reserves;
        p.charging = null;
        const records = Array.from({ length: out[end]! }, (_, i) => ground(out, end + 1 + i * 14, p, s.tick));
        // Inside a run that syncs itself, the core changed its store and launched the records; its sync follows (op 17).
        if (inRun) { removeItem(s, pickup, true); addItemsFromCore(s, records); } else {
          removeItem(s, pickup); addItems(s, ...records);
          launchPhysicalDrops(s, records, p);
        }
        p.weapon = weapon;
        break;
      }
      case 17: applySyncLog(s, r, out.subarray(at, at + len), r.stepping ? s.tick : s.tick + 1); break;
      case 16: p.revealed = out[at + 1]!; break;
      default: throw new Error(`unknown phase 6 fact ${op}`);
    }
    at += len;
  }
  if (out[9] === -101) throw new Error('Invalid item scatter counter');
  if (out[9] === -102) throw new Error('Item instance counter exhausted');
  if (out[9] === -103) throw new Error('Invalid carried item identity');
  if (out[9] === -104) throw new Error(`Unregistered item identity ${out[10]}`);
  if (out[9]! < 0) throw physicsRefusal(out[9]!, r.world.idOf(out[10]!));
  return restAfter ? { resume, step: resumeStep, rest: restAfter } : { resume, step: resumeStep };
}

/** Phase 6's per-actor loop over `turns`, in their order; `tickMode` skips an actor's charging and pickups once it is not active. */
export function phaseSix(s: Game, turns: readonly Turn[], tickMode: boolean): void {
  let from = 0, step = 0, rest: GroundItem[] | undefined;
  while (from < turns.length) {
    const result = call(s, turns.slice(from), tickMode, rest, step);
    if (result.resume < 0) return;
    from += result.resume; step = result.step; rest = result.rest;
  }
}
