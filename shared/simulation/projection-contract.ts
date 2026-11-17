// Closed field contracts for live frame projection. New simulation fields require deliberate opt-in.
// Iterate source keys so existing serialized field order and optional-field presence are preserved.
import type { DiscoveryMemory, HeardCue, Inventory, ItemKey, Player, Projected, PlayerIdx } from '../types.ts';
import type { BodyShape, PhysicsBodyView, PhysicsTetherView } from '../physics/types.ts';

const projection = (fields: string) => {
  const allowed = new Set(fields.split(' '));
  return <T extends object>(value: T): Projected<T> => {
    const result = {} as Projected<T>;
    for (const key of Object.keys(value) as (keyof T & string)[]) if (allowed.has(key)) result[key] = value[key];
    return result;
  };
};
// Exported so a wire schema reads its field lists from these declarations, not a second list (24.1).
export const FRAME_FIELDS = 'version duration cellChargeTicks tick phase hazardX slots';
export const frameFields = projection(FRAME_FIELDS);
export const OWN_FIELDS = 'x y hp maxHp shield keys weapon kills level status cooldown attackCd railCd cloak revealed boost stun heading lastSeq inputStalled inputMargin inventory selectedSlot reserves reload charging respawnAt cell nodeId discovered';
const ownFields = projection(OWN_FIELDS);
export const ITEM_FIELDS = 'id x y kind weaponType ammo charge count buildingId droppedBy pickupAfter nodeId tier instanceId lineageId quality family';
export const itemFields = projection(ITEM_FIELDS);
export const GATE_FIELDS = 'gateIdx open locked';
export const gateFields = projection(GATE_FIELDS);
export const TRAP_FIELDS = 'id kind x y homeX homeY heading offset cooldown spent aiming firing warning';
export const trapFields = projection(TRAP_FIELDS);
export const PROJECTILE_FIELDS = 'id owner trap x y dx dy life damage';
export const projectileFields = projection(PROJECTILE_FIELDS);
export const EFFECT_FIELDS = 'id x y kind radius life';
export const effectFields = projection(EFFECT_FIELDS);
export const EVENT_FIELDS = 'id tick kind actor target source slotsRemaining text';
const projectEvent = projection(EVENT_FIELDS);
export function eventFields(event: import('../types.ts').GameEvent) {
  const result = projectEvent(event);
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
export function physicsBodyFields(body: PhysicsBodyView, full = true): PhysicsBodyView {
  const { id, kind, x, y, angle, vx, vy, omega, sleeping, generation } = body;
  return { id, kind, shape: physicsShapeFields(body.shape), x, y, angle,
    ...(full ? { vx, vy, omega, sleeping } : {}), generation,
    owner: body.owner.kind === 'actor' ? { kind: 'actor', playerIdx: body.owner.playerIdx }
      : body.owner.kind === 'item' ? { kind: 'item', itemId: body.owner.itemId } : { kind: 'prop', propId: body.owner.propId },
    ...(body.discontinuity === 'placed' ? { discontinuity: 'placed' as const } : {}) };
}
export function physicsTetherFields({ id, a, b }: PhysicsTetherView): PhysicsTetherView { return { id, a, b }; }
export function physicsHookFlightFields({ id, a, casterIdx, x, y }: import('../physics/types.ts').NumericHookFlight) {
  return { id, a, casterIdx, x, y };
}
export function ownPlayerFields<I extends ItemKey>(player: Player<I>, discovery?: DiscoveryMemory | null, heard?: HeardCue[], playerIdx?: PlayerIdx): Projected<Player<I>> {
  const result = ownFields(player);
  if (playerIdx !== undefined) result.playerIdx = playerIdx;
  // Carried items are projected through the same item contract; both sides are wire records.
  if (Array.isArray(result.inventory)) result.inventory = result.inventory.map(item => item ? itemFields(item) : item) as Inventory<I>;
  if (result.cell) result.cell = itemFields(result.cell);
  if (discovery) result.discovered = Array.from(discovery.discovered);
  // Heard gunfire is the hearer's own (15): present only while a cue lasts, so other contents' frames are unchanged.
  if (heard?.length) result.heard = heard.map(({ x, y, tick, until }) => ({ x, y, tick, until }));
  return result;
}
