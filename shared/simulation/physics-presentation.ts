import type { PhysicsBodyView, PhysicsGameplayState, PhysicsTetherView } from '../physics/types.ts';
import type { Snapshot, Player, Vec2 } from '../types.ts';
import { physicsBodyFields, physicsTetherFields } from './projection-contract.ts';
import { bodyRadius } from '../physics/presentation-geometry.ts';

/** Capture once, alongside private gameplay state. Complete lists express spawn/removal at each tick. */
export function capturePhysicsPresentation(physics: PhysicsGameplayState, frame: Pick<Snapshot, 'players' | 'items'>) {
  const actors = new Map(frame.players.map(p => [`actor:${p.id}`, p.id]));
  // Physical loot uses this reserved association when P5 admits it. Ordinary loot has no body.
  const items = new Map(frame.items.map(item => [`item:${item.id}`, item.id]));
  const placed = new Set(physics.discontinuities?.filter(d => d.kind === 'placed').map(d => d.id));
  const bodies: PhysicsBodyView[] = physics.world.bodies.filter(b => b.spec.kind !== 'static'
    && (b.spec.kind !== 'actor' || actors.has(b.spec.id))
    && (!b.spec.id.startsWith('item:') || items.has(b.spec.id))).map(b => physicsBodyFields({
    id: b.spec.id, kind: b.spec.kind as 'actor' | 'prop', shape: b.spec.shape, ...b.transform, generation: b.generation,
    ...(actors.has(b.spec.id) ? { actorId: actors.get(b.spec.id)! } : {}),
    ...(items.has(b.spec.id) ? { itemId: items.get(b.spec.id)! } : {}),
    ...(placed.has(b.spec.id) ? { discontinuity: 'placed' as const } : {}),
  }));
  const ids = new Set(bodies.map(b => b.id));
  const tethers = physics.world.constraints.filter(c => ids.has(c.a) && ids.has(c.b)).map(physicsTetherFields);
  return { physicsProfile: physics.profile, bodies, tethers };
}

/** Apply existing potential-visibility authorization to the captured tick, including delayed views. */
export function projectPhysicsPresentation(frame: Snapshot, viewer: Player | undefined, authorizedPlayers: Set<string>, inRange: (p: Vec2 & { radius?: number }) => boolean) {
  if (!frame.bodies) return {};
  const authorizedItems = new Set<string | number>(frame.items.filter(inRange).map(i => i.id));
  const bodies = frame.bodies.filter(body => {
    if (body.kind === 'actor') return body.actorId !== undefined && authorizedPlayers.has(body.actorId);
    if (body.itemId !== undefined && !authorizedItems.has(body.itemId)) return false;
    return !viewer || inRange({ x: body.x, y: body.y, radius: bodyRadius(body.shape) });
  }).map(body => physicsBodyFields(body, !viewer || body.kind !== 'actor' || body.actorId === viewer.id));
  const ids = new Set(bodies.map(body => body.id));
  // Omit the whole tether when either endpoint is unauthorized. Never send hidden IDs/anchors.
  const tethers: PhysicsTetherView[] = (frame.tethers ?? []).filter(t => ids.has(t.a) && ids.has(t.b)).map(physicsTetherFields);
  return { physicsProfile: frame.physicsProfile, bodies, tethers };
}
