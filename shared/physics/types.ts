import type { BodyId, ItemId, PlayerIdx, PropId, TetherId } from '../types.ts';

/** Public physics values use game world units and never expose Rapier objects. */
export type Point = { x: number; y: number };
export type BodyShape =
  | { kind: 'circle'; radius: number }
  | { kind: 'box'; hx: number; hy: number }
  | { kind: 'convex'; vertices: Point[] };
export type BodyKind = 'actor' | 'prop' | 'static';
export type BodySpec = {
  id: string; kind: BodyKind; shape: BodyShape; x: number; y: number;
  collisionProfile?: 'loot';
  /** Static map geometry: its collider shares one fixed body with the rest of the map's (world.ts). */
  mapGeometry?: true;
  angle?: number; vx?: number; vy?: number; omega?: number;
  mass?: number; friction?: number; restitution?: number;
  linearDamping?: number; angularDamping?: number;
  maxSpeed?: number;
};
export type BodyDefinition = BodySpec;
export type Transform = { x: number; y: number; angle: number; vx: number; vy: number; omega: number; sleeping: boolean };
export type MotorIntent = Point & { accel: number };
export type PhysicsContact = { a: string; b: string; substep: number; type: 'start' | 'stop' };
export type ConstraintSpec = { id: string; a: string; b: string; maxDistance: number;
  kind?: 'spring' | 'rope'; anchorA?: Point; anchorB?: Point; restLength?: number;
  stiffness?: number; damping?: number; maxForce?: number; breakDistance?: number };
export type HookState = { id: string; tetherId: TetherId; casterIdx: PlayerIdx; x: number; y: number; dx: number; dy: number;
  travelled: number; startedTick: number; phase: 'flying' | 'pending' | 'pulling'; generationA: number;
  targetIdx?: PlayerIdx;
  /** Captured backend key invalidates a tether if diagnostic setup renames its target. */
  targetActorKey?: string; generationB?: number; hitTick?: number; desiredLength?: number };
export type LegacyHookState = Omit<HookState, 'tetherId' | 'casterIdx' | 'targetIdx' | 'targetActorKey'> & { caster: string; target?: string };
export type PhysicsSnapshot = {
  bodies: Array<{ spec: BodySpec; transform: Transform; generation: number; motor?: MotorIntent }>;
  constraints: ConstraintSpec[];
  pending: { add: BodySpec[]; remove: string[]; addConstraints: ConstraintSpec[]; removeConstraints: string[];
    forces: Array<{ id: string; value: Point }>; impulses: Array<{ id: string; value: Point }> };
};

/** Engine-free display/correction values. Observed actor projections omit optional motion/sleep.
 * No motors, forces, pending commands or backend settings. */
export type LegacyPhysicsBodyView = Pick<Transform, 'x' | 'y' | 'angle'> & Partial<Pick<Transform, 'vx' | 'vy' | 'omega' | 'sleeping'>> & {
  id: string; kind: 'actor' | 'prop'; shape: BodyShape; generation: number;
  actorId?: string; itemId?: string | number; discontinuity?: 'placed';
};
export type LegacyPhysicsTetherView = { id: string; a: string; b: string };

/** Match-scoped numeric presentation relations (wire v4 / recording schema 20). */
export type PhysicsBodyOwner = { kind: 'actor'; playerIdx: PlayerIdx }
  | { kind: 'item'; itemId: ItemId } | { kind: 'prop'; propId: PropId };
export type PhysicsBodyView = Omit<LegacyPhysicsBodyView, 'id' | 'actorId' | 'itemId'> & { id: BodyId; owner: PhysicsBodyOwner };
export type NumericPhysicsBody = PhysicsBodyView & Transform;
export type PhysicsTetherView = { id: TetherId; a: BodyId; b: BodyId };
export type NumericPhysicsTether = PhysicsTetherView;
export type NumericHookFlight = { id: TetherId; a: BodyId; casterIdx: PlayerIdx; x: number; y: number };

/** Private, engine-free authoritative state. This is not a backend continuation checkpoint. */
export interface PhysicsGameplayState {
  hooks?: LegacyHookState[];
  discontinuities?: Array<{ id: string; generation: number; kind: 'placed' | 'removed' }> | undefined;
  world: Omit<PhysicsSnapshot, 'pending'>;
  pendingSpawns: Array<Point & { id: number; owner: string; dx: number; dy: number;
    life: number; damage: number; trap?: boolean | undefined }>;
  pendingImpulses: Array<{ id: string; value: Point; generation: number }>;
  pendingAttachments: Array<ConstraintSpec & { generationA: number; generationB: number }>;
}
