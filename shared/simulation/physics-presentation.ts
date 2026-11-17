import type { NumericPhysicsBody, NumericPhysicsTether, NumericHookFlight, PhysicsBodyOwner, PhysicsGameplayState, PhysicsTetherView } from '../physics/types.ts';
import type { BodyId, Game, GroundItem, ItemKey, PlayerIdx, Snapshot, Player, TetherId, Vec2 } from '../types.ts';
import { physicsBodyFields, physicsHookFlightFields, physicsTetherFields } from './projection-contract.ts';
import { physicsRuntime, physicsState } from './physics-runtime.ts';
import { start, stop } from '../profiler.ts';
import { bodyRadius } from '../physics/presentation-geometry.ts';
import { itemIdForLabel, itemLabel } from '../item-instances.ts';
import { groundItem } from './ground-items.ts';

export interface PhysicsPresentation {
  physics: PhysicsGameplayState;
  physicsProfile: string;
  bodies: NumericPhysicsBody[];
  tethers: NumericPhysicsTether[];
  hookFlights?: NumericHookFlight[];
  /** Captured compatibility labels; never consult current owners when adapting a historical capture. */
  legacy: { bodies: Map<BodyId, string>; actors: Map<PlayerIdx, string>; items: Map<BodyId, string>; tethers: Map<TetherId, string> };
}

/** Capture the live world and its identity relations synchronously, before any view filtering.
 * Detached/private states are not inputs: retain this result and adapt it for historical use. */
export function capturePhysicsPresentation(s: Game): PhysicsPresentation | undefined {
  if (arguments.length !== 1) throw new TypeError('capturePhysicsPresentation accepts only a live game; retain its result for historical use');
  const r = physicsRuntime(s);
  if (!r) return undefined;
  start('sim.snapshot.world');
  let physics: PhysicsGameplayState;
  try { physics = physicsState(s)!; }
  finally { stop('sim.snapshot.world'); }
  start('sim.snapshot.presentation');
  const actors = new Map(s.players.map((p, i) => [`actor:${p.id}`, i as PlayerIdx]));
  const legacy: PhysicsPresentation['legacy'] = { bodies: new Map(), actors: new Map(s.players.map((p, i) => [i as PlayerIdx, p.id])), items: new Map(), tethers: new Map() };
  const placed = new Set(physics.discontinuities?.filter(d => d.kind === 'placed').map(d => d.id));
  const byKey = new Map<string, NumericPhysicsBody>();
  const bodies: NumericPhysicsBody[] = [];
  for (const b of physics.world.bodies) {
    if (b.spec.kind === 'static') continue;
    const playerIdx = actors.get(b.spec.id);
    let owner: PhysicsBodyOwner;
    if (b.spec.kind === 'actor') {
      if (playerIdx === undefined) continue;
      owner = { kind: 'actor', playerIdx };
    } else if (b.spec.id.startsWith('item:')) {
      const itemId = itemIdForLabel(s, b.spec.id.slice(5));
      if (itemId === undefined || !groundItem(s, itemId)) continue;
      owner = { kind: 'item', itemId };
    } else owner = { kind: 'prop', propId: r.identities.prop(b.spec.id) };
    const lifetime = r.world.bodyLifetime(b.spec.id)!;
    const id = r.identities.body(lifetime);
    const body: NumericPhysicsBody = { id, kind: b.spec.kind, shape: b.spec.shape, ...b.transform, generation: b.generation, owner,
      ...(placed.has(b.spec.id) ? { discontinuity: 'placed' as const } : {}) };
    bodies.push(body); byKey.set(b.spec.id, body); legacy.bodies.set(id, b.spec.id);
    if (owner.kind === 'item') legacy.items.set(id, itemLabel(s, owner.itemId));
  }
  const hooks = new Map(r.hooks.map(hook => [hook.id, hook]));
  const tetherId = (key: string, lifetime: object) => {
    const hook = hooks.get(key);
    const id = hook ? hook.tetherId : r.identities.tether(lifetime);
    legacy.tethers.set(id, key);
    return id;
  };
  const tethers: NumericPhysicsTether[] = physics.world.constraints.flatMap(c => {
    const a = byKey.get(c.a), b = byKey.get(c.b);
    return a && b ? [{ id: tetherId(c.id, c), a: a.id, b: b.id }] : [];
  });
  const actorBodies = new Map(bodies.flatMap(body => body.owner.kind === 'actor' ? [[body.owner.playerIdx, body] as const] : []));
  const hookFlights = physics.hooks?.flatMap(hook => {
    const source = hooks.get(hook.id)!;
    const a = actorBodies.get(source.casterIdx);
    return hook.phase === 'flying' && a?.owner.kind === 'actor'
      ? [{ id: tetherId(hook.id, hook), a: a.id, casterIdx: a.owner.playerIdx, x: hook.x, y: hook.y }] : [];
  });
  const captured = { physics, physicsProfile: s.version, bodies, tethers, ...(hookFlights ? { hookFlights } : {}), legacy };
  stop('sim.snapshot.presentation');
  return captured;
}

/** CP1 boundary: legacy snapshots, views and recordings keep their exact field order and labels. */
export function legacyPhysicsPresentation(presentation: PhysicsPresentation) {
  const { legacy, physicsProfile } = presentation;
  const bodies = presentation.bodies.map(body => physicsBodyFields({
    id: legacy.bodies.get(body.id)!, kind: body.kind, shape: body.shape,
    x: body.x, y: body.y, angle: body.angle, vx: body.vx, vy: body.vy, omega: body.omega, sleeping: body.sleeping, generation: body.generation,
    ...(body.owner.kind === 'actor' ? { actorId: legacy.actors.get(body.owner.playerIdx)! } : {}),
    ...(body.owner.kind === 'item' ? { itemId: legacy.items.get(body.id)! } : {}),
    ...(body.discontinuity ? { discontinuity: body.discontinuity } : {}),
  }));
  const tethers = presentation.tethers.map(t => physicsTetherFields({ id: legacy.tethers.get(t.id)!, a: legacy.bodies.get(t.a)!, b: legacy.bodies.get(t.b)! }));
  const hookFlights = presentation.hookFlights?.map(h => physicsHookFlightFields({ id: legacy.tethers.get(h.id)!, a: legacy.bodies.get(h.a)!, x: h.x, y: h.y }));
  return { physicsProfile, bodies, tethers, ...(hookFlights ? { hookFlights } : {}) };
}

/** Apply existing potential-visibility authorization to the captured tick, including delayed views. `items` are the frame's items the view holds. */
export function projectPhysicsPresentation(frame: Snapshot, viewer: Player<ItemKey> | undefined, authorizedPlayers: Set<string>, items: readonly GroundItem<ItemKey>[], inRange: (p: Vec2 & { radius?: number }) => boolean) {
  if (!frame.bodies) return {};
  const authorizedItems = new Set<string | number>(items.map(i => i.id));
  const bodies = frame.bodies.filter(body => {
    if (body.kind === 'actor') return body.actorId !== undefined && authorizedPlayers.has(body.actorId);
    if (body.itemId !== undefined && !authorizedItems.has(body.itemId)) return false;
    return !viewer || inRange({ x: body.x, y: body.y, radius: bodyRadius(body.shape) });
  }).map(body => physicsBodyFields(body, !viewer || body.kind !== 'actor' || body.actorId === viewer.id));
  const ids = new Set(bodies.map(body => body.id));
  const actorIds = new Set(bodies.filter(body => body.kind === 'actor' && body.actorId !== undefined && authorizedPlayers.has(body.actorId)).map(body => body.id));
  // Omit the whole tether when either endpoint is unauthorized. Never send hidden IDs/anchors.
  const tethers: PhysicsTetherView[] = (frame.tethers ?? []).filter(t => ids.has(t.a) && ids.has(t.b)).map(physicsTetherFields);
  const hookFlights = frame.hookFlights?.filter(hook => actorIds.has(hook.a) && inRange({ x: hook.x, y: hook.y }))
    .map(physicsHookFlightFields);
  return { physicsProfile: frame.physicsProfile, bodies, tethers, ...(hookFlights ? { hookFlights } : {}) };
}
