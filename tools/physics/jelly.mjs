// Isolated #455 experiment. No live game, collision-radius or damage changes.
import { createWorld } from './rapier.mjs';
import { penetration } from './metrics.mjs';

export const JELLY_PROFILE = Object.freeze({ tickSeconds: 0.05, substeps: 4,
  ringCount: 8, restRadius: 24, nodeRadius: 4, coreRadius: 12,
  stiffness: 2000, damping: 60, pressureScale: 1000,
  compressSeconds: 0.12, recoverSeconds: 0.25, crushThreshold: 0.7,
  releaseThreshold: 0.35, crushHoldTicks: 6 });

export const emptyCompression = () => ({ amount: 0, axisX: 1, axisY: 0,
  heldTicks: 0, crushed: false, pressure: 0 });

// Normal impulse / tick duration is a force proxy, not physical pressure per area.
// Require opposing external loads: a single hit cannot count as a squeeze.
export function stepCompression(previous, contacts, id, dt = JELLY_PROFILE.tickSeconds) {
  if (!Number.isFinite(dt) || dt <= 0) throw new RangeError('positive finite dt required');
  const loads = contacts.filter(c => c.a === id || c.b === id).map(c => ({
    x: c.a === id ? c.nx : -c.nx, y: c.a === id ? c.ny : -c.ny,
    force: c.impulse / dt,
  }));
  let pressure = 0, axisX = previous.axisX, axisY = previous.axisY;
  for (const axis of loads) {
    let positive = 0, negative = 0;
    for (const load of loads) {
      const projected = (load.x * axis.x + load.y * axis.y) * load.force;
      positive += Math.max(0, projected); negative += Math.max(0, -projected);
    }
    const opposed = Math.min(positive, negative);
    if (opposed > pressure) {
      pressure = opposed;
      const sign = axis.x < 0 || (axis.x === 0 && axis.y < 0) ? -1 : 1;
      axisX = axis.x * sign; axisY = axis.y * sign;
    }
  }
  const target = Math.min(1, pressure / JELLY_PROFILE.pressureScale);
  const tau = target > previous.amount ? JELLY_PROFILE.compressSeconds : JELLY_PROFILE.recoverSeconds;
  const amount = target + (previous.amount - target) * Math.exp(-dt / tau);
  const heldTicks = amount >= JELLY_PROFILE.crushThreshold ? previous.heldTicks + 1 : 0;
  const crushed = amount < JELLY_PROFILE.releaseThreshold ? false
    : previous.crushed || heldTicks >= JELLY_PROFILE.crushHoldTicks;
  return { amount, axisX, axisY, heldTicks, crushed, pressure };
}

const circle = (id, kind, x, y, radius, mass = 1) => ({ id, kind, x, y, radius,
  shape: 'circle', mass, friction: 0, restitution: 0, drag: 15 });
const box = (id, kind, x, y, hx, hy, mass = 8) => ({ id, kind, x, y,
  shape: 'box', hx, hy, mass, friction: 0, restitution: 0, drag: 0 });
const action = (tick, method, ...args) => ({ tick, method, args });

function jellySetup(name, stretch, wall) {
  const p = JELLY_PROFILE, core = circle('core', 'actor', 120, 100, p.coreRadius, 4);
  const ring = Array.from({ length: p.ringCount }, (_, i) => {
    const angle = i * Math.PI * 2 / p.ringCount;
    return circle(`node-${i}`, 'prop', 120 + (p.restRadius + stretch) * Math.cos(angle),
      100 + p.restRadius * Math.sin(angle), p.nodeRadius, 2);
  });
  const rest = i => ({ x: p.restRadius * Math.cos(i * Math.PI * 2 / p.ringCount),
    y: p.restRadius * Math.sin(i * Math.PI * 2 / p.ringCount) });
  const joint = (id, a, b, length) => ({ id, a, b, length, kind: 'spring', backend: 'native',
    stiffness: p.stiffness, damping: p.damping });
  const joints = ring.flatMap((node, i) => {
    const j = (i + 1) % ring.length, a = rest(i), b = rest(j);
    return [joint(`spoke-${i}`, core.id, node.id, p.restRadius),
      joint(`edge-${i}`, node.id, ring[j].id, Math.hypot(a.x - b.x, a.y - b.y))];
  });
  return { name, scene: { bodies: [core, ...ring,
    ...(wall ? [box('wall', 'static', 220, 100, 5, 90)] : [])], joints },
  jelly: { coreId: core.id, ringIds: ring.map(b => b.id), restRadius: p.restRadius },
  ticks: 160, settleStartTick: wall ? 120 : 60,
  actions: wall ? [action(1, 'motor', 'core', { x: 80, y: 0, accel: 300 }),
    action(40, 'motor', 'core', { x: -80, y: 0, accel: 300 }),
    action(60, 'motor', 'core', { x: 0, y: 0, accel: 300 })] : [] };
}

function playerSetup(name, opposed) {
  return { name, ticks: 120, scene: { bodies: [circle('player', 'actor', 120, 100, 12),
    box('left', 'actor', 90, 100, 8, 28),
    ...(opposed ? [box('right', 'actor', 150, 100, 8, 28)] : [])], joints: [] },
  jelly: { coreId: 'player', ringIds: [], restRadius: 24 },
  actions: [action(1, 'motor', 'left', { x: 30, y: 0, accel: 400 }),
    ...(opposed ? [action(1, 'motor', 'right', { x: -30, y: 0, accel: 400 })] : []),
    action(50, 'removeBody', 'left'), ...(opposed ? [action(50, 'removeBody', 'right')] : [])] };
}

export function jellySetups() {
  return [jellySetup('stretched jelly recovery', 15, false),
    jellySetup('jelly against wall', 0, true), playerSetup('opposed player squeeze', true),
    playerSetup('one-sided contact control', false)];
}

export async function runJellyWitness(setup) {
  const world = await createWorld(setup.scene), p = JELLY_PROFILE;
  let compression = emptyCompression();
  const frames = [{ tick: 0, bodies: world.states(), compression, events: [] }];
  const metrics = { peakRadialError: 0, tailRadialError: 0, peakStaticPenetration: 0,
    wallCrossings: 0, speedAdmissionFailures: 0, peakCompression: 0, crushEvents: 0 };
  try {
    for (let tick = 1; tick <= setup.ticks; tick++) {
      for (const a of setup.actions) if (a.tick === tick) world[a.method](...a.args);
      const contacts = [];
      for (let substep = 0; substep < p.substeps; substep++) {
        world.step(p.tickSeconds / p.substeps);
        if (setup.jelly.coreId === 'player') contacts.push(...world.contacts());
        const bodies = world.states(), core = bodies.find(b => b.id === setup.jelly.coreId);
        for (const body of bodies) {
          if (![body.x, body.y, body.vx, body.vy, body.angle, body.omega].every(Number.isFinite))
            throw new Error(`${setup.name}: non-finite state`);
          if (body.kind === 'static') continue;
          const radius = body.shape === 'box' ? Math.min(body.hx, body.hy) : body.radius;
          const cap = 0.8 * Math.min(radius, 12) / (p.tickSeconds / p.substeps);
          if (Math.hypot(body.vx, body.vy) > cap + 1e-4) metrics.speedAdmissionFailures++;
          for (const wall of bodies.filter(b => b.kind === 'static')) {
            metrics.peakStaticPenetration = Math.max(metrics.peakStaticPenetration, penetration(body, wall));
            if (body.x > wall.x - wall.hx) metrics.wallCrossings++;
          }
          if (setup.jelly.ringIds.includes(body.id)) {
            const error = Math.abs(Math.hypot(body.x - core.x, body.y - core.y) - p.restRadius);
            metrics.peakRadialError = Math.max(metrics.peakRadialError, error);
            if (tick >= setup.settleStartTick) metrics.tailRadialError = Math.max(metrics.tailRadialError, error);
          }
        }
      }
      const previous = compression;
      compression = stepCompression(compression, contacts, setup.jelly.coreId);
      const events = [];
      if (!previous.crushed && compression.crushed) {
        events.push({ tick, id: setup.jelly.coreId, type: 'lab-crush-threshold' }); metrics.crushEvents++;
      }
      if (previous.crushed && !compression.crushed)
        events.push({ tick, id: setup.jelly.coreId, type: 'lab-recovered' });
      metrics.peakCompression = Math.max(metrics.peakCompression, compression.amount);
      frames.push({ tick, bodies: world.states(), compression, events });
    }
    return { ...structuredClone(setup), settings: world.settings, frames, metrics };
  } finally { world.dispose(); }
}

export async function captureJellyWitnesses() {
  const witnesses = [];
  for (const setup of jellySetups()) witnesses.push(await runJellyWitness(setup));
  return { schema: 'jelly-lab-recording-1', profile: JELLY_PROFILE,
    limitations: ['Lab-only native centre springs; no live gameplay, damage or default activation.',
      'Discrete colliding ring nodes with interpolated artwork; the filled shell is not a continuous collider.',
      'Solid player core never shrinks. Compression is a game-owned opposing-contact force proxy.',
      'Crush threshold and recovery numbers are provisional visual signals, not agreed game rules.',
      'The positive-impulse diagnostic can omit CCD-stopped fixed-wall contacts; crush witnesses use dynamic presses.',
      'Synthetic scenes only; no production capacity, privacy or arbitrary-map containment claim.'], witnesses };
}
