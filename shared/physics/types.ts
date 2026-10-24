/** Public physics values use game world units and never expose Rapier objects. */
export type Point = { x: number; y: number };
export type BodyShape =
  | { kind: 'circle'; radius: number }
  | { kind: 'box'; hx: number; hy: number }
  | { kind: 'convex'; vertices: Point[] };
export type BodyKind = 'actor' | 'prop' | 'static';
export type BodySpec = {
  id: string; kind: BodyKind; shape: BodyShape; x: number; y: number;
  angle?: number; vx?: number; vy?: number; omega?: number;
  mass?: number; friction?: number; restitution?: number;
  maxSpeed?: number;
};
export type BodyDefinition = BodySpec;
export type Transform = { x: number; y: number; angle: number; vx: number; vy: number; omega: number; sleeping: boolean };
export type MotorIntent = Point & { accel: number };
export type PhysicsContact = { a: string; b: string; substep: number; type: 'start' | 'stop' };
export type ConstraintSpec = { id: string; a: string; b: string; maxDistance: number };
export type PhysicsSnapshot = {
  bodies: Array<{ spec: BodySpec; transform: Transform; generation: number; motor?: MotorIntent }>;
  constraints: ConstraintSpec[];
  pending: { add: BodySpec[]; remove: string[]; addConstraints: ConstraintSpec[]; removeConstraints: string[];
    forces: Array<{ id: string; value: Point }>; impulses: Array<{ id: string; value: Point }> };
};

/** Engine-free display/correction values. Observed actor projections omit optional motion/sleep.
 * No motors, forces, pending commands or backend settings. */
export type PhysicsBodyView = Pick<Transform, 'x' | 'y' | 'angle'> & Partial<Pick<Transform, 'vx' | 'vy' | 'omega' | 'sleeping'>> & {
  id: string; kind: 'actor' | 'prop'; shape: BodyShape; generation: number;
  actorId?: string; itemId?: string | number; discontinuity?: 'placed';
};
export type PhysicsTetherView = { id: string; a: string; b: string };

/** Private, engine-free authoritative state. This is not a backend continuation checkpoint. */
export interface PhysicsGameplayState {
  discontinuities?: Array<{ id: string; generation: number; kind: 'placed' | 'removed' }> | undefined;
  profile: string;
  settings: {
    engine: string; version: string; unitsPerMetre: number; substeps: number;
    substepSeconds: number; speculativeDistanceMetres: number;
    exactCheckpoint: 'unsupported'; maxConstraints: number; constraintLimitations: string;
  };
  world: PhysicsSnapshot;
  pendingSpawns: Array<Point & { id: number; owner: string; dx: number; dy: number;
    life: number; damage: number; trap?: boolean | undefined }>;
  pendingImpulses: Array<{ id: string; value: Point; generation: number }>;
  pendingAttachments: Array<ConstraintSpec & { generationA: number; generationB: number }>;
}
