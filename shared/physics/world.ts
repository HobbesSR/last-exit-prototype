import RAPIER from '@dimforge/rapier2d-compat';
import { PHYSICS_SUBSTEP_SECONDS, physicsSpeedLimit } from './motion-limits.ts';
import { constraintForce, validateConstraint } from './constraints.ts';
import type { BodySpec, ConstraintSpec, MotorIntent, PhysicsContact, PhysicsSnapshot, Point, Transform } from './types.ts';
import { cos, hypot, sin } from '../math.ts';

const SCALE = 40;
const SUBSTEPS = 4;
const DT = PHYSICS_SUBSTEP_SECONDS;
const MAX_DYNAMIC = 128;
const MAX_ACTORS = 27;
const MAX_STATIC = 100000;
const MAX_PENDING = 1024;
const MAX_EVENTS = 8192;
// Keep inputs representable through world-unit conversion and the f32 backend.
// This is an admission guard, not a promise of useful precision at this extent.
const MAX_MAGNITUDE = 1e9;
const STATIC_GROUP = 0x0001;
const ACTOR_GROUP = 0x0002;
const PROP_GROUP = 0x0004;
// Rapier's init only checks for a finished instance, so overlapping calls instantiate the wasm twice and
// orphan whatever the first instance allocated. Share one initialization.
let initialization: Promise<void> | undefined;
const initialized = () => initialization ??= RAPIER.init();
const LOOT_GROUP = 0x0008;
const solidMask = STATIC_GROUP | ACTOR_GROUP | PROP_GROUP;
const groups = (membership: number, mask: number): number => (membership << 16) | mask;
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const finite = (n: number | undefined, fallback = 0): number => {
  const value = n ?? fallback;
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MAGNITUDE)
    throw new TypeError('physics value must be finite and within representable bounds');
  return value;
};
const positive = (n: number | undefined, fallback?: number): number => {
  const value = finite(n, fallback);
  if (value <= 0) throw new RangeError('physics value must be positive');
  return value;
};
const nonnegative = (n: number | undefined, fallback = 0): number => {
  const value = finite(n, fallback);
  if (value < 0) throw new RangeError('physics value must be nonnegative');
  return value;
};
const dimension = (n: number | undefined): number => {
  const value = positive(n);
  if (value < 1e-6) throw new RangeError('physics dimension must be at least 1e-6');
  return value;
};
const mass = (n: number | undefined): number => {
  const value = positive(n, 1);
  if (value < 1e-6 || value > 1e6) throw new RangeError('physics mass must be within 1e-6..1e6');
  return value;
};
const clone = <T>(value: T): T => structuredClone(value);
const vector = (value: Point): Point => ({ x: finite(value.x), y: finite(value.y) });
const validId = (id: string): string => {
  if (typeof id !== 'string' || !id.length) throw new TypeError('physics ID must be a nonempty string');
  return id;
};
function shapeRadii(shape: BodySpec['shape']): { minimum: number; tip: number } {
  if (shape.kind === 'circle') return { minimum: shape.radius, tip: 0 };
  if (shape.kind === 'box') return { minimum: Math.min(shape.hx, shape.hy), tip: hypot(shape.hx, shape.hy) };
  return {
    minimum: Math.min(...shape.vertices.map((point, i, vertices) => {
      const next = vertices[(i + 1) % vertices.length]!;
      return Math.abs(point.x * next.y - point.y * next.x) / hypot(next.x - point.x, next.y - point.y);
    })),
    tip: Math.max(...shape.vertices.map(point => hypot(point.x, point.y))),
  };
}

function validateBody(input: BodySpec): BodySpec {
  validId(input.id);
  if (!['actor', 'prop', 'static'].includes(input.kind)) throw new TypeError('invalid body kind');
  const shape = input.shape;
  let checked: BodySpec['shape'];
  if (shape.kind === 'circle') checked = { kind: 'circle', radius: dimension(shape.radius) };
  else if (shape.kind === 'box') checked = { kind: 'box', hx: dimension(shape.hx), hy: dimension(shape.hy) };
  else if (shape.kind === 'convex') {
    if (!Array.isArray(shape.vertices) || shape.vertices.length < 3 || shape.vertices.length > 64) throw new RangeError('convex body needs 3..64 vertices');
    checked = { kind: 'convex', vertices: shape.vertices.map(vector) };
    const vertices = checked.vertices;
    const area = vertices.reduce((sum, p, i) => {
      const q = vertices[(i + 1) % vertices.length]!;
      return sum + p.x * q.y - q.x * p.y;
    }, 0);
    if (Math.abs(area) < 1e-6) throw new RangeError('convex body has zero area');
    const winding = Math.sign(area);
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!, b = vertices[(i + 1) % vertices.length]!, c = vertices[(i + 2) % vertices.length]!;
      const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const centerSide = (b.x - a.x) * -a.y - (b.y - a.y) * -a.x;
      if (turn * winding <= 1e-8 || centerSide * winding <= 1e-8)
        throw new RangeError('convex body must be strictly convex and centered around origin');
    }
  } else throw new TypeError('invalid body shape');
  const result: BodySpec = { id: input.id, kind: input.kind, shape: checked,
    x: finite(input.x), y: finite(input.y), angle: finite(input.angle),
    vx: finite(input.vx), vy: finite(input.vy), omega: finite(input.omega),
    mass: mass(input.mass), friction: nonnegative(input.friction, 0.5),
    restitution: nonnegative(input.restitution) };
  if (input.collisionProfile !== undefined) {
    if (input.collisionProfile !== 'loot' || input.kind !== 'prop')
      throw new TypeError('invalid physics collision profile');
    result.collisionProfile = input.collisionProfile;
  }
  if (input.linearDamping !== undefined) result.linearDamping = nonnegative(input.linearDamping);
  if (input.angularDamping !== undefined) result.angularDamping = nonnegative(input.angularDamping);
  if (result.restitution! > 1) throw new RangeError('restitution must be <= 1');
  if (input.maxSpeed !== undefined) result.maxSpeed = positive(input.maxSpeed);
  if (result.kind === 'static' && (result.vx || result.vy || result.omega)) throw new RangeError('static body cannot move');
  if (result.kind !== 'static') {
    const { minimum, tip } = shapeRadii(checked);
    const speed = hypot(result.vx!, result.vy!) + Math.abs(result.omega!) * tip;
    const limit = Math.min(result.maxSpeed ?? Infinity, physicsSpeedLimit(minimum));
    if (speed > limit) throw new RangeError('initial physics speed requires swept-query-or-explicit-teleport');
  }
  return result;
}

type RecordBody = { spec: BodySpec; handle: number; collider: number; generation: number;
  motor?: MotorIntent; minimumRadius: number; tipRadius: number };

export async function createPhysicsWorld(): Promise<PhysicsWorld> {
  return PhysicsWorld.create();
}

/** Initialize once, then synchronously allocate fresh islands without restoring solver caches. */
export async function createPhysicsWorldFactory(): Promise<() => PhysicsWorld> {
  return PhysicsWorld.factory();
}

/** One room owns one instance. Mutations are applied at a tick boundary. */
export class PhysicsWorld {
  readonly settings = Object.freeze({ engine: 'rapier2d-compat', version: '0.21.0', unitsPerMetre: SCALE,
    substeps: SUBSTEPS, substepSeconds: DT, speculativeDistanceMetres: 0.6,
    exactCheckpoint: 'unsupported' as const, maxConstraints: 8,
    constraintLimitations: 'legacy native center rope; explicit bounded spring/rope has no hard length projection' });
  private native: RAPIER.World;
  private events: RAPIER.EventQueue;
  private bodies = new Map<string, RecordBody>();
  private sortedDynamic: Array<[string, RecordBody]> = [];
  private actorCount = 0;
  private dynamicCount = 0;
  private staticCount = 0;
  private nextGeneration = 0;
  private colliderIds = new Map<number, string>();
  private constraints = new Map<string, { spec: ConstraintSpec; handle?: number }>();
  private pendingAdd: BodySpec[] = [];
  private pendingRemove: string[] = [];
  private pendingAddConstraints: ConstraintSpec[] = [];
  private pendingRemoveConstraints: string[] = [];
  private forces: Array<{ id: string; value: Point }> = [];
  private impulses: Array<{ id: string; value: Point }> = [];
  private contacts: PhysicsContact[] = [];
  private disposed = false;

  static async create(): Promise<PhysicsWorld> {
    await initialized();
    return new PhysicsWorld();
  }
  static async factory(): Promise<() => PhysicsWorld> {
    await initialized();
    return () => new PhysicsWorld();
  }
  private constructor() {
    this.native = new RAPIER.World({ x: 0, y: 0 });
    this.native.lengthUnit = 1;
    this.native.integrationParameters.normalizedAllowedLinearError = 0.0001;
    this.native.integrationParameters.normalizedPredictionDistance = 0.6;
    this.native.numSolverIterations = 8;
    this.native.numInternalPgsIterations = 2;
    this.native.maxCcdSubsteps = 4;
    this.native.timestep = DT;
    this.events = new RAPIER.EventQueue(true);
  }

  private ensure(): void { if (this.disposed) throw new Error('physics world disposed'); }
  private roomCount(kind: BodySpec['kind']): number {
    return (kind === 'actor' ? this.actorCount : kind === 'static' ? this.staticCount : this.dynamicCount - this.actorCount)
      + this.pendingAdd.filter(spec => spec.kind === kind).length
      - this.pendingRemove.filter(id => this.bodies.get(id)?.spec.kind === kind).length;
  }
  private checkQueue(): void {
    if (this.pendingAdd.length + this.pendingRemove.length + this.pendingAddConstraints.length +
        this.pendingRemoveConstraints.length + this.forces.length + this.impulses.length >= MAX_PENDING)
      throw new RangeError('physics command queue capacity exceeded');
  }
  /** Whether a batch of dynamic bodies fits without partial queue admission. */
  canAddBodies(count: number): boolean {
    this.ensure();
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('physics body count must be a nonnegative integer');
    const queued = this.pendingAdd.length + this.pendingRemove.length + this.pendingAddConstraints.length +
      this.pendingRemoveConstraints.length + this.forces.length + this.impulses.length;
    return count <= MAX_DYNAMIC - this.roomCount('actor') - this.roomCount('prop') &&
      count <= MAX_PENDING - queued;
  }
  queueAddBody(input: BodySpec): void {
    this.ensure(); this.checkQueue();
    const spec = validateBody(input);
    if (this.bodies.has(spec.id) && !this.pendingRemove.includes(spec.id) || this.pendingAdd.some(body => body.id === spec.id))
      throw new Error(`duplicate physics body ${spec.id}`);
    const dynamic = this.roomCount('actor') + this.roomCount('prop');
    if (spec.kind === 'actor' && this.roomCount('actor') >= MAX_ACTORS ||
        spec.kind !== 'static' && dynamic >= MAX_DYNAMIC ||
        spec.kind === 'static' && this.roomCount('static') >= MAX_STATIC)
      throw new RangeError('physics body capacity exceeded');
    this.pendingAdd.push(spec);
  }
  queueRemoveBody(id: string): void {
    this.ensure(); this.checkQueue(); validId(id);
    if (!this.bodies.has(id) && !this.pendingAdd.some(body => body.id === id)) throw new Error(`unknown physics body ${id}`);
    if (this.pendingRemove.includes(id)) throw new Error(`duplicate physics removal ${id}`);
    this.pendingRemove.push(id);
  }
  queueAddConstraint(input: ConstraintSpec): void {
    this.ensure(); this.checkQueue();
    const spec = validateConstraint(input);
    if (this.constraints.has(spec.id) && !this.pendingRemoveConstraints.includes(spec.id) ||
        this.pendingAddConstraints.some(item => item.id === spec.id)) throw new Error(`duplicate physics constraint ${spec.id}`);
    if (this.constraints.size - this.pendingRemoveConstraints.length + this.pendingAddConstraints.length >= 8)
      throw new RangeError('physics constraint capacity exceeded');
    for (const id of [spec.a, spec.b]) {
      if ((!this.bodies.has(id) || this.pendingRemove.includes(id)) && !this.pendingAdd.some(body => body.id === id))
        throw new Error(`unknown physics constraint endpoint ${id}`);
    }
    this.pendingAddConstraints.push(spec);
  }
  queueRemoveConstraint(id: string): void {
    this.ensure(); this.checkQueue(); validId(id);
    if (!this.constraints.has(id) && !this.pendingAddConstraints.some(item => item.id === id))
      throw new Error(`unknown physics constraint ${id}`);
    if (this.pendingRemoveConstraints.includes(id)) throw new Error(`duplicate physics constraint removal ${id}`);
    this.pendingRemoveConstraints.push(id);
  }
  private add(spec: BodySpec): void {
    const descriptor = spec.kind === 'static' ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    descriptor.setTranslation(spec.x / SCALE, spec.y / SCALE).setRotation(spec.angle!)
      .setLinvel(spec.vx! / SCALE, spec.vy! / SCALE).setAngvel(spec.omega!);
    if (spec.linearDamping !== undefined) descriptor.setLinearDamping(spec.linearDamping);
    if (spec.angularDamping !== undefined) descriptor.setAngularDamping(spec.angularDamping);
    if (spec.kind !== 'static') descriptor.setCcdEnabled(true);
    if (spec.kind === 'actor') descriptor.lockRotations();
    const body = this.native.createRigidBody(descriptor);
    let collider: RAPIER.ColliderDesc;
    const { minimum: minimumRadius, tip: tipRadius } = shapeRadii(spec.shape);
    if (spec.shape.kind === 'circle') {
      collider = RAPIER.ColliderDesc.ball(spec.shape.radius / SCALE);
    } else if (spec.shape.kind === 'box') {
      collider = RAPIER.ColliderDesc.cuboid(spec.shape.hx / SCALE, spec.shape.hy / SCALE);
    } else {
      const vertices = spec.shape.vertices.flatMap(point => [point.x / SCALE, point.y / SCALE]);
      const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(vertices));
      if (!hull) { this.native.removeRigidBody(body); throw new RangeError('invalid convex body'); }
      collider = hull;
    }
    collider.setMass(spec.mass!).setFriction(spec.friction!).setRestitution(spec.restitution!)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (spec.collisionProfile === 'loot') collider.setCollisionGroups(groups(LOOT_GROUP, STATIC_GROUP));
    else if (spec.kind === 'static') collider.setCollisionGroups(groups(STATIC_GROUP, solidMask | LOOT_GROUP));
    else if (spec.kind === 'actor') collider.setCollisionGroups(groups(ACTOR_GROUP, solidMask));
    else collider.setCollisionGroups(groups(PROP_GROUP, solidMask));
    const attached = this.native.createCollider(collider, body);
    this.bodies.set(spec.id, { spec, handle: body.handle, collider: attached.handle,
      generation: ++this.nextGeneration, minimumRadius, tipRadius });
    if (spec.kind === 'static') this.staticCount++;
    else { this.dynamicCount++; if (spec.kind === 'actor') this.actorCount++; }
    this.colliderIds.set(attached.handle, spec.id);
  }
  private wakeConstraintEndpoints(spec: ConstraintSpec): void {
    for (const id of [spec.a, spec.b]) {
      const record = this.bodies.get(id);
      if (record && record.spec.kind !== 'static') this.native.getRigidBody(record.handle)!.wakeUp();
    }
  }
  commitMutations(): void {
    this.ensure();
    const bodiesChanged = this.pendingAdd.length > 0 || this.pendingRemove.length > 0;
    const removed = new Set(this.pendingRemove);
    const existingBeforeRemoval = new Set(this.pendingRemove.filter(id => this.bodies.has(id)));
    for (const id of this.pendingRemoveConstraints.sort(order)) {
      const record = this.constraints.get(id);
      if (record) {
        if (record.handle !== undefined) this.native.removeImpulseJoint(this.native.getImpulseJoint(record.handle)!, true);
        else this.wakeConstraintEndpoints(record.spec);
        this.constraints.delete(id);
      }
    }
    for (const id of this.pendingRemove.sort(order)) {
      const record = this.bodies.get(id);
      if (record) {
        for (const [jointId, joint] of this.constraints) {
          if (joint.spec.a === id || joint.spec.b === id) {
            if (joint.handle === undefined) this.wakeConstraintEndpoints(joint.spec);
            this.constraints.delete(jointId);
          }
        }
        this.native.removeRigidBody(this.native.getRigidBody(record.handle)!);
        this.colliderIds.delete(record.collider);
        this.bodies.delete(id);
        if (record.spec.kind === 'static') this.staticCount--;
        else { this.dynamicCount--; if (record.spec.kind === 'actor') this.actorCount--; }
      }
    }
    for (const spec of this.pendingAdd.sort((a, b) => order(a.id, b.id))) {
      // A create/remove pair cancels before admission. Removing an existing ID
      // and re-adding it is a replacement with a new private engine handle.
      if (!removed.has(spec.id) || existingBeforeRemoval.has(spec.id)) this.add(spec);
    }
    for (const spec of this.pendingAddConstraints.sort((a, b) => order(a.id, b.id))) {
      if (this.pendingRemoveConstraints.includes(spec.id) ||
          this.pendingRemove.includes(spec.a) || this.pendingRemove.includes(spec.b)) continue;
      const a = this.bodies.get(spec.a), b = this.bodies.get(spec.b);
      if (!a || !b) continue;
      if (spec.kind === undefined) {
        const native = this.native.createImpulseJoint(
          RAPIER.JointData.rope(spec.maxDistance / SCALE, { x: 0, y: 0 }, { x: 0, y: 0 }),
          this.native.getRigidBody(a.handle)!, this.native.getRigidBody(b.handle)!, true);
        this.constraints.set(spec.id, { spec, handle: native.handle });
      } else {
        this.constraints.set(spec.id, { spec });
        this.native.getRigidBody(a.handle)!.wakeUp();
        this.native.getRigidBody(b.handle)!.wakeUp();
      }
    }
    this.pendingRemove = []; this.pendingAdd = [];
    this.pendingRemoveConstraints = []; this.pendingAddConstraints = [];
    this.forces = this.forces.filter(entry => !removed.has(entry.id));
    this.impulses = this.impulses.filter(entry => !removed.has(entry.id));
    if (bodiesChanged) this.sortedDynamic = [...this.bodies].filter(([, record]) => record.spec.kind !== 'static')
      .sort(([a], [b]) => order(a, b));
  }
  hasBody(id: string): boolean { this.ensure(); return this.bodies.has(id); }
  hasConstraint(id: string): boolean { this.ensure(); return this.constraints.has(validId(id)); }
  /** Placement only; queries current colliders, including rotated props, without backend handles. */
  overlapsProp(x: number, y: number, radius: number): boolean {
    this.ensure();
    this.native.propagateModifiedBodyPositionsToColliders();
    const shape = new RAPIER.Ball(dimension(radius) / SCALE);
    const at = { x: finite(x) / SCALE, y: finite(y) / SCALE };
    return this.sortedDynamic.some(([, record]) => record.spec.kind === 'prop' && record.spec.collisionProfile !== 'loot'
      && this.native.getCollider(record.collider)!.intersectsShape(shape, at, 0));
  }
  overlapsDynamicBox(box: { x: number; y: number; w: number; h: number }): boolean {
    this.ensure();
    this.native.propagateModifiedBodyPositionsToColliders();
    const shape = new RAPIER.Cuboid(dimension(box.w) / SCALE / 2, dimension(box.h) / SCALE / 2);
    const at = { x: (finite(box.x) + box.w / 2) / SCALE, y: (finite(box.y) + box.h / 2) / SCALE };
    return this.sortedDynamic.some(([, record]) => record.spec.collisionProfile !== 'loot'
      && this.native.getCollider(record.collider)!.intersectsShape(shape, at, 0));
  }
  getGeneration(id: string): number | undefined {
    this.ensure(); return this.bodies.get(validId(id))?.generation;
  }
  private dynamic(id: string): { record: RecordBody; body: RAPIER.RigidBody } {
    const record = this.bodies.get(validId(id));
    if (!record || record.spec.kind === 'static') throw new Error(`unknown dynamic physics body ${id}`);
    return { record, body: this.native.getRigidBody(record.handle)! };
  }
  setMotor(id: string, input: MotorIntent): void {
    this.ensure(); const { record, body } = this.dynamic(id);
    record.motor = { ...vector(input), accel: nonnegative(input.accel) };
    body.wakeUp();
  }
  setDamping(id: string, linear: number, angular: number): void {
    this.ensure();
    const nextLinear = nonnegative(linear), nextAngular = nonnegative(angular);
    const { record, body } = this.dynamic(id);
    if ((record.spec.linearDamping ?? 0) !== nextLinear) {
      body.setLinearDamping(nextLinear);
      record.spec.linearDamping = nextLinear;
    }
    if ((record.spec.angularDamping ?? 0) !== nextAngular) {
      body.setAngularDamping(nextAngular);
      record.spec.angularDamping = nextAngular;
    }
  }
  setTransform(id: string, value: Pick<Transform, 'x' | 'y' | 'angle'>): void {
    this.ensure(); const { record, body } = this.dynamic(id);
    const x = finite(value.x), y = finite(value.y), angle = finite(value.angle);
    for (const [jointId, joint] of this.constraints) {
      if (joint.spec.a !== id && joint.spec.b !== id) continue;
      if (joint.handle !== undefined) this.native.removeImpulseJoint(this.native.getImpulseJoint(joint.handle)!, true);
      else this.wakeConstraintEndpoints(joint.spec);
      this.constraints.delete(jointId);
    }
    this.pendingAddConstraints = this.pendingAddConstraints.filter(spec => spec.a !== id && spec.b !== id);
    this.pendingRemoveConstraints = this.pendingRemoveConstraints.filter(jointId =>
      this.constraints.has(jointId) || this.pendingAddConstraints.some(spec => spec.id === jointId));
    this.forces = this.forces.filter(entry => entry.id !== id);
    this.impulses = this.impulses.filter(entry => entry.id !== id);
    delete record.motor;
    record.generation = ++this.nextGeneration;
    body.setTranslation({ x: x / SCALE, y: y / SCALE }, true);
    body.setRotation(angle, true);
    body.setLinvel({ x: 0, y: 0 }, true);
    body.setAngvel(0, true);
  }
  queueForce(id: string, input: Point): void {
    this.ensure(); this.checkQueue(); this.dynamic(id);
    this.forces.push({ id, value: vector(input) });
  }
  queueImpulse(id: string, input: Point): void {
    this.ensure(); this.checkQueue(); this.dynamic(id);
    this.impulses.push({ id, value: vector(input) });
  }
  getTransform(id: string): Transform | undefined {
    this.ensure(); const record = this.bodies.get(validId(id));
    if (!record) return undefined;
    const body = this.native.getRigidBody(record.handle)!;
    const p = body.translation(), v = body.linvel();
    return { x: p.x * SCALE, y: p.y * SCALE, angle: body.rotation(),
      vx: v.x * SCALE, vy: v.y * SCALE, omega: body.angvel(), sleeping: body.isSleeping() };
  }
  private capSpeeds(): void {
    for (const [id, record] of this.sortedDynamic) {
      const body = this.native.getRigidBody(record.handle)!;
      const v = body.linvel(), speed = hypot(v.x, v.y) * SCALE;
      const limit = Math.min(record.spec.maxSpeed ?? Infinity, physicsSpeedLimit(record.minimumRadius));
      if (!Number.isFinite(speed)) throw new Error(`nonfinite physics speed ${id}`);
      const omega = body.angvel();
      if (!Number.isFinite(omega)) throw new Error(`nonfinite physics angular speed ${id}`);
      const angularSpeed = Math.abs(omega) * record.tipRadius;
      if (angularSpeed > limit) body.setAngvel(omega * limit / angularSpeed, true);
      const linearBudget = Math.max(0, limit - Math.min(limit, angularSpeed));
      if (speed > linearBudget) body.setLinvel({ x: v.x * linearBudget / speed, y: v.y * linearBudget / speed }, true);
    }
  }
  private applyBoundedConstraints(): void {
    for (const [id, record] of [...this.constraints].sort(([a], [b]) => order(a, b))) {
      const spec = record.spec;
      if (spec.kind === undefined) continue;
      const first = this.bodies.get(spec.a), second = this.bodies.get(spec.b);
      if (!first || !second) { this.constraints.delete(id); continue; }
      const a = this.native.getRigidBody(first.handle)!, b = this.native.getRigidBody(second.handle)!;
      const at = (body: RAPIER.RigidBody, local: Point): Point => {
        const angle = body.rotation(), c = cos(angle), s = sin(angle), p = body.translation();
        return { x: p.x * SCALE + local.x * c - local.y * s,
          y: p.y * SCALE + local.x * s + local.y * c };
      };
      const pointA = at(a, spec.anchorA!), pointB = at(b, spec.anchorB!);
      const velocity = (body: RAPIER.RigidBody, point: Point): Point => {
        const v = body.velocityAtPoint({ x: point.x / SCALE, y: point.y / SCALE });
        return { x: v.x * SCALE, y: v.y * SCALE };
      };
      const result = constraintForce(spec,
        { position: pointA, velocity: velocity(a, pointA) },
        { position: pointB, velocity: velocity(b, pointB) });
      if (spec.breakDistance !== undefined && result.distance > spec.breakDistance) {
        this.constraints.delete(id);
        a.wakeUp(); b.wakeUp();
        continue;
      }
      const force = { x: result.force.x / SCALE, y: result.force.y / SCALE };
      if (force.x === 0 && force.y === 0) continue;
      a.addForceAtPoint(force, { x: pointA.x / SCALE, y: pointA.y / SCALE }, true);
      b.addForceAtPoint({ x: -force.x, y: -force.y }, { x: pointB.x / SCALE, y: pointB.y / SCALE }, true);
    }
  }
  step(): { distance: Record<string, number>; paths: Record<string, Point[]> } {
    this.ensure(); this.commitMutations();
    const distance: Record<string, number> = Object.create(null);
    const paths: Record<string, Point[]> = Object.create(null);
    const previous = new Map<string, Point>();
    for (const [id] of this.sortedDynamic) {
      const state = this.getTransform(id)!;
      previous.set(id, { x: state.x, y: state.y }); distance[id] = 0;
      paths[id] = [{ x: state.x, y: state.y }];
    }
    const forces = this.forces.sort((a, b) => order(a.id, b.id));
    const impulses = this.impulses.sort((a, b) => order(a.id, b.id));
    this.forces = []; this.impulses = [];
    for (let substep = 0; substep < SUBSTEPS; substep++) {
      for (const [, record] of this.sortedDynamic) {
        const body = this.native.getRigidBody(record.handle)!;
        body.resetForces(false);
        const motor = record.motor;
        if (motor) {
          const v = body.linvel(), dx = motor.x - v.x * SCALE, dy = motor.y - v.y * SCALE;
          const magnitude = hypot(dx, dy), fraction = magnitude ? Math.min(1, motor.accel * DT / magnitude) : 0;
          body.setLinvel({ x: v.x + dx * fraction / SCALE, y: v.y + dy * fraction / SCALE }, true);
        }
      }
      for (const entry of forces) {
        if (this.hasBody(entry.id)) this.dynamic(entry.id).body.addForce({ x: entry.value.x / SCALE, y: entry.value.y / SCALE }, true);
      }
      if (substep === 0) for (const entry of impulses) {
        if (this.hasBody(entry.id)) this.dynamic(entry.id).body.applyImpulse({ x: entry.value.x / SCALE, y: entry.value.y / SCALE }, true);
      }
      this.applyBoundedConstraints();
      this.capSpeeds(); this.native.step(this.events); this.capSpeeds();
      this.events.drainCollisionEvents((a, b, started) => {
        const first = this.colliderIds.get(a), second = this.colliderIds.get(b);
        if (first && second) {
          if (this.contacts.length >= MAX_EVENTS) throw new RangeError('physics event capacity exceeded');
          this.contacts.push({ a: order(first, second) <= 0 ? first : second,
            b: order(first, second) <= 0 ? second : first, substep, type: started ? 'start' : 'stop' });
        }
      });
      for (const id of previous.keys()) {
        const next = this.getTransform(id)!;
        const old = previous.get(id)!;
        distance[id]! += hypot(next.x - old.x, next.y - old.y);
        paths[id]!.push({ x: next.x, y: next.y });
        previous.set(id, { x: next.x, y: next.y });
      }
    }
    this.contacts.sort((a, b) => a.substep - b.substep || order(a.a, b.a) || order(a.b, b.b) || order(a.type, b.type));
    return { distance, paths };
  }
  drainContacts(): PhysicsContact[] { this.ensure(); return this.contacts.splice(0); }
  /** Final-substep external force accumulators, excluding motor velocity changes
   * and collision impulses. Developer-only; no extra work during ordinary ticks. */
  debugForces(): Array<{ id: string; point: Point; force: Point }> {
    this.ensure();
    return this.sortedDynamic.map(([id, record]) => {
      const body = this.native.getRigidBody(record.handle)!, point = body.translation(), force = body.userForce();
      return { id, point: { x: point.x * SCALE, y: point.y * SCALE },
        force: { x: force.x * SCALE, y: force.y * SCALE } };
    });
  }
  /** Private developer diagnostic, sampled on demand after the final substep.
   * Never include this in a gameplay snapshot or a player projection. */
  debugContacts(): Array<{ a: string; b: string; point: Point; normal: Point; distance: number }> {
    this.ensure();
    const result: Array<{ a: string; b: string; point: Point; normal: Point; distance: number }> = [];
    for (const [id, record] of [...this.bodies].sort(([a], [b]) => order(a, b))) {
      const collider = this.native.getCollider(record.collider);
      this.native.contactPairsWith(collider, other => {
        const otherId = this.colliderIds.get(other.handle);
        if (!otherId || order(id, otherId) >= 0 || result.length >= 256) return;
        this.native.contactPair(collider, other, (manifold, flipped) => {
          const normal = manifold.normal(), sign = flipped ? -1 : 1;
          for (let i = 0; i < manifold.numSolverContacts() && result.length < 256; i++) {
            const point = manifold.solverContactPoint(i);
            if (point) result.push({ a: id, b: otherId,
              point: { x: point.x * SCALE, y: point.y * SCALE },
              normal: { x: normal.x * sign, y: normal.y * sign },
              distance: manifold.solverContactDist(i) * SCALE });
          }
        });
      });
    }
    return result.sort((a, b) => order(a.a, b.a) || order(a.b, b.b)
      || a.point.x - b.point.x || a.point.y - b.point.y);
  }
  counts(): { actors: number; dynamic: number; static: number; constraints: number } {
    this.ensure();
    return { actors: this.actorCount, dynamic: this.dynamicCount, static: this.staticCount, constraints: this.constraints.size };
  }
  snapshot(options: { includeStatic?: boolean } = {}): PhysicsSnapshot {
    this.ensure();
    return clone({ bodies: [...this.bodies].filter(([, record]) => options.includeStatic !== false || record.spec.kind !== 'static')
      .sort(([a], [b]) => order(a, b)).map(([id, record]) => ({
        spec: record.spec, transform: this.getTransform(id)!, generation: record.generation,
        ...(record.motor ? { motor: record.motor } : {}) })),
    constraints: [...this.constraints].sort(([a], [b]) => order(a, b)).map(([, record]) => record.spec),
    pending: { add: this.pendingAdd, remove: this.pendingRemove,
      addConstraints: this.pendingAddConstraints, removeConstraints: this.pendingRemoveConstraints,
      forces: this.forces, impulses: this.impulses } });
  }
  /** Small query view for local navigation: excludes loot, actors and pending/constraint state. */
  solidPropStates(): Array<{ spec: BodySpec; transform: Transform }> {
    this.ensure();
    return this.sortedDynamic.filter(([, record]) => record.spec.kind === 'prop' && record.spec.collisionProfile !== 'loot')
      .map(([id, record]) => ({ spec: clone(record.spec), transform: this.getTransform(id)! }));
  }
  dispose(): void {
    if (this.disposed) return;
    this.events.free(); this.native.free(); this.bodies.clear(); this.colliderIds.clear(); this.constraints.clear();
    this.sortedDynamic = []; this.actorCount = 0; this.dynamicCount = 0; this.staticCount = 0;
    this.nextGeneration = 0;
    this.pendingAdd = []; this.pendingRemove = []; this.pendingAddConstraints = []; this.pendingRemoveConstraints = [];
    this.forces = []; this.impulses = []; this.contacts = [];
    this.disposed = true;
  }
}
