import { AMMO_FAMILIES, ITEM_KINDS, WEAPONS } from '../enum-tables.ts';
import { itemLabel } from '../item-instances.ts';
import { attachGroundSink } from './ground-items.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import { playerById, playerIndex } from './relations.ts';
import type { Game, GroundItem, ItemId, PlayerId } from '../types.ts';

// The core's ground store (`rust/core/src/ground.rs`, #1214, docs/27 "The state flip", step 6d.1). Node's ground helpers
// (`ground-items.ts`) write each change through as they make it, so a tick pays only for its own changes. The whole
// list is uploaded only when it changed without them: when the store has not seen the list it starts from, as after
// match setup, a test that replaces `s.items` or edits it raw, or `groundList`. The readers still pack the records they
// need until 6d.2. Until 6e the records stay Node's, so the store follows Node's writes rather than the reverse.

/** Words per record (`ground::RECORD`). */
const RECORD = 16;
const ABSENT = { ammo: 1, charge: 2, instanceId: 4, lineageId: 8, quality: 16, weaponType: 32, count: 64, family: 128, droppedBy: 256, pickupAfter: 512 } as const;
const n = (value: unknown): number => typeof value === 'number' ? value : NaN;

/** Each world's body keys for ground records, so a label is interned once. */
const keys = new WeakMap<PhysicsRuntime, Map<ItemId, number>>();
/** A record's body key (`item:<label>`), interned once; NaN when the identity has no label. */
export function keyOf(s: Game, r: PhysicsRuntime, id: ItemId): number {
  let byId = keys.get(r);
  if (!byId) keys.set(r, byId = new Map());
  let key = byId.get(id);
  if (key === undefined) {
    let label: string | undefined;
    try { label = itemLabel(s, id); } catch { label = undefined; }
    key = label === undefined ? NaN : r.world.key(`item:${label}`);
    byId.set(id, key);
  }
  return key;
}

/** A record's words (`ground::RECORD`). */
function pack(s: Game, r: PhysicsRuntime, item: GroundItem, out: Float64Array, at: number): void {
  const absent = (item.ammo == null ? ABSENT.ammo : 0) | (item.charge == null ? ABSENT.charge : 0) | (item.instanceId == null ? ABSENT.instanceId : 0)
    | (item.lineageId == null ? ABSENT.lineageId : 0) | (item.quality == null ? ABSENT.quality : 0) | (item.weaponType == null ? ABSENT.weaponType : 0)
    | (item.count == null ? ABSENT.count : 0) | (item.family == null ? ABSENT.family : 0) | (item.droppedBy == null ? ABSENT.droppedBy : 0)
    | (item.pickupAfter == null ? ABSENT.pickupAfter : 0);
  const kind = ITEM_KINDS.indexOf(item.kind as typeof ITEM_KINDS[number]);
  const dropper = item.droppedBy == null ? undefined : playerById(s, item.droppedBy as PlayerId);
  out[at] = n(item.id); out[at + 1] = keyOf(s, r, item.id); out[at + 2] = item.x; out[at + 3] = item.y;
  out[at + 4] = kind === -1 ? -2 : kind; out[at + 5] = item.weaponType == null ? NaN : WEAPONS.indexOf(item.weaponType);
  out[at + 6] = n(item.ammo); out[at + 7] = n(item.count); out[at + 8] = n(item.charge);
  out[at + 9] = item.family == null ? -1 : AMMO_FAMILIES.indexOf(item.family); out[at + 10] = n(item.instanceId);
  out[at + 11] = n(item.lineageId); out[at + 12] = n(item.quality);
  out[at + 13] = item.droppedBy == null ? -2 : dropper ? playerIndex(s, dropper) : -1; out[at + 14] = n(item.pickupAfter); out[at + 15] = absent;
}

/** Pack `items` into the store's input, interning their keys first, since interning can grow the memory. */
function input(s: Game, r: PhysicsRuntime, items: readonly GroundItem[]): void {
  for (const item of items) keyOf(s, r, item.id);
  const { core, world } = r.world.boundaryCall();
  const pointer = core.ground_input(world, items.length) >>> 0;
  const words = new Float64Array(core.memory.buffer, pointer, items.length * RECORD);
  for (let i = 0; i < items.length; i++) pack(s, r, items[i]!, words, i * RECORD);
}

/** The list each world's store matches, and its length then. */
const seen = new WeakMap<PhysicsRuntime, { list: readonly GroundItem[]; length: number }>();
const matches = (r: PhysicsRuntime, list: readonly GroundItem[]): boolean => {
  const last = seen.get(r);
  return last !== undefined && last.list === list && last.length === list.length;
};
function saw(s: Game, r: PhysicsRuntime): void { seen.set(r, { list: s.items, length: s.items.length }); }

/** Upload the whole ground list. */
function upload(s: Game, r: PhysicsRuntime): void {
  input(s, r, s.items);
  const { core, world } = r.world.boundaryCall();
  core.ground_write(world, 0, 0);
  saw(s, r);
}

/** Make the world's store match the live list: an upload when the list changed without the helpers. */
export function ensureGround(s: Game, r: PhysicsRuntime): void {
  if (!matches(r, s.items)) upload(s, r);
}

/**
 * Write the ground helpers' changes through to the game's store. `createGame` calls it once the world exists; the
 * store starts from the list as setup left it.
 */
export function ownGround(s: Game): void {
  const r = physicsRuntime(s);
  if (!r) throw new Error('the ground store needs the game\'s physics world');
  upload(s, r);
  // Each write applies to the list it started from; a store that had not seen that list takes the result whole.
  const write = (before: readonly GroundItem[], beforeLength: number, through: () => void): void => {
    const last = seen.get(r);
    if (last?.list === before && last.length === beforeLength) through();
    else upload(s, r);
    saw(s, r);
  };
  attachGroundSink(s, {
    add: (before, length, items) => write(before, length, () => {
      input(s, r, items);
      const { core, world } = r.world.boundaryCall();
      core.ground_write(world, 1, 0);
    }),
    remove: (before, length, at) => write(before, length, () => {
      const { core, world } = r.world.boundaryCall();
      core.ground_write(world, 2, at);
    }),
    replace: (before, length, at, next) => write(before, length, () => {
      input(s, r, [next]);
      const { core, world } = r.world.boundaryCall();
      core.ground_write(world, 3, at);
    }),
    // The core added these records itself (#1214 stage 6d.6b): its store already holds them.
    adopted: (before, length) => write(before, length, () => undefined),
    edited: () => seen.delete(r),
  });
}
