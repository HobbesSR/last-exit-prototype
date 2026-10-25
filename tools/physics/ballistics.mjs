// Isolated 2.5D laboratory model. Coordinates are world units; time is seconds.
export const PROFILE = Object.freeze({
  id: 'ballistic-lab-1', dt: 0.05, gravity: 200, radius: 2,
  restitution: 0.5, maxBounces: 1, maxTicks: 200,
});

const TIE = 1e-9;
const LAUNCH_POSITION = 51840;
const LAUNCH_SPEED = 2000;
const MAX_HEIGHT = 1000 + LAUNCH_SPEED ** 2 / (2 * PROFILE.gravity);
const MAX_SPEED = Math.sqrt(LAUNCH_SPEED ** 2 + 2 * PROFILE.gravity * 1000);
const STATE_KEYS = new Set(['id', 'x', 'y', 'z', 'vx', 'vy', 'vz',
  'groundPlaneId', 'age', 'fuse', 'bounces', 'status', 'events']);
const STATUSES = new Set(['flying', 'impact', 'fused', 'landed']);

function finite(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
}

function identity(value, name) {
  if (typeof value !== 'string' || !value || value.length > 128) {
    throw new TypeError(`Invalid ${name}`);
  }
}

function validateState(state, initial = false) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Invalid throw');
  for (const key of Object.keys(state)) if (!STATE_KEYS.has(key)) throw new TypeError(`Unknown throw field ${key}`);
  identity(state.id, 'throw id');
  identity(state.groundPlaneId, 'ground plane id');
  // Launch admission is strict. Stepped states can reach the conservative energy
  // envelope of a launch before their fuse, without becoming invalid inputs.
  const xyLimit = LAUNCH_POSITION + (initial ? 0 : LAUNCH_SPEED * state.age);
  for (const key of ['x', 'y']) finite(state[key], key, -xyLimit, xyLimit);
  finite(state.z, 'z', 0, initial ? 1000 : MAX_HEIGHT + TIE);
  const speedLimit = initial ? LAUNCH_SPEED : MAX_SPEED + TIE;
  for (const key of ['vx', 'vy', 'vz']) finite(state[key], key, -speedLimit, speedLimit);
  if (Math.hypot(state.vx, state.vy, state.vz) > speedLimit) throw new RangeError('Invalid speed');
  finite(state.age, 'age', 0, PROFILE.maxTicks * PROFILE.dt);
  finite(state.fuse, 'fuse', 0, 10);
  if (!Number.isInteger(state.bounces) || state.bounces < 0 || state.bounces > PROFILE.maxBounces) {
    throw new RangeError('Invalid bounce count');
  }
  if (!STATUSES.has(state.status)) throw new TypeError('Invalid throw status');
  if (state.events !== undefined && !Array.isArray(state.events)) throw new TypeError('Invalid events');
}

export function createThrow(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('Invalid overrides');
  const state = {id: 'throw-1', x: 20, y: 50, z: 20, vx: 100, vy: 0, vz: 60,
    groundPlaneId: 'lab-ground', age: 0, fuse: 2, bounces: 0, status: 'flying', ...overrides};
  validateState(state, true);
  return state;
}

function rectangle(rect, name, height = false) {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) throw new TypeError(`Invalid ${name}`);
  if (name !== 'bounds') identity(rect.id, `${name} id`);
  for (const key of ['x', 'y']) finite(rect[key], `${name}.${key}`, -51840, 51840);
  for (const key of ['w', 'h']) finite(rect[key], `${name}.${key}`, 0, 103680);
  if (rect.w === 0 || rect.h === 0 || Math.abs(rect.x + rect.w) > 103680 ||
      Math.abs(rect.y + rect.h) > 103680) throw new RangeError(`Invalid ${name} extent`);
  if (height) {
    finite(rect.zMin, `${name}.zMin`, 0, 1000);
    finite(rect.zMax, `${name}.zMax`, 0, 1000);
    if (rect.zMax < rect.zMin) throw new RangeError(`Invalid ${name} height`);
  }
}

function validateScene(scene, groundPlaneId) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new TypeError('Invalid scene');
  identity(scene.groundPlaneId, 'scene ground plane id');
  if (scene.groundPlaneId !== groundPlaneId) throw new RangeError('Ground plane mismatch');
  rectangle(scene.bounds, 'bounds');
  const holes = scene.holes ?? [];
  const obstacles = scene.obstacles ?? [];
  if (!Array.isArray(holes) || !Array.isArray(obstacles) || holes.length > 1024 || obstacles.length > 1024) {
    throw new RangeError('Invalid scene objects');
  }
  const ids = new Set();
  for (const [list, name, elevated] of [[holes, 'hole', false], [obstacles, 'obstacle', true]]) {
    for (const box of list) {
      rectangle(box, name, elevated);
      if (ids.has(box.id)) throw new RangeError('Duplicate scene id');
      ids.add(box.id);
    }
  }
  return {bounds: scene.bounds, holes, obstacles};
}

function position(s, t) {
  return {x: s.x + s.vx * t, y: s.y + s.vy * t,
    z: s.z + s.vz * t - PROFILE.gravity * t * t / 2};
}

function roots(z, vz, level, horizon) {
  // z + vz*t - g*t²/2 = level, including apex tangencies.
  const discriminant = vz * vz + 2 * PROFILE.gravity * (z - level);
  if (discriminant < 0) return [];
  const d = Math.sqrt(discriminant);
  return [(vz - d) / PROFILE.gravity, (vz + d) / PROFILE.gravity]
    .filter(t => t >= 0 && t <= horizon);
}

function times(s, horizon, box, elevated) {
  const out = [0, horizon];
  const r = PROFILE.radius;
  for (const [coordinate, velocity, lo, hi] of [
    [s.x, s.vx, box.x - r, box.x + box.w + r],
    [s.y, s.vy, box.y - r, box.y + box.h + r],
  ]) {
    if (velocity !== 0) {
      for (const edge of [lo, hi]) {
        const t = (edge - coordinate) / velocity;
        if (t >= 0 && t <= horizon) out.push(t);
      }
    }
  }
  if (elevated) {
    out.push(...roots(s.z, s.vz, box.zMin - 2 * r, horizon));
    out.push(...roots(s.z, s.vz, box.zMax, horizon));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function insideBox(s, t, box, elevated) {
  const p = position(s, t), r = PROFILE.radius;
  return p.x >= box.x - r && p.x <= box.x + box.w + r &&
    p.y >= box.y - r && p.y <= box.y + box.h + r &&
    (!elevated || (p.z >= box.zMin - 2 * r && p.z <= box.zMax));
}

function firstOverlap(s, horizon, box, elevated) {
  const candidates = times(s, horizon, box, elevated);
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    if (insideBox(s, t, box, elevated)) return t;
    if (i + 1 < candidates.length && insideBox(s, (t + candidates[i + 1]) / 2, box, elevated)) return t;
  }
  return Infinity;
}

function firstOuterExit(s, horizon, bounds) {
  const r = PROFILE.radius;
  const sides = [[s.x, s.vx, bounds.x + r, bounds.x + bounds.w - r],
    [s.y, s.vy, bounds.y + r, bounds.y + bounds.h - r]];
  let earliest = Infinity;
  for (const [p, v, lo, hi] of sides) {
    if (lo > hi || p < lo || p > hi) return 0;
    if (v < 0) earliest = Math.min(earliest, (lo - p) / v);
    if (v > 0) earliest = Math.min(earliest, (hi - p) / v);
  }
  return earliest >= 0 && earliest <= horizon ? earliest : Infinity;
}

function firstImpact(s, horizon, scene) {
  let best = {time: firstOuterExit(s, horizon, scene.bounds), obstacleId: 'bounds', order: 0};
  const consider = (time, id, order) => {
    if (time < best.time - TIE || (Math.abs(time - best.time) <= TIE &&
      (order < best.order || (order === best.order && id < best.obstacleId)))) {
      best = {time, obstacleId: id, order};
    }
  };
  for (const hole of scene.holes) consider(firstOverlap(s, horizon, hole, false), hole.id, 0);
  for (const box of scene.obstacles) consider(firstOverlap(s, horizon, box, true), box.id, 1);
  return best;
}

function groundTime(s, horizon) {
  if (s.z === 0 && s.vz <= 0) return 0;
  const descending = (s.vz + Math.sqrt(s.vz * s.vz + 2 * PROFILE.gravity * s.z)) / PROFILE.gravity;
  return descending >= 0 && descending <= horizon ? descending : Infinity;
}

function advance(s, dt) {
  const p = position(s, dt);
  return {...s, ...p, vz: s.vz - PROFILE.gravity * dt, age: s.age + dt};
}

function terminal(s, kind, time, obstacleId) {
  // A terminal pose is pinned at its event; all velocities are cleared.
  const event = {kind, time};
  if (obstacleId !== undefined) event.obstacleId = obstacleId;
  return {...s, z: Math.max(0, s.z), age: kind === 'fuse' ? Math.min(s.age, s.fuse) : s.age,
    vx: 0, vy: 0, vz: 0,
    status: kind === 'fuse' ? 'fused' : kind === 'landing' ? 'landed' : 'impact', events: [event]};
}

export function stepThrow(state, scene, dt = PROFILE.dt) {
  validateState(state);
  finite(dt, 'dt', Number.MIN_VALUE, PROFILE.dt);
  const geometry = validateScene(scene, state.groundPlaneId);
  if (state.status !== 'flying') return {...state, events: []};
  let current = {...state};
  const events = [];
  let elapsed = 0;
  for (let count = 0; count <= PROFILE.maxBounces + 3; count++) {
    const remaining = dt - elapsed;
    if (remaining < 0) break;
    const impact = firstImpact(current, remaining, geometry);
    const fuseTime = current.fuse <= current.age ? 0 : current.fuse - current.age;
    const fuseWithinTick = fuseTime <= remaining + TIE ? Math.min(fuseTime, remaining) : Infinity;
    const landing = groundTime(current, remaining);
    const earliest = Math.min(impact.time, fuseWithinTick, landing);
    if (!Number.isFinite(earliest)) return {...advance(current, remaining), events};
    current = advance(current, earliest);
    elapsed += earliest;
    if (impact.time <= earliest + TIE) {
      const result = terminal(current, 'impact', elapsed, impact.obstacleId);
      return {...result, events: [...events, ...result.events]};
    }
    if (fuseWithinTick <= earliest + TIE) {
      const result = terminal(current, 'fuse', elapsed);
      return {...result, events: [...events, ...result.events]};
    }
    current.z = 0;
    const outgoing = -current.vz * PROFILE.restitution;
    if (current.bounces >= PROFILE.maxBounces || outgoing <= TIE) {
      const result = terminal(current, 'landing', elapsed);
      return {...result, events: [...events, ...result.events]};
    }
    current.vz = outgoing;
    current.bounces++;
    events.push({kind: 'bounce', time: elapsed});
    if (elapsed === dt) return {...current, events};
  }
  throw new RangeError('Ballistic event budget exceeded');
}

export function displayThrow(state) {
  validateState(state);
  return {id: state.id, x: state.x, y: state.y, z: state.z,
    groundPlaneId: state.groundPlaneId, status: state.status,
    shadow: {x: state.x, y: state.y}, sprite: {x: state.x, y: state.y - state.z}};
}
