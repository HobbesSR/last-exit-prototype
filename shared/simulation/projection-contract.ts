// Closed field contracts for live frame projection. New simulation fields require deliberate opt-in.
// Iterate source keys so existing serialized field order and optional-field presence are preserved.
import type { HeardCue, Inventory, ItemKey, Player, Projected, PlayerIdx } from '../types.ts';
import type { BodyShape, PhysicsBodyView, PhysicsTetherView } from '../physics/types.ts';
import { mapIdField, wireCache, wireIds, type WireIdDomain, type WireIds } from './wire-ids.ts';

/**
 * Outward fields holding an ID from a match-wide counter (#1164, 24.4), each with the counter (domain) it
 * comes from: bodies, tethers, items and `s.serial`. The one list: each projection below maps exactly
 * these through the match's keyed one-to-one function for that domain (wire-ids.ts), and the property
 * test walks them. `playerIdx`, `gateIdx` and `propId` are dense or authored slots, not counters, and are
 * never mapped.
 */
export const WIRE_ID_FIELDS = {
  item: { id: 'item' },
  body: { id: 'body' },
  bodyOwner: { itemId: 'item' },
  tether: { id: 'tether', a: 'body', b: 'body' },
  hookFlight: { id: 'tether', a: 'body' },
  projectile: { id: 'serial' },
  effect: { id: 'serial' },
  event: { id: 'serial' },
} as const satisfies Record<string, Record<string, WireIdDomain>>;
type IdFields = readonly (readonly [string, WireIdDomain])[];
const idList = (fields: Readonly<Record<string, WireIdDomain>>): IdFields => Object.entries(fields);
const IDENTITY = wireIds();
const mapIds = (record: Record<string, unknown>, fields: IdFields, wire: WireIds) => {
  if (!wire.identity) for (const [field, domain] of fields) mapIdField(record, field, domain, wire);
};

const projection = (fields: string, ids?: Readonly<Record<string, WireIdDomain>>) => {
  const allowed = new Set(fields.split(' ')), idFields = ids ? idList(ids) : [];
  return <T extends object>(value: T, wire: WireIds = IDENTITY): Projected<T> => {
    const result = {} as Projected<T>;
    for (const key of Object.keys(value) as (keyof T & string)[]) if (allowed.has(key)) result[key] = value[key];
    mapIds(result as Record<string, unknown>, idFields, wire);
    return result;
  };
};
// Exported so a wire schema reads its field lists from these declarations, not a second list (24.1).
// Match constants (`version`, `duration`, `cellChargeTicks`) stay in snapshots and recordings, but not in frames:
// a client has them from its welcome or ready, and the content descriptor (24.3 proposal 3, #1131).
export const FRAME_FIELDS = 'tick phase hazardX slots';
export const frameFields = projection(FRAME_FIELDS);
/** The viewer's own fields apart from the pose, which an actor with a body carries there only (24.4). */
export const OWN_STATE_FIELDS = 'hp maxHp shield keys weapon kills level status cooldown railCd cloak revealed boost stun heading lastSeq inputStalled inputMargin inventory selectedSlot reserves reload charging respawnAt discovered';
/** Optional own fields the engine holds as `null` for none; a projection omits them instead (24.3 proposal 6). */
const ABSENT_WHEN_NONE = ['reload', 'charging', 'respawnAt'] as const;
export const OWN_FIELDS = `x y ${OWN_STATE_FIELDS}`;
const ownFields = projection(OWN_FIELDS);
// An actor with a body carries its pose there only (24.4): built without it rather than copied again (#1163).
const ownFieldsWithoutPose = projection(OWN_STATE_FIELDS);
// What one client may learn about another player it can currently see (visibility.ts `observed`, which adds
// `playerIdx` and, for a player without a body, `x` and `y`). Everything omitted is either private (inventory,
// ability timers, whether a slot is a bot) or unread by the renderer, so it never leaves the server for anyone
// but the player it describes. Recordings keep the full state.
export const OBSERVED = ['heading', 'status', 'hp', 'maxHp', 'shield', 'weapon', 'cloak', 'revealed'] as const;
// Fields without a reader are added when something uses them (Corey, 17.4 #17): `droppedBy`, `pickupAfter`,
// `nodeId`, `instanceId` and `lineageId` left in #1131 stage 3.
export const ITEM_FIELDS = 'id x y kind weaponType ammo charge count buildingId tier quality family';
export const itemFields = projection(ITEM_FIELDS, WIRE_ID_FIELDS.item);
export const GATE_FIELDS = 'gateIdx open locked';
export const gateFields = projection(GATE_FIELDS);
export const TRAP_FIELDS = 'id kind x y homeX homeY heading offset cooldown spent aiming firing warning';
export const trapFields = projection(TRAP_FIELDS);
export const PROJECTILE_FIELDS = 'id owner trap x y dx dy life damage';
export const projectileFields = projection(PROJECTILE_FIELDS, WIRE_ID_FIELDS.projectile);
export const EFFECT_FIELDS = 'id x y kind radius life';
export const effectFields = projection(EFFECT_FIELDS, WIRE_ID_FIELDS.effect);
export const EVENT_FIELDS = 'id tick kind actor target source slotsRemaining text';
const projectEvent = projection(EVENT_FIELDS, WIRE_ID_FIELDS.event);
export function eventFields(event: import('../types.ts').GameEvent, wire: WireIds = IDENTITY) {
  const result = projectEvent(event, wire);
  for (const key of ['actor', 'target', 'source'] as const) {
    const participant = (result as Record<string, unknown>)[key] as import('../types.ts').EventParticipant | undefined;
    if (participant) (result as Record<string, unknown>)[key] = { playerIdx: participant.playerIdx, name: participant.name };
  }
  return result;
}
// Physics display records use the same closed boundary as other live fields, including nested shapes.
function physicsShapeFields(shape: BodyShape): BodyShape {
  if (shape.kind === 'circle') return { kind: 'circle', radius: shape.radius };
  if (shape.kind === 'box') return { kind: 'box', hx: shape.hx, hy: shape.hy };
  return { kind: 'convex', vertices: shape.vertices.map(({ x, y }) => ({ x, y })) };
}
const BODY_IDS = idList(WIRE_ID_FIELDS.body), BODY_OWNER_IDS = idList(WIRE_ID_FIELDS.bodyOwner);
const TETHER_IDS = idList(WIRE_ID_FIELDS.tether), FLIGHT_IDS = idList(WIRE_ID_FIELDS.hookFlight);
export function physicsBodyFields(body: PhysicsBodyView, full = true, wire: WireIds = IDENTITY): PhysicsBodyView {
  const { id, kind, x, y, angle, vx, vy, generation } = body;
  const owner = body.owner.kind === 'actor' ? { kind: 'actor' as const, playerIdx: body.owner.playerIdx }
    : body.owner.kind === 'item' ? { kind: 'item' as const, itemId: body.owner.itemId } : { kind: 'prop' as const, propId: body.owner.propId };
  const result: PhysicsBodyView = { id, kind, shape: physicsShapeFields(body.shape), x, y, angle,
    // Velocity for bodies the viewer predicts; angular velocity and sleep had no reader (#1131 stage 3, 17.4 #17).
    ...(full ? { vx, vy } : {}), generation, owner,
    ...(body.discontinuity === 'placed' ? { discontinuity: 'placed' as const } : {}) };
  mapIds(result as unknown as Record<string, unknown>, BODY_IDS, wire);
  mapIds(owner as Record<string, unknown>, BODY_OWNER_IDS, wire);
  return result;
}
export function physicsTetherFields({ id, a, b }: PhysicsTetherView, wire: WireIds = IDENTITY): PhysicsTetherView {
  const result = { id, a, b };
  mapIds(result as unknown as Record<string, unknown>, TETHER_IDS, wire);
  return result;
}
export function physicsHookFlightFields({ id, a, casterIdx, x, y }: import('../physics/types.ts').NumericHookFlight, wire: WireIds = IDENTITY) {
  const result = { id, a, casterIdx, x, y };
  mapIds(result as unknown as Record<string, unknown>, FLIGHT_IDS, wire);
  return result;
}
export function ownPlayerFields<I extends ItemKey>(player: Player<I>, discovery?: { discovered: Iterable<number> } | null, heard?: readonly HeardCue[], playerIdx?: PlayerIdx, wire: WireIds = IDENTITY, posed = true): Projected<Player<I>> {
  const result = (posed ? ownFields : ownFieldsWithoutPose)(player);
  if (playerIdx !== undefined) result.playerIdx = playerIdx;
  // Carried items are projected through the same item contract; both sides are wire records.
  if (Array.isArray(result.inventory)) result.inventory = result.inventory.map(item => item ? itemFields(item, wire) : item) as Inventory<I>;
  // The reloading slot names the item; its instance identity left with the item's (#1131 stage 3).
  if (result.reload) result.reload = { slot: result.reload.slot, until: result.reload.until } as typeof result.reload;
  for (const key of ABSENT_WHEN_NONE) if (result[key] === null) delete result[key];
  if (discovery) result.discovered = Array.from(discovery.discovered);
  // Heard gunfire is the hearer's own (15): present only while a cue lasts, so other contents' frames are unchanged.
  if (heard?.length) result.heard = heard.map(({ x, y, tick, until }) => ({ x, y, tick, until }));
  return result;
}

/**
 * A map payload's item list as a client is sent it: each record through the item contract, as frames carry
 * it, with its outward IDs (#1164). The engine's other item fields stay with the server and its recordings
 * (#1131 stage 3). Records and lists are cached per source and per mapping, so an unchanged ground projects
 * nothing again and frozen sources yield frozen, reusable records whose JSON the published-list cache keeps.
 */
export function wireItemRecords<T extends object>(list: readonly T[], wire: WireIds): readonly T[] {
  const lists = wireCache<readonly T[], readonly T[]>(wire, 'itemLists');
  let mapped = lists.get(list);
  if (!mapped) {
    const records = wireCache<T, T>(wire, 'itemRecords');
    mapped = list.map(item => {
      let record = records.get(item);
      if (!record) {
        record = itemFields(item, wire) as T;
        if (Object.isFrozen(item)) { Object.freeze(record); records.set(item, record); }
      }
      return record;
    });
    lists.set(list, mapped);
  }
  return mapped;
}
