import type { CoreExports } from '../core.ts';
import { AMMO_FAMILIES, EFFECT_KINDS, ITEM_KINDS, KITS, PLAYER_STATUSES, WEAPONS } from '../enum-tables.ts';
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
import { addItems, groundItem, itemsNear } from './ground-items.ts';
import { physicsRuntime, type PhysicsRuntime } from './physics-runtime.ts';
import { asSeenBy } from './rewind.ts';
import { sightOf } from './sight-runtime.ts';
import { launchPhysicalDrops } from './world-physics.ts';
import { start as profileStart, stop as profileStop } from '../profiler.ts';

// The phase's rules run in phase_three.rs. JavaScript owns records until 27's flip: this adapter
// packs only intent-bearing actors and the inventories the rules can change. Static rules cross
// once per world. Drops return at their synchronization boundary, keeping the admission chunked.
interface ActionsExports {
  actions_input(world: number, words: number): number;
  actions_configure(world: number): void;
  actions_run(world: number, collision: number, index: number, gates: number): number;
}
type Core = CoreExports & PhysicsExports & ActionsExports;
const OUT_HEADER = 13, PLAYER_ROW = 24, ITEM_ROW = 10, RECORD_ROW = 14;
const configured = new WeakMap<PhysicsWorld, Game['content']>();
const n = (value: number | null | undefined): number => typeof value === 'number' ? value : NaN;
const code = (values: readonly string[], value: string | undefined): number => value === undefined ? NaN : values.indexOf(value);

function configure(s: Game, r: PhysicsRuntime, core: Core, world: number): void {
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

function appendItem(data: number[], item: InventoryItem | null, token: number): void {
  if (!item) { data.push(-1, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 63); return; }
  const absent = ('ammo' in item && item.ammo !== undefined ? 0 : 1) | ('charge' in item && item.charge !== undefined ? 0 : 2)
    | (item.instanceId === undefined ? 4 : 0) | (item.lineageId === undefined ? 8 : 0) | (item.quality === undefined ? 16 : 0)
    | (item.kind === 'weapon' && item.weaponType !== undefined ? 0 : 32);
  data.push(code(ITEM_KINDS, item.kind) === -1 ? -2 : code(ITEM_KINDS, item.kind), item.kind === 'weapon' ? code(WEAPONS, item.weaponType) : NaN,
    item.kind === 'weapon' ? n(item.ammo) : NaN, item.kind === 'med' || item.kind === 'shield' ? n(item.count) : NaN,
    item.kind === 'cell' ? n(item.charge) : NaN, n(item.instanceId), n(item.lineageId), n(item.quality), token, absent);
}

/** Apply only writes, keeping the original carried objects through moves and stack merges. */
function putItem(item: InventoryItem, row: Float64Array, at: number): void {
  const put = (key: 'instanceId' | 'lineageId' | 'quality', value: number): void => {
    if (!Object.is(n(item[key]), value)) item[key] = value as ItemId;
  };
  put('instanceId', row[at + 5]!); put('lineageId', row[at + 6]!); put('quality', row[at + 7]!);
  if (item.kind === 'weapon' && !(row[at + 9]! & 1) && !Object.is(item.ammo, row[at + 2])) item.ammo = row[at + 2]!;
  else if ((item.kind === 'med' || item.kind === 'shield') && !Object.is(n(item.count), row[at + 3])) item.count = row[at + 3]!;
  else if (item.kind === 'cell' && !Object.is(n(item.charge), row[at + 4])) item.charge = row[at + 4]!;
}

/** New ground records keep the field insertion order of planDrop/planAmmoDrop (the frozen frames hash JSON). */
function ground(row: Float64Array, at: number, p: Player, tick: number): GroundItem {
  const kind = ITEM_KINDS[row[at]!]!, id = row[at + 10]! as ItemId, lineageId = row[at + 6]! as ItemId;
  const x = row[at + 11]!, y = row[at + 12]!;
  if (kind === 'ammo') return { kind, id, lineageId, family: AMMO_FAMILIES[row[at + 13]!]!, count: row[at + 3]!, x, y, droppedBy: p.id, pickupAfter: tick + HZ };
  return { kind, id, lineageId, ...(!Number.isNaN(row[at + 7]!) ? { quality: row[at + 7]! } : {}),
    ...(kind === 'weapon' ? { weaponType: WEAPONS[row[at + 1]!]!, ammo: row[at + 2]! }
      : kind === 'cell' ? { charge: row[at + 4]! } : { count: 1 }), x, y, droppedBy: p.id, pickupAfter: tick + HZ };
}

type Damage = (s: Game, target: Player, amount: number, source: Player | null) => void;
interface Options { mode?: number; player?: Player; item?: InventoryItem; family?: AmmoFamily; count?: number;
  mandatory?: boolean; items?: readonly GroundItem[]; source?: Game; start?: number; stage?: number; damage?: Damage }

function call(s: Game, intents: readonly (ActionIntent | undefined)[], options: Options = {}): { resume: number; stage: number; plan: DropPlan | null } {
  const r = physicsRuntime(s);
  if (!r) throw new Error('phase 3 needs the game\'s physics world');
  const native = r.world.boundaryCall(), core = native.core as Core, world = native.world;
  configure(s, r, core, world);
  const mode = options.mode ?? 0, source = options.source ?? s;
  const actors = options.player ? [options.player] : s.players.filter((_, i) => intents[i])
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const pool: InventoryItem[] = [], tokens = new Map<InventoryItem, number>();
  const token = (item: InventoryItem): number => {
    let t = tokens.get(item); if (t === undefined) { t = pool.length; tokens.set(item, t); pool.push(item); } return t;
  };
  const allocations: InventoryItem[] = [], droppers: Player[] = [];
  let allocationCount = 0, context = mode === 1, hearing = false, queries = mode === 1;
  for (const p of actors) {
    const intent = intents[playerIndex(s, p)], input = intent?.input;
    if (input?.moveSlot) { allocations.push(...p.inventory?.filter(i => i !== null) ?? []); allocationCount += p.inventory?.filter(i => i && i.instanceId === undefined).length ?? 0; }
    if (mode === 2 || mode === 3 || input?.drop || input?.dropAmmo || intent?.discardSlot !== undefined) {
      droppers.push(p); allocations.push(...p.inventory?.filter(i => i !== null) ?? []); allocationCount += 4; context = true; queries = true;
    }
    if (input?.skill && p.kit === 'specter' && p.cooldown <= 0) context = true;
    if ((mode === 1 || input?.attack || intent?.utilitySlot !== undefined) && p.role === 'contestant' && p.attackCd <= 0) { context = true; hearing = true; }
  }
  if (options.item) { allocations.push(options.item); allocationCount += 3; }
  const known = new Set<number>();
  for (const item of allocations) for (const id of [item.instanceId, item.lineageId]) if (id !== undefined) {
    try { itemLabel(source, id); known.add(id); } catch { /* An unknown identity is refused by the core after the search. */ }
  }
  // Registry membership, not a scan of the ground, supplies the free legacy label phases (D6).
  const phases: number[] = [];
  let phase = source.scatterSerial ?? 0;
  if (Number.isSafeInteger(phase) && phase >= 0) for (; phases.length < allocationCount && phase < Number.MAX_SAFE_INTEGER; phase++) {
    if (itemIdForLabel(source, `instance-${phase}`) === undefined) phases.push(phase);
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
  const hooks = actors.some(p => p.kit === 'hook' && intents[playerIndex(s, p)]?.input.skill) ? r.hooks : [];
  const data: number[] = [mode, options.start ?? 0, options.stage ?? 0, s.tick, s.serial, source.itemSerial ?? 1, source.scatterSerial ?? 0,
    items.length, Math.max(0, s.players.length - r.actors.size), actors.length, contexts.length, phases.length, known.size,
    near.size, groundIds.length, carried.length / 2, hooks.length, options.mandatory ? 1 : 0, code(AMMO_FAMILIES, options.family), n(options.count), 0];
  for (const p of actors) {
    const intent = intents[playerIndex(s, p)], input: PlayerInput = intent?.input ?? {};
    const inventory = options.item ? [options.item] : mode === 1 || mode === 2 || !!(input.slot !== undefined || input.moveSlot || intent?.utilitySlot !== undefined
      || input.drop || intent?.discardSlot !== undefined || input.reload || p.reload || input.attack && p.role === 'contestant' && p.attackCd <= 0) ? p.inventory : undefined;
    data.push(playerIndex(s, p), r.world.key(`actor:${p.id}`), p.role === 'contestant' ? 0 : 1, PLAYER_STATUSES.indexOf(p.status), KITS.indexOf(p.kit),
      p.x, p.y, p.heading, p.hp, p.maxHp, p.shield, n(p.selectedSlot), p.weapon, p.attackCd, p.cooldown, p.cloak, p.revealed, p.boost, p.stun, p.level,
      inventory?.length ?? -1, p.reserves ? 1 : 0, p.reload ? 1 : 0, 0);
    if (p.reserves) data.push(p.reserves.pistol, p.reserves.rifle, p.reserves.shell);
    if (p.reload) data.push(p.reload.slot, p.reload.instanceId, p.reload.until);
    for (const item of inventory ?? []) appendItem(data, item, item ? token(item) : NaN);
    data.push(n(input.aim), n(input.slot), n(input.moveSlot?.from), n(input.moveSlot?.to), n(intent?.utilitySlot), n(intent?.discardSlot), input.drop ? 1 : 0,
      code(AMMO_FAMILIES, input.dropAmmo?.family), n(input.dropAmmo?.count), input.reload ? 1 : 0, input.skill ? 1 : 0, input.attack ? 1 : 0,
      n(input.x), n(input.y), input.sneak ? 1 : 0);
  }
  const seen = mode === 1 && options.player?.role === 'gladiator' ? asSeenBy(s, options.player) : undefined;
  for (const p of contexts) {
    const at = seen?.(p) ?? p, cues = hearing ? p.heard ?? [] : [];
    data.push(playerIndex(s, p), p.role === 'contestant' ? 0 : 1, PLAYER_STATUSES.indexOf(p.status), at.x, at.y,
      s.content.actorPhysics.geometry[p.role].bodyRadius, r.world.key(`actor:${p.id}`), cues.length);
    for (const cue of cues) data.push(cue.x, cue.y, cue.tick, cue.until);
  }
  data.push(...phases, ...known);
  for (const item of near) data.push(item.x, item.y);
  data.push(...groundIds, ...carried);
  for (const hook of hooks) data.push(hook.casterIdx, r.world.key(hook.id), hook.id === `hook:${s.players[hook.casterIdx]?.id}` ? 1 : 0);
  // Interning and map preparation can grow memory; view the input only after those calls.
  const map = sightOf(s).queryHandles(s.map, queries);
  if (map.core !== core) throw new Error('phase 3 and sight are bound to different cores');
  const ptr = core.actions_input(world, data.length) >>> 0;
  new Float64Array(core.memory.buffer, ptr, data.length).set(data);
  if (mode === 0) profileStart('sim.actions.core');
  const outPtr = core.actions_run(world, map.collision, map.index, map.gates) >>> 0;
  if (mode === 0) profileStop('sim.actions.core');
  // Applying a drop synchronizes and can grow memory. Retain this call's facts across that boundary.
  const view = new Float64Array(core.memory.buffer, outPtr, new Float64Array(core.memory.buffer, outPtr, 1)[0]!);
  const out = mode === 1 || view[4]! >= 0 ? view.slice() : view;
  let at = OUT_HEADER;
  for (let i = 0; i < out[7]!; i++) {
    const row = at, p = s.players[out[row]!]!, invCount = out[row + 20]!, reserves = out[row + 21]!, reload = out[row + 22]!, retired = out[row + 23]!;
    at += PLAYER_ROW;
    if (mode < 2) {
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
    if (reserves) { if (mode < 2) for (let k = 0; k < 3; k++) p.reserves![AMMO_FAMILIES[k]!] = out[at + k]!; at += 3; }
    if (reload) {
      if (mode < 2 && (!p.reload || p.reload.slot !== out[at] || p.reload.instanceId !== out[at + 1] || p.reload.until !== out[at + 2]))
        p.reload = { slot: out[at]!, instanceId: out[at + 1]! as ItemId, until: out[at + 2]! };
      at += 3;
    } else if (mode < 2 && p.reload) p.reload = null;
    if (invCount >= 0) for (let k = 0; k < invCount; k++, at += ITEM_ROW) if (mode < 2) {
      const item = out[at] === -1 ? null : pool[out[at + 8]!]!;
      if (item) putItem(item, out, at);
      p.inventory![k] = item;
    }
    for (let k = 0; k < retired; k++, at += ITEM_ROW) if (mode < 2) putItem(pool[out[at + 8]!]!, out, at);
  }
  const allocation = mode >= 2 ? forkItemAllocation(source) : s;
  allocation.itemSerial = out[2]!; allocation.scatterSerial = out[3]!;
  allocation.itemIdentities ??= { ids: new Map(), labels: new Map() };
  for (let i = 0; i < out[8]!; i++, at += 2) {
    const id = out[at]! as ItemId, label = `instance-${out[at + 1]!}` as ItemLabel;
    allocation.itemIdentities.ids.set(label, id); allocation.itemIdentities.labels.set(id, label);
  }
  const logEnd = at + out[9]!;
  if (mode < 2) s.serial = out[1]!;
  while (at < logEnd) {
    const op = out[at]!, len = out[at + 1]!; at += 2;
    if (op === 1) s.effects.push({ id: out[at]!, x: out[at + 1]!, y: out[at + 2]!, kind: EFFECT_KINDS[out[at + 3]!]!, radius: out[at + 4]!, life: 12 });
    else if (op === 2) s.projectiles.push({ id: out[at]!, owner: s.players[out[at + 1]!]!.id, x: out[at + 2]!, y: out[at + 3]!, dx: out[at + 4]!, dy: out[at + 5]!, life: out[at + 6]!, damage: out[at + 7]! });
    else if (op === 3) {
      const p = s.players[out[at]!]!;
      if (!p.heard) Object.defineProperty(p, 'heard', { value: [], writable: true, configurable: true, enumerable: false });
      p.heard = Array.from({ length: out[at + 1]! }, (_, i) => ({ x: out[at + 2 + i * 4]!, y: out[at + 3 + i * 4]!, tick: out[at + 4 + i * 4]!, until: out[at + 5 + i * 4]! }));
    } else if (op === 4) options.damage!(s, s.players[out[at]!]!, out[at + 1]!, s.players[out[at + 2]!]!);
    else if (op === 5) { const caster = out[at]!; r.hooks = r.hooks.filter(h => !(h.casterIdx === caster && h.id === `hook:${s.players[caster]!.id}`)); }
    else if (op === 6) {
      const casterIdx = out[at]! as import('../types.ts').PlayerIdx, p = s.players[casterIdx]!;
      r.hooks.push({ id: `hook:${p.id}`, tetherId: r.identities.newTether(), casterIdx, x: p.x, y: p.y, dx: out[at + 2]!, dy: out[at + 3]!, travelled: 0,
        startedTick: s.tick, phase: 'flying', generationA: out[at + 1]! });
      r.hooks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    } else if (op === 7) r.world.adoptMotor(out[at]!, out[at + 1]!, out[at + 2]!, out[at + 3]!);
    else if (op === 8) { r.world.adoptCommit(out[at]!, out, at + 1); r.world.adoptQueue(out[at + len - 1]!); }
    else if (op === 9) {
      const p = s.players[out[at]!]!, records = Array.from({ length: out[at + 1]! }, (_, i) => ground(out, at + 2 + i * RECORD_ROW, p, s.tick));
      addItems(s, ...records); launchPhysicalDrops(s, records, p);
    } else if (op === 10) s.players[out[at]!]!.charging = null;
    else if (op === 11) s.players[out[at]!]!.revealed = out[at + 1]!;
    else throw new Error(`unknown phase 3 fact ${op}`);
    at += len;
  }
  if (out[11] === -101) throw new Error('Invalid item scatter counter');
  if (out[11] === -102) throw new Error('Item instance counter exhausted');
  if (out[11] === -103) throw new Error('Invalid carried item identity');
  if (out[11] === -104) throw new Error(`Unregistered item identity ${out[12]}`);
  if (out[11]! < 0) throw physicsRefusal(out[11]!, r.world.idOf(out[12]!));
  const records = options.player ? Array.from({ length: out[10]! }, (_, i) => ground(out, at + i * RECORD_ROW, options.player!, s.tick)) : [];
  return { resume: out[4]!, stage: out[5]!, plan: out[6] === 1 && mode >= 2 ? { records, itemSerial: allocation.itemSerial!, scatterSerial: allocation.scatterSerial!, allocation } : null };
}

export function phaseThree(s: Game, intents: readonly (ActionIntent | undefined)[], damage: Damage): void {
  let start = 0, stage = 0;
  for (;;) {
    const result = call(s, intents, { start, stage, damage });
    if (result.resume < 0) return;
    start = result.resume; stage = result.stage;
  }
}
/** Phase 5 shares the same attack while its damage/lifecycle owner remains in TypeScript until 5d. */
export function attackInCore(s: Game, player: Player, damage: Damage): void { call(s, [], { mode: 1, player, damage }); }
export function planDropInCore(s: Game, player: Player, item: InventoryItem, mandatory: boolean, items: readonly GroundItem[], source: Game): DropPlan | null {
  return call(s, [], { mode: 2, player, item, mandatory, items, source }).plan;
}
export function planAmmoInCore(s: Game, player: Player, family: AmmoFamily, count: number, mandatory: boolean): DropPlan | null {
  return call(s, [], { mode: 3, player, family, count, mandatory }).plan;
}
