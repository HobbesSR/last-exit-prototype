// Adapter-independent geometric diagnostics for the P0 lab. Path checks sample
// interpolated translation/rotation and detect complete pass-through. They are
// conservative diagnostics, not a proof of continuous collision detection.
const EPS = 1e-8;
const isDynamic = b => b.kind !== 'static';
const contacts = (a, b) => {
  if (a.kind === 'loot' || b.kind === 'loot') return a.kind === 'static' || b.kind === 'static';
  return true;
};
const radius = b => b.shape === 'box' ? Math.hypot(b.hx ?? 8, b.hy ?? 8) : (b.radius ?? 8);
const axes = b => {
  const a = b.angle ?? 0;
  return [[Math.cos(a), Math.sin(a)], [-Math.sin(a), Math.cos(a)]];
};
const dot = (x, y, axis) => x * axis[0] + y * axis[1];
const closestBox = (circle, box) => {
  const [u, v] = axes(box);
  const dx = circle.x - box.x, dy = circle.y - box.y;
  const lx = dot(dx, dy, u), ly = dot(dx, dy, v);
  const cx = Math.max(-(box.hx ?? 8), Math.min(box.hx ?? 8, lx));
  const cy = Math.max(-(box.hy ?? 8), Math.min(box.hy ?? 8, ly));
  return { dx: lx - cx, dy: ly - cy, lx, ly };
};
export function penetration(a, b) {
  if (a.shape !== 'box' && b.shape !== 'box')
    return Math.max(0, (a.radius ?? 8) + (b.radius ?? 8) - Math.hypot(a.x - b.x, a.y - b.y));
  if (a.shape === 'box' && b.shape !== 'box') return penetration(b, a);
  if (a.shape !== 'box') {
    const c = closestBox(a, b);
    const distance = Math.hypot(c.dx, c.dy);
    if (distance > EPS) return Math.max(0, (a.radius ?? 8) - distance);
    // Circle centre is inside the box. The nearest face is the exit distance.
    return (a.radius ?? 8) + Math.min((b.hx ?? 8) - Math.abs(c.lx), (b.hy ?? 8) - Math.abs(c.ly));
  }
  let minimum = Infinity;
  const aa = axes(a), ba = axes(b);
  for (const axis of [...aa, ...ba]) {
    const centre = Math.abs(dot(a.x - b.x, a.y - b.y, axis));
    const ar = (a.hx ?? 8) * Math.abs(dot(...aa[0], axis)) +
      (a.hy ?? 8) * Math.abs(dot(...aa[1], axis));
    const br = (b.hx ?? 8) * Math.abs(dot(...ba[0], axis)) +
      (b.hy ?? 8) * Math.abs(dot(...ba[1], axis));
    const overlap = ar + br - centre;
    if (overlap <= 0) return 0;
    minimum = Math.min(minimum, overlap);
  }
  return minimum;
}
const lerp = (a, b, t) => a + (b - a) * t;
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const between = (a, b, t) => ({ ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t),
  angle: (a.angle ?? 0) + angleDelta(a.angle ?? 0, b.angle ?? 0) * t });

function pathCrosses(a0, a1, b0, b1) {
  if (penetration(a0, b0) > EPS || penetration(a1, b1) > EPS) return false;
  // Exact closest approach for two linearly moving circles.
  if (a1.shape !== 'box' && b1.shape !== 'box') {
    const px = a0.x - b0.x, py = a0.y - b0.y;
    const vx = (a1.x - a0.x) - (b1.x - b0.x);
    const vy = (a1.y - a0.y) - (b1.y - b0.y);
    const vv = vx * vx + vy * vy;
    if (vv < EPS) return false;
    const t = Math.max(0, Math.min(1, -(px * vx + py * vy) / vv));
    return t > EPS && t < 1 - EPS &&
      Math.hypot(px + vx * t, py + vy * t) < (a1.radius ?? 8) + (b1.radius ?? 8) - EPS;
  }
  const travel = Math.hypot((a1.x - a0.x) - (b1.x - b0.x),
    (a1.y - a0.y) - (b1.y - b0.y)) +
    Math.abs(angleDelta(a0.angle ?? 0, a1.angle ?? 0)) * radius(a1) +
    Math.abs(angleDelta(b0.angle ?? 0, b1.angle ?? 0)) * radius(b1);
  const thin = Math.min(a1.shape === 'box' ? Math.min(a1.hx ?? 8, a1.hy ?? 8) : a1.radius ?? 8,
    b1.shape === 'box' ? Math.min(b1.hx ?? 8, b1.hy ?? 8) : b1.radius ?? 8);
  const steps = Math.min(1024, Math.max(8, Math.ceil(travel / Math.max(0.1, thin * 0.5))));
  for (let i = 1; i < steps; i++)
    if (penetration(between(a0, a1, i / steps), between(b0, b1, i / steps)) > EPS) return true;
  return false;
}

const merge = (state, original) => ({ ...original, ...state });
const finiteBody = b => ['x', 'y', 'vx', 'vy', 'angle', 'omega'].every(k => Number.isFinite(b[k] ?? 0));

export function inspect(states, previousStates, scene) {
  const origins = new Map(scene.bodies.map(b => [b.id, b]));
  const bodies = states.map(b => merge(b, origins.get(b.id) ?? {}));
  const previous = new Map((previousStates ?? []).map(b => [b.id, merge(b, origins.get(b.id) ?? {})]));
  const result = { finite: true, staticPenetration: 0, actorPenetration: 0,
    propPenetration: 0, crossings: 0, ropeExcess: 0, details: [] };
  for (const b of bodies) if (!finiteBody(b)) {
    result.finite = false;
    result.details.push({ type: 'nonfinite', id: b.id });
  }
  if (!result.finite) return result;
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], b = bodies[j];
    if (!contacts(a, b) || (a.kind === 'static' && b.kind === 'static')) continue;
    const depth = penetration(a, b);
    const key = a.kind === 'static' || b.kind === 'static' ? 'staticPenetration'
      : a.kind === 'prop' || b.kind === 'prop' ? 'propPenetration' : 'actorPenetration';
    if (depth > result[key]) result[key] = depth;
    if (depth > EPS) result.details.push({ type: 'penetration', ids: [a.id, b.id], depth, class: key });
    const ap = previous.get(a.id), bp = previous.get(b.id);
    if (ap && bp && pathCrosses(ap, a, bp, b)) {
      result.crossings++;
      result.details.push({ type: 'crossing', ids: [a.id, b.id],
        method: a.shape !== 'box' && b.shape !== 'box' ? 'analytic-relative-circle' : 'sampled-obb-path' });
    }
  }
  const byId = new Map(bodies.map(b => [b.id, b]));
  for (const joint of scene.joints) {
    if (joint.kind !== 'rope') continue;
    const a = byId.get(joint.a), b = byId.get(joint.b);
    if (!a || !b) continue; // Removed bodies remove attached joints by contract.
    const excess = Math.max(0, Math.hypot(a.x - b.x, a.y - b.y) - joint.length);
    result.ropeExcess = Math.max(result.ropeExcess, excess);
    if (excess > EPS) result.details.push({ type: 'ropeExcess', id: joint.id, excess });
  }
  return result;
}

// Call with the state sampled at reference.atSeconds. The 5% gate is relative
// to the analytic amplitude at that time, as specified by docs/41.1.
export function evaluateSpring(states, reference) {
  const byId = new Map(states.map(b => [b.id, b]));
  const a = byId.get(reference.a), b = byId.get(reference.b);
  if (!a || !b) return { supported: false, reason: 'missing spring endpoint' };
  const actualAmplitude = Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - reference.length);
  const absoluteError = Math.abs(actualAmplitude - reference.expectedAmplitude);
  const relativeError = absoluteError / reference.expectedAmplitude;
  return { supported: true, actualAmplitude, expectedAmplitude: reference.expectedAmplitude,
    absoluteError, relativeError, passes: relativeError <= reference.tolerance };
}

export function createMetrics(scene) {
  const results = [];
  return {
    inspect(states, previousStates) {
      const measured = inspect(states, previousStates, scene);
      results.push(measured);
      return measured;
    },
    summary() {
      const runs = new Map();
      let staticRecoverySamples = 0;
      for (const r of results) {
        const active = new Set(r.details.filter(d => d.type === 'penetration' &&
          d.class === 'staticPenetration' && d.depth > 0.05).map(d => JSON.stringify(d.ids)));
        for (const key of runs.keys()) if (!active.has(key)) runs.delete(key);
        for (const key of active) {
          const count = (runs.get(key) ?? 0) + 1;
          runs.set(key, count); staticRecoverySamples = Math.max(staticRecoverySamples, count);
        }
      }
      return {
        staticRecoverySamples,
        staticUnrecoveredPairs: runs.size,
        finite: results.every(r => r.finite),
        staticPenetration: Math.max(0, ...results.map(r => r.staticPenetration)),
        actorPenetration: Math.max(0, ...results.map(r => r.actorPenetration)),
        propPenetration: Math.max(0, ...results.map(r => r.propPenetration)),
        crossings: results.reduce((sum, r) => sum + r.crossings, 0),
        ropeExcess: Math.max(0, ...results.map(r => r.ropeExcess)),
        initial: results[0] ?? null,
        samples: results.length,
        details: results.flatMap((r, sample) => r.details.map(detail => ({ sample, ...detail }))),
        pathLimit: 'Circle pairs use analytic relative motion. Box paths use at most 1024 interpolated samples; a crossing may be missed between samples.',
      };
    },
  };
}
