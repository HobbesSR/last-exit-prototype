import type { NumericPhysicsBody, NumericPhysicsTether, NumericHookFlight, PhysicsBodyOwner, PhysicsGameplayState, PhysicsTetherView } from '../physics/types.ts';
import type { Game, GroundItem, ItemKey, PlayerIdx, Snapshot, Player, Vec2 } from '../types.ts';
import { physicsBodyFields, physicsHookFlightFields, physicsTetherFields } from './projection-contract.ts';
import { physicsRuntime, physicsState } from './physics-runtime.ts';
import { start, stop } from '../profiler.ts';
import { bodyRadius } from '../physics/presentation-geometry.ts';
import { itemIdForLabel } from '../item-instances.ts';
import { groundItem } from './ground-items.ts';
import { wireIds, type WireIds } from './wire-ids.ts';

/**
 * What a client predicts with that never changes during a match (24.3 proposal 3, #1131): sent once, with the
 * map each `welcome` or `ready` delivers, instead of in every frame. The client puts them back on the frames
 * that need them (shared/relational-frame.ts), so readers see the same frames.
 */
export interface PredictionConstants {
  physicsProfile: string;
  predictionMotor: { acceleration: number; braking: number; maxSpeed: number; surfaces: true };
}
export const predictionConstants = (physicsProfile: string, motor: { acceleration: number; braking: number; maxSpeed: number }): PredictionConstants => ({
  physicsProfile,
  predictionMotor: { acceleration: motor.acceleration, braking: motor.braking, maxSpeed: motor.maxSpeed, surfaces: true },
});

export interface PhysicsPresentation {
  physics: PhysicsGameplayState;
  physicsProfile: string;
  bodies: NumericPhysicsBody[];
  tethers: NumericPhysicsTether[];
  hookFlights?: NumericHookFlight[];
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
    bodies.push(body); byKey.set(b.spec.id, body);
  }
  const hooks = new Map(r.hooks.map(hook => [hook.id, hook]));
  const tetherId = (key: string, lifetime: object) => {
    const hook = hooks.get(key);
    const id = hook ? hook.tetherId : r.identities.tether(lifetime);
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
  const captured = { physics, physicsProfile: s.version, bodies, tethers, ...(hookFlights ? { hookFlights } : {}) };
  stop('sim.snapshot.presentation');
  return captured;
}

/** The physics presentation a viewer may receive of a frame: its bodies, tethers and hook flights, in the frame's order. */
export interface AuthorizedPresentation {
  bodies: NonNullable<Snapshot['bodies']>;
  tethers: NonNullable<Snapshot['tethers']>;
  hookFlights: Snapshot['hookFlights'];
}

/**
 * The TypeScript information rule for the physics presentation (24 "Layered frames"), including delayed views. `items` are
 * the frame's items the view holds. An actor's body goes with its player, an item's with its item, and a tether only with
 * both ends. The core decides the same for a live player view (`tick-projection.ts`, #1357).
 */
export function authorizePresentation(frame: Snapshot, viewer: (Player<ItemKey> & { playerIdx: PlayerIdx }) | undefined, authorizedPlayers: ReadonlySet<PlayerIdx>, items: readonly GroundItem<ItemKey>[], inRange: (p: Vec2 & { radius?: number }) => boolean): AuthorizedPresentation {
  const authorizedItems = new Set<string | number>(items.map(i => i.id));
  const bodies = (frame.bodies ?? []).filter(body => {
    if (body.owner.kind === 'actor') return authorizedPlayers.has(body.owner.playerIdx);
    if (body.owner.kind === 'item' && !authorizedItems.has(body.owner.itemId)) return false;
    return !viewer || inRange({ x: body.x, y: body.y, radius: bodyRadius(body.shape) });
  });
  // Authorization reads internal IDs; only the projected records carry outward ones (#1164).
  const ids = new Set(bodies.map(body => body.id));
  const actorIds = new Set(bodies.filter(body => body.owner.kind === 'actor' && authorizedPlayers.has(body.owner.playerIdx)).map(body => body.id));
  // Omit the whole tether when either endpoint is unauthorized. Never send hidden IDs/anchors.
  const tethers = (frame.tethers ?? []).filter(t => ids.has(t.a) && ids.has(t.b));
  const hookFlights = frame.hookFlights?.filter(hook => actorIds.has(hook.a) && inRange({ x: hook.x, y: hook.y }));
  return { bodies, tethers, hookFlights };
}

/** The authorized presentation through the closed field contracts. The profile is a match constant (PredictionConstants). */
export function presentationFields({ bodies, tethers, hookFlights }: AuthorizedPresentation, viewer: { playerIdx: PlayerIdx } | undefined, wire: WireIds = wireIds()) {
  const flights = hookFlights?.map(hook => physicsHookFlightFields(hook, wire));
  return {
    bodies: bodies.map(body => physicsBodyFields(body, !viewer || body.owner.kind !== 'actor' || body.owner.playerIdx === viewer.playerIdx, wire)),
    tethers: tethers.map(t => physicsTetherFields(t, wire)) as PhysicsTetherView[], ...(flights ? { hookFlights: flights } : {}) };
}
