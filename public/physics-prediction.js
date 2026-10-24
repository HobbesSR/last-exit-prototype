import { createPhysicsWorldFactory } from '../shared/physics/world.ts';
import { buildPhysicsGeometry, physicsGate } from '../shared/simulation/physics-geometry.ts';
import { characterMotor } from '../shared/simulation/actor-physics.ts';
import { movementSpeed } from '../shared/movement.ts';
import { bodyRadius } from '../shared/physics/presentation-geometry.ts';

// Limits are deliberately independent of server queue trimming. A lost/stalled
// application frame may require a cut, never unbounded catch-up on the UI thread.
export const PREDICTION_LIMITS = Object.freeze({ inputs: 32, frames: 32, replay: 8, statics: 512, proxies: 128, staleMs: 500 });

/** Approximate local motor only. No simulation, inventory, damage or joint owner is imported. */
export async function createPhysicsPrediction(map, playerId, { clock = () => performance.now() } = {}) {
  const factory = await createPhysicsWorldFactory();
  const geometry = buildPhysicsGeometry(map);
  let world, authority, own, motor, surfaces, value, tick, receivedAt = -Infinity, floor = -1;
  let inputs = [], frames = [], topology, identity;
  const poses = new Map();
  let lastReason = 'initial', replayed = 0, rebuilds = 0, cuts = 0, error = 0;
  const close = () => { world?.dispose(); world = null; };
  // Entire maximum-speed replay horizon, including speculative contact distance.
  const near = body => {
    const reach = bodyRadius(own.shape) + motor.maxSpeed * PREDICTION_LIMITS.replay / 20 + 48;
    const radius = bodyRadius(body.shape);
    return Math.abs(body.x - own.x) <= reach + radius && Math.abs(body.y - own.y) <= reach + radius;
  };
  const proxiesFor = frame => frame.bodies.filter(b => b.id !== own.id && b.itemId === undefined && near(b));
  const pending = () => inputs.filter(i => i.seq > Math.max(floor, authority?.lastSeq ?? -1));
  const cut = reason => {
    close(); lastReason = reason; cuts++;
    floor = Math.max(floor, ...inputs.map(i => i.seq));
    inputs = []; value = authority && { ...authority, ...(own ? { x: own.x, y: own.y } : {}) }; tick = frames.at(-1)?.tick;
  };
  function step(input) {
    input.tick = tick + 1;
    // Timers precede motors on authority too. Ability activation waits for authority.
    value.boost = Math.max(0, (value.boost ?? 0) - 1);
    value.stun = Math.max(0, (value.stun ?? 0) - 1);
    world.setMotor(own.id, characterMotor(motor, surfaces, value,
      input.x ?? 0, input.y ?? 0, movementSpeed(value, input, 20)));
    world.step(); world.drainContacts();
    Object.assign(value, world.getTransform(own.id)); tick++;
    poses.set(tick, { x: value.x, y: value.y });
    while (poses.size > PREDICTION_LIMITS.frames) poses.delete(poses.keys().next().value);
  }
  function rebuild(frame) {
    close();
    // Include each footprint intersecting the entire replay horizon; large walls
    // and void rectangles must be considered even when their centres are distant.
    const statics = [...geometry, ...(frame.gates ?? []).filter(g => !g.open).map(physicsGate)].filter(near);
    const proxies = proxiesFor(frame);
    if (statics.length > PREDICTION_LIMITS.statics || proxies.length > PREDICTION_LIMITS.proxies) return cut('capacity');
    world = factory(); rebuilds++;
    try {
      const bodies = [...statics, ...proxies.map(b => ({ id: `proxy:${b.id}`, kind: 'static', shape: b.shape, x: b.x, y: b.y, angle: b.angle, friction: 0 })),
        { id: own.id, kind: 'actor', shape: own.shape, x: own.x, y: own.y, angle: own.angle, vx: own.vx, vy: own.vy,
          friction: 0, restitution: 0, mass: 1, maxSpeed: motor.maxSpeed }];
      bodies.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (const body of bodies) world.queueAddBody(body);
      world.commitMutations();
      value = { ...authority, x: own.x, y: own.y }; tick = frame.tick;
      for (const input of pending()) { step(input); replayed++; }
    } catch (e) { close(); throw e; }
  }
  function correct(frame) {
    if (frames.length && frame.tick <= frames.at(-1).tick) return value;
    frame = structuredClone(frame);
    const previousTick = frames.at(-1)?.tick, previousPose = poses.get(frame.tick);
    authority = frame.players.find(p => p.id === playerId);
    own = frame.bodies?.find(b => b.actorId === playerId);
    motor = frame.predictionMotor;
    // P1 deliberately did not adopt authored motor surfaces.
    surfaces = frame.physicsProfile === 'last-exit-0.8-physics-1' ? undefined : map.motorSurfaces;
    receivedAt = clock(); replayed = 0;
    // Retain detached, tick-indexed projected history only. Never read render frames.
    frames.push(frame); frames = frames.slice(-PREDICTION_LIMITS.frames);
    inputs = inputs.filter(i => i.seq > (authority?.lastSeq ?? -1));
    const nextIdentity = own && JSON.stringify([frame.physicsProfile, own.id, own.generation, own.shape, motor]);
    const nextTopology = own && motor && JSON.stringify(proxiesFor(frame).map(b => [b.id, b.generation, b.shape]).sort());
    let reason;
    if (!authority || authority.status !== 'active' || !own || !motor || !Number.isFinite(own.vx) || !Number.isFinite(own.vy)) reason = 'unsupported';
    else if (frame.predictionTethered || frame.tethers?.some(t => t.a === own.id || t.b === own.id)) reason = 'tethered';
    else if (identity !== undefined && nextIdentity !== identity) reason = 'profile-or-generation';
    else if (own.discontinuity) reason = 'placement';
    else if (previousTick !== undefined && frame.tick !== previousTick + 1) reason = 'frame-gap';
    else if (topology !== undefined && nextTopology !== topology) reason = 'proxy-lifecycle';
    else if (pending().length > PREDICTION_LIMITS.replay) reason = 'replay-cap';
    else if (inputs.length && (inputs[0].seq > Math.max(floor, authority.lastSeq) + 1 ||
      inputs.some((input, index) => index > 0 && input.seq !== inputs[index - 1].seq + 1))) reason = 'missing-input';
    identity = nextIdentity; topology = nextTopology;
    error = previousPose && authority ? Math.hypot(previousPose.x - authority.x, previousPose.y - authority.y) : null;
    if (reason) cut(reason);
    else { lastReason = null; rebuild(frame); }
    return value;
  }
  function input(input) {
    if (!Number.isSafeInteger(input.seq) || input.seq <= Math.max(floor, authority?.lastSeq ?? -1, inputs.at(-1)?.seq ?? -1)) return value;
    inputs.push({ seq: input.seq, x: input.x, y: input.y, sneak: input.sneak });
    if (inputs.length > PREDICTION_LIMITS.inputs) { cut('input-cap'); return value; }
    if (clock() - receivedAt > PREDICTION_LIMITS.staleMs) { cut('stale-authority'); return value; }
    if (pending().length > PREDICTION_LIMITS.replay) { cut('replay-cap'); return value; }
    if (world) step(inputs.at(-1));
    return value;
  }
  return { correct, input, dispose: close, value: () => value,
    stats: () => ({ reason: lastReason, replayed, rebuilds, cuts, error, tick, inputs: inputs.length, frames: frames.length }) };
}
