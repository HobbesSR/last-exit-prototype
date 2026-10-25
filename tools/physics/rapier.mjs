import RAPIER from '../../node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs';
let initialization;

const SCALE = 40;
const ZERO = { x: 0, y: 0 };
const GROUP = { actor: 1, prop: 2, loot: 4, static: 8 };
const CONTACT = {
  actor: GROUP.actor | GROUP.prop | GROUP.static,
  prop: GROUP.actor | GROUP.prop | GROUP.static,
  loot: GROUP.static,
  static: GROUP.actor | GROUP.prop | GROUP.loot,
};

const finite = (value, fallback = 0) => {
  const result = value ?? fallback;
  if (!Number.isFinite(result)) throw new TypeError('physics values must be finite');
  return result;
};
const positive = (value, fallback) => {
  const result = finite(value, fallback);
  if (result <= 0) throw new RangeError('physics size/mass must be positive');
  return result;
};
const nonnegative = (value, fallback = 0) => {
  const result = finite(value, fallback);
  if (result < 0) throw new RangeError('physics value must be nonnegative');
  return result;
};
const sorted = map => [...map.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const vec = (x, y) => ({ x: x / SCALE, y: y / SCALE });
const clone = value => structuredClone(value);

function bodyDescriptor(source) {
  if (typeof source?.id !== 'string' || !source.id) throw new TypeError('body id must be a nonempty string');
  if (!Object.hasOwn(GROUP, source.kind)) throw new TypeError('unsupported body kind');
  const shape = source.shape ?? 'circle';
  if (shape !== 'circle' && shape !== 'box') throw new TypeError('unsupported body shape');
  const result = {
    ...source, shape, x: finite(source.x), y: finite(source.y), angle: finite(source.angle),
    vx: finite(source.vx), vy: finite(source.vy), omega: finite(source.omega),
    mass: positive(source.mass, 1), friction: nonnegative(source.friction),
    restitution: nonnegative(source.restitution), drag: nonnegative(source.drag),
    sleeping: Boolean(source.sleeping),
  };
  if (result.restitution > 1) throw new RangeError('restitution must be <= 1');
  if (shape === 'circle') result.radius = positive(source.radius, 8);
  else {
    result.hx = positive(source.hx);
    result.hy = positive(source.hy);
  }
  if (source.motor != null) result.motor = motorDescriptor(source.motor);
  return result;
}

function motorDescriptor(motor) {
  return { x: finite(motor?.x), y: finite(motor?.y), accel: nonnegative(motor?.accel) };
}

function jointDescriptor(source, bodies) {
  if (typeof source?.id !== 'string' || !source.id) throw new TypeError('joint id must be a nonempty string');
  if (source.kind !== 'spring' && source.kind !== 'rope') throw new TypeError('unsupported joint kind');
  if (source.a === source.b || !bodies.has(source.a) || !bodies.has(source.b)) throw new Error('joint endpoints must be distinct existing bodies');
  const backend = source.backend ?? 'game';
  if (backend !== 'game' && backend !== 'native') throw new TypeError('unsupported joint backend');
  if (backend === 'native' && source.kind !== 'spring') throw new TypeError('native backend supports springs only');
  if (backend === 'native' && source.maxForce != null && source.maxForce !== Infinity) {
    throw new TypeError('native springs do not support a finite maxForce');
  }
  return {
    ...source, length: nonnegative(source.length), stiffness: nonnegative(source.stiffness, 20),
    damping: nonnegative(source.damping, 4),
    maxForce: backend === 'native' ? Infinity : nonnegative(source.maxForce, 10000),
  };
}

export async function createWorld(scene, options = {}) {
  await (initialization ??= RAPIER.init());
  if (Object.keys(options).length) throw new Error(`unsupported Rapier lab options: ${Object.keys(options).join(', ')}`);
  let native = new RAPIER.World(ZERO);
  native.lengthUnit = 1;
  native.integrationParameters.normalizedAllowedLinearError = 0.0001;
  // 24 world units: cover capped relative translation (19.2/substep), rather
  // than relying on moving-pair CCD. This is speculative contact, not a skin.
  native.integrationParameters.normalizedPredictionDistance = 0.6;
  native.numSolverIterations = 8;
  native.numInternalPgsIterations = 2;
  native.maxCcdSubsteps = 4;
  const contactErpByDt = {};
  for (const dt of [0.025, 0.0125, 0.00625]) {
    native.timestep = dt;
    contactErpByDt[dt] = native.integrationParameters.contact_erp;
  }
  native.timestep = 1 / 60;
  let bodies = new Map();
  let joints = new Map();
  let nativeJointHandles = new Map();
  let colliderIds = new Map();
  let broadPhaseDirty = true;
  let disposed = false;
  const settings = Object.freeze({
    engine: 'rapier2d-compat', version: '0.21.0', unitsPerMetre: SCALE,
    gravity: { x: 0, y: 0 }, numSolverIterations: native.numSolverIterations,
    numInternalPgsIterations: native.numInternalPgsIterations,
    contactErpByDt: Object.freeze(contactErpByDt),
    normalizedAllowedLinearError: native.integrationParameters.normalizedAllowedLinearError,
    normalizedPredictionDistance: native.integrationParameters.normalizedPredictionDistance,
    maxCcdSubsteps: native.maxCcdSubsteps, ccd: 'enabled on every dynamic body',
    contactGroups: 'loot-static only; actor/prop with actor/prop/static',
    motor: 'bounded velocity target; game-owned linear floor drag',
    joints: 'default game-owned centre spring forces and rope velocity impulses bounded by maxForce; opt-in native centre spring impulse joints are uncapped evaluation-only',
    limitations: [
      'Force-limited rope can stretch past length under saturation or subsequent contact; it has no hard positional constraint.',
      'Rope stiffness and damping fields are unused; rope applies the bounded impulse needed to enforce its length.',
      'Centre anchors only; joint forces do not produce torque.',
      'Native springs do not support finite maxForce and are not an approved hook/rope contract.',
      'Rapier CCD can miss fast relative motion between two moving CCD bodies.',
      'Rapier shape casts use current poses and do not include target motion during the query.',
      'Contact and cast thresholds are limited by Rapier floating-point precision at distant coordinates.',
    ],
  });
  const ensure = () => { if (disposed) throw new Error('Rapier world disposed'); };
  const dynamic = record => record.descriptor.kind !== 'static';
  const rigid = record => native.getRigidBody(record.handle);

  function addBody(source) {
    ensure();
    const descriptor = bodyDescriptor(source);
    if (bodies.has(descriptor.id)) throw new Error(`duplicate body ${descriptor.id}`);
    let desc = descriptor.kind === 'static' ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    desc = desc.setTranslation(descriptor.x / SCALE, descriptor.y / SCALE)
      .setRotation(descriptor.angle).setLinvel(descriptor.vx / SCALE, descriptor.vy / SCALE)
      .setAngvel(descriptor.omega).setCanSleep(true).setSleeping(descriptor.sleeping);
    if (descriptor.kind !== 'static') desc = desc.setCcdEnabled(true);
    if (descriptor.kind === 'actor') desc = desc.lockRotations();
    const rb = native.createRigidBody(desc);
    let colliderDesc = descriptor.shape === 'circle'
      ? RAPIER.ColliderDesc.ball(descriptor.radius / SCALE)
      : RAPIER.ColliderDesc.cuboid(descriptor.hx / SCALE, descriptor.hy / SCALE);
    const groups = (GROUP[descriptor.kind] << 16) | CONTACT[descriptor.kind];
    colliderDesc = colliderDesc.setMass(descriptor.mass).setFriction(descriptor.friction)
      .setRestitution(descriptor.restitution).setCollisionGroups(groups);
    const collider = native.createCollider(colliderDesc, rb);
    bodies.set(descriptor.id, { descriptor, handle: rb.handle, colliderHandle: collider.handle });
    colliderIds.set(collider.handle, descriptor.id);
    broadPhaseDirty = true;
  }

  function removeJoint(id) {
    ensure();
    const handle = nativeJointHandles.get(id);
    if (handle !== undefined) {
      native.removeImpulseJoint(native.getImpulseJoint(handle), true);
      nativeJointHandles.delete(id);
    }
    return joints.delete(id);
  }

  function removeBody(id) {
    ensure();
    const record = bodies.get(id);
    if (!record) return false;
    for (const [jointId, joint] of joints) if (joint.a === id || joint.b === id) removeJoint(jointId);
    native.removeRigidBody(rigid(record));
    colliderIds.delete(record.colliderHandle);
    bodies.delete(id);
    broadPhaseDirty = true;
    return true;
  }

  function addJoint(source) {
    ensure();
    const joint = jointDescriptor(source, bodies);
    if (joints.has(joint.id)) throw new Error(`duplicate joint ${joint.id}`);
    if (joint.backend === 'native') {
      const nativeJoint = native.createImpulseJoint(
        RAPIER.JointData.spring(joint.length / SCALE, joint.stiffness, joint.damping, ZERO, ZERO),
        rigid(bodies.get(joint.a)), rigid(bodies.get(joint.b)), true,
      );
      nativeJointHandles.set(joint.id, nativeJoint.handle);
    }
    joints.set(joint.id, joint);
    for (const id of [joint.a, joint.b]) if (dynamic(bodies.get(id))) rigid(bodies.get(id)).wakeUp();
  }

  function motor(id, target) {
    ensure();
    const record = bodies.get(id);
    if (!record || !dynamic(record)) throw new Error(`unknown dynamic body ${id}`);
    record.descriptor.motor = motorDescriptor(target);
    rigid(record).wakeUp();
  }

  function impulse(id, value) {
    ensure();
    const record = bodies.get(id);
    if (!record || !dynamic(record)) throw new Error(`unknown dynamic body ${id}`);
    rigid(record).applyImpulse(vec(finite(value?.x), finite(value?.y)), true);
  }

  function step(dt) {
    ensure();
    dt = positive(dt);
    native.timestep = dt;
    for (const id of sorted(bodies)) {
      const record = bodies.get(id);
      if (!dynamic(record)) continue;
      const rb = rigid(record);
      rb.resetForces(false);
      const current = rb.linvel();
      let vx = current.x * SCALE, vy = current.y * SCALE;
      const drag = record.descriptor.drag;
      if (drag > 0) {
        const speed = Math.hypot(vx, vy);
        if (speed > 0) {
          const factor = Math.max(0, 1 - drag * dt / speed);
          vx *= factor; vy *= factor;
        }
      }
      const target = record.descriptor.motor;
      if (target) {
        const dx = target.x - vx, dy = target.y - vy;
        const magnitude = Math.hypot(dx, dy);
        if (magnitude > 0) {
          const factor = Math.min(1, target.accel * dt / magnitude);
          vx += dx * factor; vy += dy * factor;
        }
      }
      if (vx !== current.x * SCALE || vy !== current.y * SCALE) rb.setLinvel(vec(vx, vy), true);
    }
    for (const id of sorted(joints)) {
      const joint = joints.get(id);
      if (joint.backend === 'native') continue;
      const a = bodies.get(joint.a), b = bodies.get(joint.b);
      const ar = rigid(a), br = rigid(b);
      const ap = ar.translation(), bp = br.translation();
      const dx = (bp.x - ap.x) * SCALE, dy = (bp.y - ap.y) * SCALE;
      const distance = Math.hypot(dx, dy);
      const nx = distance > 1e-12 ? dx / distance : 1;
      const ny = distance > 1e-12 ? dy / distance : 0;
      const av = ar.linvel(), bv = br.linvel();
      const relativeSpeed = ((bv.x - av.x) * nx + (bv.y - av.y) * ny) * SCALE;
      if (joint.kind === 'rope') {
        const invMass = (dynamic(a) ? ar.invMass() : 0) + (dynamic(b) ? br.invMass() : 0);
        if (invMass === 0) continue;
        const demandedImpulse = (relativeSpeed + (distance - joint.length) / dt) / invMass;
        const boundedImpulse = Math.min(joint.maxForce * dt, Math.max(0, demandedImpulse));
        if (boundedImpulse === 0) continue;
        if (dynamic(a)) ar.applyImpulse(vec(boundedImpulse * nx, boundedImpulse * ny), true);
        if (dynamic(b)) br.applyImpulse(vec(-boundedImpulse * nx, -boundedImpulse * ny), true);
      } else {
        let force = joint.stiffness * (distance - joint.length) + joint.damping * relativeSpeed;
        force = Math.max(-joint.maxForce, Math.min(joint.maxForce, force));
        if (force === 0) continue;
        if (dynamic(a)) ar.addForce(vec(force * nx, force * ny), true);
        if (dynamic(b)) br.addForce(vec(-force * nx, -force * ny), true);
      }
    }
    native.step();
    broadPhaseDirty = false;
  }

  function states() {
    ensure();
    return sorted(bodies).map(id => {
      const record = bodies.get(id), rb = rigid(record);
      const p = rb.translation(), v = rb.linvel();
      return { ...clone(record.descriptor), x: p.x * SCALE, y: p.y * SCALE,
        vx: v.x * SCALE, vy: v.y * SCALE, angle: rb.rotation(), omega: rb.angvel(),
        sleeping: rb.isSleeping() };
    });
  }

  function contacts() {
    ensure();
    const rows = [];
    const seen = new Set();
    for (const id of sorted(bodies)) {
      const record = bodies.get(id);
      const collider = native.getCollider(record.colliderHandle);
      native.contactPairsWith(collider, otherCollider => {
        const otherId = colliderIds.get(otherCollider.handle);
        if (!otherId || otherId === id) return;
        const a = id < otherId ? id : otherId;
        const b = id < otherId ? otherId : id;
        const key = JSON.stringify([a, b]);
        if (seen.has(key)) return;
        seen.add(key);
        const first = native.getCollider(bodies.get(a).colliderHandle);
        const second = native.getCollider(bodies.get(b).colliderHandle);
        native.contactPair(first, second, (manifold, flipped) => {
          let impulse = 0;
          for (let i = 0; i < manifold.numContacts(); i++) {
            impulse += Math.max(0, manifold.contactImpulse(i));
          }
          if (!(impulse > 0)) return;
          const normal = manifold.normal();
          const sign = flipped ? -1 : 1;
          rows.push({ a, b, nx: normal.x * sign, ny: normal.y * sign, impulse: impulse * SCALE });
        });
      });
    }
    rows.sort((left, right) => left.a < right.a ? -1 : left.a > right.a ? 1 :
      left.b < right.b ? -1 : left.b > right.b ? 1 :
        left.nx - right.nx || left.ny - right.ny || left.impulse - right.impulse);
    return rows;
  }

  function cast(query) {
    ensure();
    const x = finite(query?.x), y = finite(query?.y), dx = finite(query?.dx), dy = finite(query?.dy);
    const radius = nonnegative(query?.radius);
    const shape = RAPIER.Ball ? new RAPIER.Ball(radius / SCALE) : RAPIER.ColliderDesc.ball(radius / SCALE).shape;
    const excluded = query.exclude instanceof Set ? query.exclude : new Set(query.exclude == null ? [] : Array.isArray(query.exclude) ? query.exclude : [query.exclude]);
    native.propagateModifiedBodyPositionsToColliders();
    let best = null;
    let candidates;
    if (broadPhaseDirty) candidates = sorted(bodies);
    else {
      const candidateIds = new Set();
      native.collidersWithAabbIntersectingAabb(
        vec(x + dx / 2, y + dy / 2),
        vec(Math.abs(dx) / 2 + radius + 1e-5, Math.abs(dy) / 2 + radius + 1e-5),
        collider => { const id = colliderIds.get(collider.handle); if (id) candidateIds.add(id); return true; },
      );
      candidates = [...candidateIds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    }
    for (const id of candidates) {
      const record = bodies.get(id);
      if (record.descriptor.kind === 'loot' || excluded.has(id)) continue;
      const collider = native.getCollider(record.colliderHandle);
      const hit = shape.castShape(vec(x, y), 0, vec(dx, dy), collider.shape,
        collider.translation(), collider.rotation(), ZERO, 0, 1, true);
      if (!hit) continue;
      const toi = hit.time_of_impact ?? hit.toi;
      if (Number.isFinite(toi) && toi >= 0 && toi <= 1 &&
          (!best || toi < best.toi - 1e-8 || (Math.abs(toi - best.toi) <= 1e-8 && id < best.id))) {
        best = { id, toi };
      }
    }
    return best;
  }

  function checkpoint() {
    ensure();
    return { snapshot: native.takeSnapshot(), bodies: clone([...bodies]), joints: clone([...joints]),
      nativeJointHandles: clone([...nativeJointHandles]) };
  }

  function restore(checkpoint) {
    ensure();
    const replacement = RAPIER.World.restoreSnapshot(checkpoint.snapshot);
    if (!replacement) throw new Error('Rapier snapshot restore failed');
    native.free();
    native = replacement;
    bodies = new Map(clone(checkpoint.bodies));
    joints = new Map(clone(checkpoint.joints));
    nativeJointHandles = new Map(clone(checkpoint.nativeJointHandles ?? []));
    colliderIds = new Map([...bodies].map(([id, record]) => [record.colliderHandle, id]));
    broadPhaseDirty = true;
  }

  function counts() { return { bodies: bodies.size, joints: joints.size }; }

  function dispose() {
    if (disposed) return;
    native.free();
    bodies.clear(); joints.clear(); nativeJointHandles.clear(); colliderIds.clear();
    disposed = true;
  }

  try {
    for (const body of scene?.bodies ?? []) addBody(body);
    for (const joint of scene?.joints ?? []) addJoint(joint);
  } catch (error) { dispose(); throw error; }
  return { settings, step, states, addBody, removeBody, addJoint, removeJoint,
    motor, impulse, checkpoint, restore, cast, contacts, counts, dispose };
}
