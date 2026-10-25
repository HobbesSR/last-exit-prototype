// Closed field contracts for live frame projection. New simulation fields require deliberate opt-in.
// Iterate source keys so existing serialized field order and optional-field presence are preserved.
import type { DiscoveryMemory, Inventory, Player, Projected } from '../types.ts';
import type { BodyShape, PhysicsBodyView, PhysicsTetherView } from '../physics/types.ts';

const projection = (fields: string) => {
  const allowed = new Set(fields.split(' '));
  return <T extends object>(value: T): Projected<T> => {
    const result = {} as Projected<T>;
    for (const key of Object.keys(value) as (keyof T & string)[]) if (allowed.has(key)) result[key] = value[key];
    return result;
  };
};
export const frameFields = projection('version duration cellChargeTicks tick phase hazardX slots players items gates traps projectiles effects events');
const ownFields = projection('id name role kit x y hp maxHp shield keys weapon kills level status cooldown attackCd railCd cloak revealed boost stun heading lastSeq inputStalled inventory selectedSlot charging respawnAt cell nodeId discovered');
export const itemFields = projection('id x y kind weaponType ammo charge count buildingId droppedBy pickupAfter nodeId tier instanceId lineageId quality');
export const gateFields = projection('id x y w h open locked kind buildingId');
export const trapFields = projection('id kind x y homeX homeY heading offset cooldown spent aiming firing warning');
export const projectileFields = projection('id owner trap x y dx dy life damage');
export const effectFields = projection('id x y kind radius life');
export const eventFields = projection('id tick text');
// Physics display records use the same closed boundary as other live fields, including nested shapes.
export function physicsShapeFields(shape: BodyShape): BodyShape {
  if (shape.kind === 'circle') return { kind: 'circle', radius: shape.radius };
  if (shape.kind === 'box') return { kind: 'box', hx: shape.hx, hy: shape.hy };
  return { kind: 'convex', vertices: shape.vertices.map(({ x, y }) => ({ x, y })) };
}
export function physicsBodyFields(body: PhysicsBodyView, full = true): PhysicsBodyView {
  const { id, kind, x, y, angle, vx, vy, omega, sleeping, generation } = body;
  return { id, kind, shape: physicsShapeFields(body.shape), x, y, angle,
    ...(full ? { vx, vy, omega, sleeping } : {}), generation,
    ...(body.actorId !== undefined ? { actorId: body.actorId } : {}),
    ...(body.itemId !== undefined ? { itemId: body.itemId } : {}),
    ...(body.discontinuity === 'placed' ? { discontinuity: 'placed' as const } : {}) };
}
export function physicsTetherFields({ id, a, b }: PhysicsTetherView): PhysicsTetherView { return { id, a, b }; }
export function physicsHookFlightFields({ id, a, x, y }: { id: string; a: string; x: number; y: number }) {
  return { id, a, x, y };
}
export function ownPlayerFields(player: Player, discovery?: DiscoveryMemory | null): Projected<Player> {
  const result = ownFields(player);
  // Carried items are projected through the same item contract; both sides are wire records.
  if (Array.isArray(result.inventory)) result.inventory = result.inventory.map(item => item ? itemFields(item) : item) as Inventory;
  if (result.cell) result.cell = itemFields(result.cell);
  if (discovery) result.discovered = Array.from(discovery.discovered);
  return result;
}
