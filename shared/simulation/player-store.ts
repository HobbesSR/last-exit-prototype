import { AMMO_FAMILIES, ITEM_KINDS, KITS, PLAYER_STATUSES, WEAPONS } from '../enum-tables.ts';
import type { CoreExports } from '../core.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game, InventoryItem, Player } from '../types.ts';

// The core's player store (`rust/core/src/players.rs`, #1214, docs/27 "The state flip", step 6c). Phase 1 (6c.2),
// phase 5's combat and phase 6's environment and traps (6c.1) read the players from it rather than from rows of their
// own. Every write to its fields inside a tick reaches it too (6c.2): the core's runs write it as they report their
// writes, and phase 4's poses are written from the step (`players_after_step`). So it is uploaded once a tick, by phase
// 1, and before a converted call between ticks, where tests, tools and the between-tick commands write the records.

type StoreExports = Pick<CoreExports, 'memory' | 'players_input' | 'players_load'>;
const n = (value: number | null | undefined): number => typeof value === 'number' ? value : NaN;
const code = (values: readonly string[], value: string | undefined): number => value === undefined ? NaN : values.indexOf(value);

/** A carried item's ten words (`action_types::Item`), or an empty slot's, with the call's `token`. Phases 3 and 6 pack the same. */
export function appendItem(data: number[], item: InventoryItem | null, token: number): void {
  if (!item) { data.push(-1, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 63); return; }
  const absent = ('ammo' in item && item.ammo !== undefined ? 0 : 1) | ('charge' in item && item.charge !== undefined ? 0 : 2)
    | (item.instanceId === undefined ? 4 : 0) | (item.lineageId === undefined ? 8 : 0) | (item.quality === undefined ? 16 : 0)
    | (item.kind === 'weapon' && item.weaponType !== undefined ? 0 : 32);
  data.push(code(ITEM_KINDS, item.kind) === -1 ? -2 : code(ITEM_KINDS, item.kind), item.kind === 'weapon' ? code(WEAPONS, item.weaponType) : NaN,
    item.kind === 'weapon' ? n(item.ammo) : NaN, item.kind === 'med' || item.kind === 'shield' ? n(item.count) : NaN,
    item.kind === 'cell' ? n(item.charge) : NaN, n(item.instanceId), n(item.lineageId), n(item.quality), token, absent);
}

/**
 * The carried records the core's tokens name (#1214 stage 6c.3c.2), per runtime: a token is a record's index. Each upload
 * numbers the carried records in roster and slot order; a new record the core reports is filed with `adoptCarried` in the
 * order the adapter builds it, which is the order the store gives new items their tokens (`players::put_items`); a
 * swap's clone takes its original's token (`replaceCarried`). Phases 3 and 6 name carried records by these tokens.
 */
interface CarriedTable { items: InventoryItem[]; tokens: Map<InventoryItem, number> }
const tables = new WeakMap<PhysicsRuntime, CarriedTable>();
const tableOf = (r: PhysicsRuntime): CarriedTable => {
  let table = tables.get(r);
  if (!table) tables.set(r, table = { items: [], tokens: new Map() });
  return table;
};
/** A carried record's token, or undefined for one the store does not hold. */
export const carriedToken = (r: PhysicsRuntime, item: InventoryItem): number | undefined => tableOf(r).tokens.get(item);
/** The carried record a token names. */
export const carriedItem = (r: PhysicsRuntime, token: number): InventoryItem | undefined => tableOf(r).items[token];
/** File a new carried record under the next token, as the store gives the new item it. */
export function adoptCarried(r: PhysicsRuntime, item: InventoryItem): void {
  const table = tableOf(r);
  table.tokens.set(item, table.items.length); table.items.push(item);
}
/** A swap's clone takes its original's token. */
export function replaceCarried(r: PhysicsRuntime, token: number, item: InventoryItem): void {
  const table = tableOf(r), old = table.items[token];
  if (old) table.tokens.delete(old);
  table.items[token] = item; table.tokens.set(item, token);
}

/**
 * Each player's equipment, in roster order, as `players::EQUIP_HEAD` and the item rows lay it out: selection, weapon,
 * keys, charging (the charger's index, -1 none, -2 unknown), the inventory, reserves and reload. Each item's token is
 * `token`'s, -2 for a record it does not know.
 */
function packEquipment(s: Game, token: (item: InventoryItem) => number | undefined): number[] {
  const out: number[] = [], chargers = s.map.chargers;
  for (const p of s.players) {
    const charging = !p.charging ? -1 : chargers.findIndex(c => c.id === p.charging);
    const inventory = p.inventory, reserves = p.reserves, reload = p.reload;
    out.push(n(p.selectedSlot), p.weapon, n(p.keys), charging === -1 && p.charging ? -2 : charging, inventory ? inventory.length : -1,
      reserves ? 1 : 0, ...reserves ? AMMO_FAMILIES.map(f => reserves[f]) : [0, 0, 0],
      reload ? 1 : 0, ...reload ? [reload.slot, reload.instanceId, reload.until] : [0, 0, 0]);
    for (const item of inventory ?? []) appendItem(out, item as InventoryItem | null, item ? token(item) ?? -2 : NaN);
  }
  return out;
}

/** Each player's rank in ID order, which is `ordered(s)`'s. */
export function idRanks(s: Game): number[] {
  const players = s.players, ranks = new Array<number>(players.length);
  players.map((_, i) => i).sort((a, b) => players[a]!.id < players[b]!.id ? -1 : players[a]!.id > players[b]!.id ? 1 : 0)
    .forEach((idx, rank) => { ranks[idx] = rank; });
  return ranks;
}

/** Words in a player's fields (`combat::PLAYER_ROW`). */
export const PLAYER_ROW = 15;
/** Words per player uploaded (`players::STORE_ROW`): the fields, `movedThisTick`, then `players::Extra`. */
const STORE_ROW = PLAYER_ROW + 1 + 8;
/** Words of a player's equipment header (`players::EQUIP_HEAD`), and per carried item (`players::ITEM_ROW`). */
const EQUIP_HEAD = 13, ITEM_ROW = 10;
const num = (value: number | null | undefined): number => value ?? NaN;

/** Write a player's fields (`combat::Row`) at `at`; returns where they end. */
function putPlayerRow(data: Float64Array, at: number, p: Player, rank: number): number {
  data[at] = p.role === 'contestant' ? 0 : 1; data[at + 1] = PLAYER_STATUSES.indexOf(p.status); data[at + 2] = KITS.indexOf(p.kit);
  data[at + 3] = p.x; data[at + 4] = p.y; data[at + 5] = p.heading; data[at + 6] = p.hp; data[at + 7] = p.maxHp; data[at + 8] = p.shield;
  data[at + 9] = p.level; data[at + 10] = p.cooldown; data[at + 11] = p.attackCd; data[at + 12] = p.stun; data[at + 13] = rank;
  data[at + 14] = p.viewLagTicks ?? 0;
  return at + PLAYER_ROW;
}

/** Whether a converted call must upload first: only between ticks, since inside one every write reaches the store. */
export const playersStale = (r: PhysicsRuntime): boolean => !r.stepping;

/** Pack every player in the upload's layout into `data`, in roster order. */
function packPlayers(s: Game, keys: readonly number[], data: Float64Array): void {
  const players = s.players, ranks = idRanks(s), stations = s.map.stations;
  for (let i = 0, at = 0; i < players.length; i++) {
    const p = players[i]!;
    at = putPlayerRow(data, at, p, ranks[i]!);
    data[at++] = p.movedThisTick ?? 0;
    // `players::Extra`, as phase 1 packed it before stage 6c.2.
    data[at++] = num(p.respawnAt); data[at++] = num(p.transit?.arriveAt);
    data[at++] = p.transit ? stations.findIndex(st => st.id === p.transit!.to) : -1;
    data[at++] = num(p.railCd); data[at++] = num(p.cloak); data[at++] = num(p.revealed); data[at++] = num(p.boost);
    data[at++] = keys[i]!;
  }
}

/**
 * Where the core's store differs from a fresh upload of the records, as `player.field: store != record` lines; empty when
 * they agree. For tests: after a tick, every write must have reached both.
 */
export function storeDrift(s: Game, r: PhysicsRuntime): string[] {
  const { core, world } = r.world.boundaryCall();
  // The tokens are the table's, so a store item that names another record than the one in the slot shows as drift.
  const keys = s.players.map(p => r.world.key(`actor:${p.id}`)), equipment = packEquipment(s, item => carriedToken(r, item));
  const fixed = s.players.length * STORE_ROW;
  const fresh = new Float64Array(fixed + equipment.length);
  packPlayers(s, keys, fresh);
  fresh.set(equipment, fixed);
  if (core.players_count(world) !== s.players.length) return [`the store holds ${core.players_count(world)} players, the roster ${s.players.length}`];
  const dumped = core.players_dump(world) >>> 0;
  const kept = new Float64Array(core.memory.buffer, dumped, fresh.length);
  const out: string[] = [];
  for (let k = 0; k < fixed; k++) if (!Object.is(kept[k], fresh[k]))
    out.push(`${s.players[Math.floor(k / STORE_ROW)]!.id}.${FIELDS[k % STORE_ROW]}: ${kept[k]} != ${fresh[k]}`);
  // The equipment as a whole per player: its words differ in length when an inventory does.
  for (let at = fixed, i = 0; at < fresh.length; i++) {
    const words = EQUIP_HEAD + Math.max(0, fresh[at + 4]!) * ITEM_ROW;
    const a = Array.from(kept.subarray(at, at + words)), b = Array.from(fresh.subarray(at, at + words));
    if (a.some((v, k) => !Object.is(v, b[k]))) out.push(`${s.players[i]!.id}.equipment: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    at += words;
  }
  return out;
}
const FIELDS = ['role', 'status', 'kit', 'x', 'y', 'heading', 'hp', 'maxHp', 'shield', 'level', 'cooldown', 'attackCd', 'stun', 'rank',
  'viewLagTicks', 'movedThisTick', 'respawnAt', 'arriveAt', 'destination', 'railCd', 'cloak', 'revealed', 'boost', 'key'];

/**
 * Upload every player to the world's store, in roster order. Call it before any other input of the call is viewed: the
 * actors' world keys are interned first, which can grow the memory.
 */
export function uploadPlayers(s: Game, r: PhysicsRuntime, core: StoreExports, world: number): void {
  const players = s.players, table = tableOf(r);
  // The upload numbers the carried records afresh, in roster and slot order.
  table.items.length = 0; table.tokens.clear();
  for (const p of players) for (const item of p.inventory ?? []) if (item) adoptCarried(r, item as InventoryItem);
  const keys = players.map(p => r.world.key(`actor:${p.id}`)), equipment = packEquipment(s, item => carriedToken(r, item));
  const fixed = players.length * STORE_ROW;
  // Resizing the upload can grow the memory, so the view is made from the buffer after the call.
  const pointer = core.players_input(world, fixed + equipment.length) >>> 0;
  const data = new Float64Array(core.memory.buffer, pointer, fixed + equipment.length);
  packPlayers(s, keys, data);
  data.set(equipment, fixed);
  core.players_load(world, players.length);
}
