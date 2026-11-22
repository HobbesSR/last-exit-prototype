import type { CoreExports } from '../core.ts';
import { AMMO_FAMILIES, EFFECT_KINDS, ITEM_KINDS, KITS, WEAPONS } from '../enum-tables.ts';
import { DISCOVERY_CELL_SIZE } from '../discovery.ts';
import { forkItemAllocation, itemIdForLabel, itemLabel } from '../item-instances.ts';
import type { PhysicsExports, PhysicsWorld } from '../physics/world.ts';
import { physicsRefusal } from '../physics/world.ts';
import type { AmmoFamily, Game, GroundItem, InventoryItem, ItemId, ItemLabel, Player, PlayerInput } from '../types.ts';
import type { ActionIntent, DropPlan } from './action-records.ts';
import { UTILITY_RULES } from './action-records.ts';
import { MOVEMENT_SPEED } from '../movement.ts';
import { HZ } from './rules.ts';
import { playerIndex } from './relations.ts';
import { addItems, addItemsFromCore, groundItem, itemsNear } from './ground-items.ts';
import { sawCoreRegistrations, syncRegistry } from './registry-store.ts';
import { projectilesCurrent, sawProjectiles } from './projectile-store.ts';
import { applySyncLog, prepareInRunSync } from './boundary.ts';
import { physicsRuntime, type PhysicsRuntime } from './physics-runtime.ts';
import { appendItem, carriedItem, carriedToken, playersStale, uploadPlayers } from './player-store.ts';
import { sawHooks, syncHooks } from './hook.ts';
export { appendItem };
import { event, participant } from './event-records.ts';
import { sightOf } from './sight-runtime.ts';
import { launchPhysicalDrops } from './world-physics.ts';
import { start as profileStart, stop as profileStop } from '../profiler.ts';

// The phase's rules run in phase_three.rs. JavaScript owns records until 27's flip: this adapter
// packs only intent-bearing actors and the inventories the rules can change. Static rules cross
// once per world. The loop's drops sync inside the core's run (#1214 stage 6d.6b); an elimination's still return at
// their synchronization boundary.
interface ActionsExports {
  actions_input(world: number, words: number): number;
  actions_configure(world: number): void;
  actions_run(world: number, collision: number, index: number, gates: number, swept: number): number;
}
export type ActionsCore = CoreExports & PhysicsExports & ActionsExports;
type Core = ActionsCore;
const OUT_HEADER = 13, PLAYER_ROW = 24, ITEM_ROW = 10, RECORD_ROW = 14;
/** An inventory the core takes from its player store (`phase_three::FROM_STORE`), and the first of a call's own tokens. */
const FROM_STORE = -2, EXTRA_TOKEN = 1e9;
const configured = new WeakMap<PhysicsWorld, Game['content']>();
const n = (value: number | null | undefined): number => typeof value === 'number' ? value : NaN;
const code = (values: readonly string[], value: string | undefined): number => value === undefined ? NaN : values.indexOf(value);

/** Uploads the match-pinned rules once per world; phase 5's combat (`phase-five.ts`) reads them too. */
export function configure(s: Game, r: PhysicsRuntime, core: Core, world: number): void {
  if (configured.get(r.world) === s.content) return;
  const c = s.content, a = c.actorPhysics;
  const data = [c.itemInstances.groundCapacity, c.reloading ? 1 : 0, a.acceleration, a.braking,
    a.geometry.contestant.bodyRadius, a.geometry.gladiator.bodyRadius, c.worldPhysics.loot.radius,
    c.hearing?.ticks ?? 0, DISCOVERY_CELL_SIZE, s.map.width, s.map.height, c.hook.cooldownTicks,
    HZ, MOVEMENT_SPEED.contestant, MOVEMENT_SPEED.gladiator, MOVEMENT_SPEED.contestantBoost, MOVEMENT_SPEED.gladiatorBoost,
    MOVEMENT_SPEED.stun, MOVEMENT_SPEED.sneak, UTILITY_RULES.medHealth, UTILITY_RULES.shieldAmount, UTILITY_RULES.maxShield,
    ...KITS.map(k => n(c.kits[k]?.cooldown)), ...KITS.map(k => n(c.kits[k]?.damage)),
    c.lootTiers?.damage.length ?? 0, ...c.lootTiers?.damage ?? [], WEAPONS.length];
  for (const type of WEAPONS) {
    const w = c.weapons[type], reload = c.reloading?.weapons[type];
    data.push(w.ammo, w.maxAmmo, w.cooldown, w.speed, w.life, w.damage, reload ? AMMO_FAMILIES.indexOf(reload.family) : -1,
      n(reload?.magazine), n(reload?.reloadTicks), c.hearing?.ranges[type] ?? 0, w.spread.length, ...w.spread);
  }
  const surfaces = [...s.map.motorSurfaces ?? []].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  data.push(surfaces.length);
  for (const f of surfaces) data.push(f.x, f.y, f.w, f.h, f.speed ?? 1, f.traction ?? 1, f.braking ?? 1);
  const ptr = core.actions_input(world, data.length) >>> 0;
  new Float64Array(core.memory.buffer, ptr, data.length).set(data);
  core.actions_configure(world); configured.set(r.world, s.content);
}

/** Apply only writes, keeping the original carried objects through moves and stack merges. */
export function putItem(item: InventoryItem, row: Float64Array, at: number): void {
  const put = (key: 'instanceId' | 'lineageId' | 'quality', value: number): void => {
    if (!Object.is(n(item[key]), value)) item[key] = value as ItemId;
  };
  put('instanceId', row[at + 5]!); put('lineageId', row[at + 6]!); put('quality', row[at + 7]!);
  if (item.kind === 'weapon' && !(row[at + 9]! & 1) && !Object.is(item.ammo, row[at + 2])) item.ammo = row[at + 2]!;
  else if ((item.kind === 'med' || item.kind === 'shield') && !Object.is(n(item.count), row[at + 3])) item.count = row[at + 3]!;
  else if (item.kind === 'cell' && !Object.is(n(item.charge), row[at + 4])) item.charge = row[at + 4]!;
}

/** New ground records keep the field insertion order of planDrop/planAmmoDrop (the frozen frames hash JSON). */
export function ground(row: Float64Array, at: number, p: Player, tick: number): GroundItem {
  const kind = ITEM_KINDS[row[at]!]!, id = row[at + 10]! as ItemId, lineageId = row[at + 6]! as ItemId;
  const x = row[at + 11]!, y = row[at + 12]!;
  if (kind === 'ammo') return { kind, id, lineageId, family: AMMO_FAMILIES[row[at + 13]!]!, count: row[at + 3]!, x, y, droppedBy: p.id, pickupAfter: tick + HZ };
  return { kind, id, lineageId, ...(!Number.isNaN(row[at + 7]!) ? { quality: row[at + 7]! } : {}),
    ...(kind === 'weapon' ? { weaponType: WEAPONS[row[at + 1]!]!, ammo: row[at + 2]! }
      : kind === 'cell' ? { charge: row[at + 4]! } : { count: 1 }), x, y, droppedBy: p.id, pickupAfter: tick + HZ };
}

const MODE_ELIMINATE = 4;
/**
 * Whether the loop's drops sync inside the core's run (6d.6b). Only `tests/phase-three-core.test.js` turns it off, to
 * hold the run's continuation equal to the stop and resume it replaced.
 */
let inRunDrops = true;
export function setInRunDrops(on: boolean): void { inRunDrops = on; }
interface Options { mode?: number; player?: Player; item?: InventoryItem; family?: AmmoFamily; count?: number;
  mandatory?: boolean; items?: readonly GroundItem[]; source?: Game; start?: number; stage?: number; killer?: Player | null }

function call(s: Game, intents: readonly (ActionIntent | undefined)[], options: Options = {}): { resume: number; stage: number; plan: DropPlan | null } {
  const r = physicsRuntime(s);
  if (!r) throw new Error('phase 3 needs the game\'s physics world');
  const native = r.world.boundaryCall(), core = native.core as Core, world = native.world;
  // Between ticks the store is uploaded first (`player-store.ts`), before anything names a carried record by its token,
  // since the upload numbers them afresh; inside a tick the store and the tokens are current.
  if (playersStale(r)) uploadPlayers(s, r, core, world);
  configure(s, r, core, world);
  const mode = options.mode ?? 0, source = options.source ?? s, killer = options.killer ?? null;
  // An elimination packs its target, then its source when that is another player.
  const actors = options.player ? [options.player, ...killer && killer !== options.player ? [killer] : []] : s.players.filter((_, i) => intents[i])
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Carried records are named by the store's tokens (`player-store.ts`, #1214 stage 6c.3c.2). A plan's standalone item
  // that no inventory holds takes a token of this call's, far above the store's.
  const extras: InventoryItem[] = [];
  const token = (item: InventoryItem): number => carriedToken(r, item) ?? EXTRA_TOKEN + extras.push(item) - 1;
  const itemOf = (t: number): InventoryItem => (t >= EXTRA_TOKEN ? extras[t - EXTRA_TOKEN] : carriedItem(r, t))!;
  const allocations: InventoryItem[] = [], droppers: Player[] = [];
  let allocationCount = 0, context = mode === 1;
  for (const p of actors) {
    const intent = intents[playerIndex(s, p)], input = intent?.input;
    if (input?.moveSlot) { allocations.push(...p.inventory?.filter(i => i !== null) ?? []); allocationCount += p.inventory?.filter(i => i && i.instanceId === undefined).length ?? 0; }
    if (mode === 2 || mode === 3 || mode === MODE_ELIMINATE && p === options.player || input?.drop || input?.dropAmmo || intent?.discardSlot !== undefined) {
      droppers.push(p); allocations.push(...p.inventory?.filter(i => i !== null) ?? []); allocationCount += 4; context = true;
    }
    if (input?.skill && p.kit === 'specter' && p.cooldown <= 0) context = true;
    if ((mode === 1 || input?.attack || intent?.utilitySlot !== undefined) && p.role === 'contestant' && p.attackCd <= 0) context = true;
  }
  if (options.item) { allocations.push(options.item); allocationCount += 3; }
  // The game's own allocation reads the core's item registry (#1214 stage 6e.1). A plan staged on a fork of it (a
  // swap's) still packs the free label phases and registered identities from the fork, which the core does not hold.
  const live = source === s;
  const known = new Set<number>(), phases: number[] = [];
  if (live) syncRegistry(s, r);
  else {
    for (const item of allocations) for (const id of [item.instanceId, item.lineageId]) if (id !== undefined) {
      try { itemLabel(source, id); known.add(id); } catch { /* An unknown identity is refused by the core after the search. */ }
    }
    // Registry membership, not a scan of the ground, supplies the free legacy label phases (D6).
    let phase = source.scatterSerial ?? 0;
    if (Number.isSafeInteger(phase) && phase >= 0) for (; phases.length < allocationCount && phase < Number.MAX_SAFE_INTEGER; phase++) {
      if (itemIdForLabel(source, `instance-${phase}`) === undefined) phases.push(phase);
    }
  }
  const items = options.items ?? s.items, near = new Set<GroundItem>();
  for (const p of droppers) {
    if (items === s.items && Number.isFinite(p.x) && Number.isFinite(p.y)) for (const item of itemsNear(s, p, 405)) near.add(item);
    else for (const item of items) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || Number.isNaN(item.x) || Number.isNaN(item.y)
      || Math.abs(item.x - p.x) <= 405 && Math.abs(item.y - p.y) <= 405) near.add(item);
  }
  const groundIds: number[] = [], carried: number[] = [];
  if (droppers.length) {
    for (const item of allocations) if (item.instanceId && (items === s.items ? groundItem(s, item.instanceId) : items.some(i => i.id === item.instanceId))) groundIds.push(item.instanceId);
    for (const p of s.players) for (const item of p.inventory ?? []) if (item?.instanceId) carried.push(token(item), item.instanceId);
  }
  const contexts = context ? s.players : [];
  // The hooks are the core's (6d.4): where they would have been packed, the core reads its own (`FROM_STORE`).
  const hooksRead = actors.some(p => p.kit === 'hook' && intents[playerIndex(s, p)]?.input.skill);
  if (hooksRead) syncHooks(r);
  // The loop's drops sync inside its run (#1214 stage 6d.6b): the core adds their records, launches them and syncs where
  // this adapter stopped it. The bodies' keys are the core's registry's (6e.1). An elimination's drops do too (6e.2);
  // the standalone plans still stop at a drop.
  const inRun = (mode === 0 || mode === MODE_ELIMINATE) && droppers.length > 0 && inRunDrops;
  const inRunWords: number[] = [];
  if (inRun) {
    prepareInRunSync(s, r);
    inRunWords.push(r.discontinuityCapacity, s.players.length, s.content.worldPhysics.loot.dropSpeed, r.discontinuities.length,
      ...r.discontinuities.map(entry => r.world.key(entry.id)));
  }
  const data: number[] = [mode, options.start ?? 0, options.stage ?? 0, s.tick, s.serial, source.itemSerial ?? 1, source.scatterSerial ?? 0,
    items.length, Math.max(0, s.players.length - r.actors.size), actors.length, contexts.length, live ? FROM_STORE : phases.length, known.size,
    near.size, groundIds.length, carried.length / 2, hooksRead ? FROM_STORE : 0, options.mandatory ? 1 : 0, code(AMMO_FAMILIES, options.family), n(options.count), inRun ? 1 : 0];
  for (const p of actors) {
    const intent = intents[playerIndex(s, p)], input: PlayerInput = intent?.input ?? {};
    const inventory = options.item ? [options.item] : mode === MODE_ELIMINATE ? p === options.player ? p.inventory : undefined : mode === 1 || mode === 2 || !!(input.slot !== undefined || input.moveSlot || intent?.utilitySlot !== undefined
      || input.drop || intent?.discardSlot !== undefined || input.reload || p.reload || input.attack && p.role === 'contestant' && p.attackCd <= 0) ? p.inventory : undefined;
    // The store's fields (role, status, kit, pose, heading, health, cooldowns, cloak, reveal, boost, stun, level and the actor's
    // key, 6c.3b) and its equipment (selection, weapon, reserves, reload, 6c.3c.2) come from the core's player store
    // (`player-store.ts`, #1214); their words stay 0. The inventory crosses as before only for a plan's standalone item;
    // a carried one is asked for from the store (`FROM_STORE`) when the rules may read it, as it was packed before.
    const fromStore = !options.item && inventory !== undefined && inventory === p.inventory;
    data.push(playerIndex(s, p), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      fromStore ? FROM_STORE : inventory?.length ?? -1, 0, 0, 0);
    if (!fromStore) for (const item of inventory ?? []) appendItem(data, item, item ? token(item) : NaN);
    data.push(n(input.aim), n(input.slot), n(input.moveSlot?.from), n(input.moveSlot?.to), n(intent?.utilitySlot), n(intent?.discardSlot), input.drop ? 1 : 0,
      code(AMMO_FAMILIES, input.dropAmmo?.family), n(input.dropAmmo?.count), input.reload ? 1 : 0, input.skill ? 1 : 0, input.attack ? 1 : 0,
      n(input.x), n(input.y), input.sneak ? 1 : 0);
  }
  for (const p of contexts) {
    // Role, status and pose come from the core's player store (stage 6c.3b), and so do the cues heard (6e.4).
    data.push(playerIndex(s, p), 0, 0, 0, 0, s.content.actorPhysics.geometry[p.role].bodyRadius, r.world.key(`actor:${p.id}`), 0);
  }
  data.push(...phases, ...known);
  for (const item of near) data.push(item.x, item.y);
  data.push(...groundIds, ...carried);
  if (mode === MODE_ELIMINATE) data.push(!killer ? -1 : killer === options.player ? 0 : 1, killer?.kills ?? 0, s.content.gladiatorRespawnTicks);
  data.push(...inRunWords);
  // Interning and map preparation can grow memory; view the input only after those calls.
  const map = sightOf(s).queryHandles(s.map), swept = inRun ? sightOf(s).sweptHandle(s.map) : 0;
  if (map.core !== core) throw new Error('phase 3 and sight are bound to different cores');
  const ptr = core.actions_input(world, data.length) >>> 0;
  new Float64Array(core.memory.buffer, ptr, data.length).set(data);
  if (mode === 0) profileStart('sim.actions.core');
  const outPtr = core.actions_run(world, map.collision, map.index, map.gates, swept) >>> 0;
  if (mode === 0) profileStop('sim.actions.core');
  // Applying a drop synchronizes and can grow memory. Retain this call's facts across that boundary.
  const view = new Float64Array(core.memory.buffer, outPtr, new Float64Array(core.memory.buffer, outPtr, 1)[0]!);
  // So does a sync applied from the log (6d.6b).
  const out = mode === 1 || view[4]! >= 0 || inRun ? view.slice() : view;
  return applyOutput(s, r, out, { mode, options, source, itemOf, live });
}

/** What an output's application reads of the call that made it. */
interface Applied { mode: number; options: Options; source: Game; itemOf: (token: number) => InventoryItem; live: boolean }

/** Apply a phase 3 output (`phase_three.rs`): the players' rows, the registrations, then the log, in order. */
function applyOutput(s: Game, r: PhysicsRuntime, out: Float64Array, { mode, options, source, itemOf, live }: Applied): { resume: number; stage: number; plan: DropPlan | null } {
  // The core took this call's shots into its projectiles (#1214 stage 6e.3), as the mirror takes them below.
  const current = projectilesCurrent(s, r);
  // Loop, attack and elimination calls write their players back; a standalone plan writes nothing.
  const writes = mode < 2 || mode === MODE_ELIMINATE;
  let at = OUT_HEADER;
  for (let i = 0; i < out[7]!; i++) {
    const row = at, p = s.players[out[row]!]!, invCount = out[row + 20]!, reserves = out[row + 21]!, reload = out[row + 22]!, retired = out[row + 23]!;
    at += PLAYER_ROW;
    if (writes) {
      if (!Object.is(p.heading, out[row + 7])) p.heading = out[row + 7]!;
      if (!Object.is(p.hp, out[row + 8])) p.hp = out[row + 8]!;
      if (!Object.is(p.shield, out[row + 10])) p.shield = out[row + 10]!;
      if (!Object.is(n(p.selectedSlot), out[row + 11])) p.selectedSlot = out[row + 11]!;
      if (!Object.is(p.weapon, out[row + 12])) p.weapon = out[row + 12]!;
      if (!Object.is(p.attackCd, out[row + 13])) p.attackCd = out[row + 13]!;
      if (!Object.is(p.cooldown, out[row + 14])) p.cooldown = out[row + 14]!;
      if (!Object.is(p.cloak, out[row + 15])) p.cloak = out[row + 15]!;
      if (!Object.is(p.boost, out[row + 17])) p.boost = out[row + 17]!;
    }
    if (reserves) { if (writes) for (let k = 0; k < 3; k++) p.reserves![AMMO_FAMILIES[k]!] = out[at + k]!; at += 3; }
    if (reload) {
      if (writes && (!p.reload || p.reload.slot !== out[at] || p.reload.instanceId !== out[at + 1] || p.reload.until !== out[at + 2]))
        p.reload = { slot: out[at]!, instanceId: out[at + 1]! as ItemId, until: out[at + 2]! };
      at += 3;
    } else if (writes && p.reload) p.reload = null;
    if (invCount >= 0) for (let k = 0; k < invCount; k++, at += ITEM_ROW) if (writes) {
      const item = out[at] === -1 ? null : itemOf(out[at + 8]!);
      if (item) putItem(item, out, at);
      p.inventory![k] = item;
    }
    for (let k = 0; k < retired; k++, at += ITEM_ROW) if (writes) putItem(itemOf(out[at + 8]!), out, at);
  }
  const allocation = mode === 2 || mode === 3 ? forkItemAllocation(source) : s;
  allocation.itemSerial = out[2]!; allocation.scatterSerial = out[3]!;
  allocation.itemIdentities ??= { ids: new Map(), labels: new Map() };
  // Each allocation with its body key, which the core interned, and registered where the call writes (6e.1).
  const registered = s.itemIdentities?.labels.size ?? 0;
  for (let i = 0; i < out[8]!; i++, at += 3) {
    const id = out[at]! as ItemId, label = `instance-${out[at + 1]!}` as ItemLabel;
    allocation.itemIdentities.ids.set(label, id); allocation.itemIdentities.labels.set(id, label);
    if (!Number.isNaN(out[at + 2]!)) r.world.adoptKey(out[at + 2]!, `item:${label}`);
  }
  if (live && allocation === s) sawCoreRegistrations(s, r, registered);
  const logEnd = at + out[9]!;
  if (writes) s.serial = out[1]!;
  while (at < logEnd) {
    const op = out[at]!, len = out[at + 1]!; at += 2;
    if (op === 1) s.effects.push({ id: out[at]!, x: out[at + 1]!, y: out[at + 2]!, kind: EFFECT_KINDS[out[at + 3]!]!, radius: out[at + 4]!, life: 12 });
    else if (op === 2) s.projectiles.push({ id: out[at]!, owner: s.players[out[at + 1]!]!.id, x: out[at + 2]!, y: out[at + 3]!, dx: out[at + 4]!, dy: out[at + 5]!, life: out[at + 6]!, damage: out[at + 7]! });
    else if (op === 3) {
      const p = s.players[out[at]!]!;
      if (!p.heard) Object.defineProperty(p, 'heard', { value: [], writable: true, configurable: true, enumerable: false });
      p.heard = Array.from({ length: out[at + 1]! }, (_, i) => ({ x: out[at + 2 + i * 4]!, y: out[at + 3 + i * 4]!, tick: out[at + 4 + i * 4]!, until: out[at + 5 + i * 4]! }));
    } else if (op === 5) { const caster = out[at]!; r.hooks = r.hooks.filter(h => !(h.casterIdx === caster && h.id === `hook:${s.players[caster]!.id}`)); sawHooks(r); }
    else if (op === 6) {
      const casterIdx = out[at]! as import('../types.ts').PlayerIdx, p = s.players[casterIdx]!;
      r.hooks.push({ id: `hook:${p.id}`, tetherId: r.identities.newTether(), casterIdx, x: p.x, y: p.y, dx: out[at + 2]!, dy: out[at + 3]!, travelled: 0,
        startedTick: s.tick, phase: 'flying', generationA: out[at + 1]! });
      r.hooks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      sawHooks(r);
    } else if (op === 7) r.world.adoptMotor(out[at]!, out[at + 1]!, out[at + 2]!, out[at + 3]!);
    else if (op === 8) { r.world.adoptCommit(out[at]!, out, at + 1); r.world.adoptQueue(out[at + len - 1]!); }
    else if (op === 9) {
      const p = s.players[out[at]!]!, records = Array.from({ length: out[at + 1]! }, (_, i) => ground(out, at + 2 + i * RECORD_ROW, p, s.tick));
      addItems(s, ...records); launchPhysicalDrops(s, records, p);
    } else if (op === 16) {
      // A drop the core synced in the run: its store holds the records, which it launched (6d.6b).
      const p = s.players[out[at]!]!;
      addItemsFromCore(s, Array.from({ length: out[at + 1]! }, (_, i) => ground(out, at + 2 + i * RECORD_ROW, p, s.tick)));
    } else if (op === 15) applySyncLog(s, r, out.subarray(at, at + len), r.stepping ? s.tick : s.tick + 1);
    else if (op === 10) s.players[out[at]!]!.charging = null;
    else if (op === 11) s.players[out[at]!]!.revealed = out[at + 1]!;
    else if (op === 12) {
      // `eliminate`'s first writes, in its order; the event takes the core's ID.
      const p = s.players[out[at]!]!, killedBy = out[at + 2]! >= 0 ? s.players[out[at + 2]!]! : null, kept = s.serial;
      p.status = 'eliminated';
      s.serial = out[at + 1]!; event(s, { kind: 'eliminated', target: participant(s, p), ...(killedBy ? { source: participant(s, killedBy) } : {}) }); s.serial = kept;
      p.charging = null;
      // A gladiator's death clears `input`, Node-owned (27, D4's table).
      if (!Number.isNaN(out[at + 3]!)) { p.status = 'respawning'; p.respawnAt = out[at + 3]!; p.input = {}; }
    } else if (op === 14) s.players[out[at]!]!.reload = null;
    else if (op === 13) {
      const p = s.players[out[at]!]!;
      p.kills = out[at + 1]!;
      if (!Number.isNaN(out[at + 2]!)) { p.level = out[at + 2]!; p.maxHp = out[at + 3]!; }
    }
    else throw new Error(`unknown phase 3 fact ${op}`);
    at += len;
  }
  if (out[11] === -101) throw new Error('Invalid item scatter counter');
  if (out[11] === -102) throw new Error('Item instance counter exhausted');
  if (out[11] === -103) throw new Error('Invalid carried item identity');
  if (out[11] === -104) throw new Error(`Unregistered item identity ${out[12]}`);
  if (out[11]! < 0) throw physicsRefusal(out[11]!, r.world.idOf(out[12]!));
  if (current) sawProjectiles(s, r);
  const records = options.player ? Array.from({ length: out[10]! }, (_, i) => ground(out, at + i * RECORD_ROW, options.player!, s.tick)) : [];
  return { resume: out[4]!, stage: out[5]!, plan: out[6] === 1 && mode >= 2 ? { records, itemSerial: allocation.itemSerial!, scatterSerial: allocation.scatterSerial!, allocation } : null };
}

/**
 * An elimination the core carried out inside phase 5's or the hazards' run (#1214 stage 6e.2): phase 3's output for it,
 * applied as `eliminateInCore` applied its call's. The core registered its allocations and synced its drops itself.
 */
export function applyElimination(s: Game, out: Float64Array, target: Player, killer: Player | null): void {
  const r = physicsRuntime(s);
  if (!r) throw new Error("phase 3 needs the game's physics world");
  applyOutput(s, r, out, { mode: MODE_ELIMINATE, options: { mode: MODE_ELIMINATE, player: target, killer }, source: s,
    itemOf: token => carriedItem(r, token)!, live: true });
}

export function phaseThree(s: Game, intents: readonly (ActionIntent | undefined)[]): void {
  let start = 0, stage = 0;
  for (;;) {
    const result = call(s, intents, { start, stage });
    if (result.resume < 0) return;
    start = result.resume; stage = result.stage;
  }
}
/** A contestant's attack outside the loop, for scenarios; a gladiator's is phase 5's (`phase-five.ts`). */
export function attackInCore(s: Game, player: Player): void {
  if (player.role === 'gladiator') throw new Error('a gladiator attacks in phase 5');
  call(s, [], { mode: 1, player });
}
/**
 * `eliminate` (`lifecycle.ts`) in the core: the lifecycle, each mandatory drop synced inside the run (#1214 stage 6e.2),
 * the reserves, then the kill credit, in one call.
 */
export function eliminateInCore(s: Game, player: Player, killer: Player | null): void {
  let stage = 0;
  for (;;) {
    const result = call(s, [], { mode: MODE_ELIMINATE, player, killer, stage });
    if (result.resume < 0) return;
    stage = result.stage;
  }
}
export function planDropInCore(s: Game, player: Player, item: InventoryItem, mandatory: boolean, items: readonly GroundItem[], source: Game): DropPlan | null {
  return call(s, [], { mode: 2, player, item, mandatory, items, source }).plan;
}
export function planAmmoInCore(s: Game, player: Player, family: AmmoFamily, count: number, mandatory: boolean): DropPlan | null {
  return call(s, [], { mode: 3, player, family, count, mandatory }).plan;
}
