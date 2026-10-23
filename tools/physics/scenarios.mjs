// Common P0 witnesses. Distances are world units; one tick is 0.05 seconds.
const actor = (id, x, y, extra = {}) => ({ id, kind: 'actor', shape: 'circle', radius: 8, x, y, ...extra });
const prop = (id, x, y, extra = {}) => ({ id, kind: 'prop', shape: 'circle', radius: 8, x, y, ...extra });
const wall = (id, x, y, hx, hy, extra = {}) => ({ id, kind: 'static', shape: 'box', x, y, hx, hy, ...extra });
const act = (tick, method, ...args) => ({ tick, method, args });
const scene = (name, bodies, joints = [], ticks = 40, actions = [], metadata = {}) =>
  ({ name, scene: { bodies, joints }, ticks, actions, ...metadata });

export function baselineScenarios() {
  return [
    scene('head-on', [actor('a', -30, 0, { vx: 35 }), actor('b', 30, 0, { vx: -35 })], [], 35),
    scene('glancing-slide', [actor('a', -30, -6, { vx: 32 }), actor('b', 0, 8)], [], 35),
    scene('coincident-spawn', [actor('a', 0, 0), actor('b', 0, 0)], [], 12, [],
      { invalidStart: true, expectedInitialOverlap: true }),
    scene('three-body-corner', [
      wall('north', 0, -25, 40, 2), wall('east', 25, 0, 2, 40),
      actor('a', -13, 0, { vx: 22 }), actor('b', -13, 17, { vx: 20, vy: -5 }),
      actor('c', 7, 12, { vx: -4, vy: -14 }),
    ], [], 55),
    scene('mixed-roles', [
      wall('wall', 35, 0, 2, 40), actor('a', -32, 0, { vx: 30, role: 'contestant' }),
      actor('gladiator', -32, -22, { vx: 30, radius: 10, role: 'gladiator' }),
      prop('crate', 0, 0, { mass: 4 }),
      { id: 'loot', kind: 'loot', shape: 'circle', radius: 3, x: -17, y: 19, vx: 22, vy: 0 },
    ], [], 55),
    scene('stationary-blocker', [actor('moving', -36, 0, { vx: 40 }), actor('blocker', 0, 0, { mass: 100 })], [], 40),
    scene('dense-doorway-queue', [
      wall('top', 0, -38, 4, 28), wall('bottom', 0, 38, 4, 28),
      ...Array.from({ length: 8 }, (_, i) => actor(`a${i}`, -58 - Math.floor(i / 2) * 18, (i % 2 ? 9 : -9),
        { motor: { x: 180, y: 0, accel: 360 } })),
    ], [], 100),
    scene('ice-acceleration-braking', [actor('a', 0, 0, { friction: 0, drag: 0,
      motor: { x: 180, y: 0, accel: 18 } })], [], 60,
    [act(25, 'motor', 'a', { x: -180, y: 0, accel: 18 })]),
    scene('slow-terrain', [actor('a', 0, 0, { drag: 3, motor: { x: 55, y: 0, accel: 24 } })], [], 60),
    scene('impulse-while-steering', [actor('a', 0, 0, { motor: { x: 90, y: 0, accel: 20 } })], [], 60,
      [act(15, 'impulse', 'a', { x: -45, y: 20 })]),
    scene('push-prop', [actor('a', -40, 0, { vx: 40 }), prop('crate', 0, 0, { mass: 3 })], [], 50),
    scene('resting-contact', [wall('wall', 0, 0, 3, 30), actor('a', -11, 0)], [], 45),
    scene('rotating-long-box', [
      wall('wall', 0, 0, 2, 65), prop('beam', -35, 8, { shape: 'box', hx: 22, hy: 3, omega: 5, vx: 26 }),
    ], [], 45),
    scene('sleeping-wake', [prop('crate', 0, 0, { sleeping: true }), actor('a', -35, 0, { vx: 35 })], [], 45),
    scene('fast-thin-wall', [wall('thin', 0, 0, 0.5, 32), actor('fast', -35, 0, { vx: 1400 })], [], 4),
    scene('moving-pair-crossing', [actor('a', -35, 0, { vx: 1400 }), actor('b', 35, 0, { vx: -1400 })], [], 4),
    // The four boxes are a rectangular ring. This tests one explicit hole;
    // it makes no claim about arbitrary raster-mask topology.
    scene('mask-hole-ring', [
      wall('left', -28, 0, 3, 32), wall('right', 28, 0, 3, 32),
      wall('top', 0, -28, 25, 3), wall('bottom', 0, 28, 25, 3),
      actor('inside', 0, 0, { vx: 800 }), actor('outside', -50, -50, { vx: 800, vy: 800 }),
    ], [], 6),
    scene('distant-coordinates', [wall('thin', 1_000_000, 1_000_000, 0.5, 25),
      actor('a', 999_965, 1_000_000, { vx: 1400 })], [], 4),
    scene('spring-decay', [actor('a', 0, 0, { mass: 1 }), actor('b', 50, 0, { mass: 1 })],
      [{ id: 'spring', kind: 'spring', a: 'a', b: 'b', length: 40, stiffness: 20, damping: 4 }],
      80, [], { springReference: { a: 'a', b: 'b', length: 40, atSeconds: 1,
        // Relative displacement x(t) = x0 exp(-gamma*t) *
        // [cos(wd*t) + gamma/wd*sin(wd*t)], for two free unit masses.
        expectedAmplitude: Math.abs(10 * Math.exp(-4) *
          (Math.cos(Math.sqrt(24)) + 4 / Math.sqrt(24) * Math.sin(Math.sqrt(24)))),
        tolerance: 0.05, initialAmplitude: 10, reducedMass: 0.5,
        stiffness: 20, damping: 4 } }),
    scene('zero-distance-spring', [actor('a', 0, 0), actor('b', 0, 0)],
      [{ id: 'spring', kind: 'spring', a: 'a', b: 'b', length: 15 }], 20, [],
      { invalidStart: true, expectedInitialOverlap: true }),
    scene('rope-slack', [actor('a', 0, 0, { vx: -5 }), actor('b', 20, 0, { vx: 5 })],
      [{ id: 'rope', kind: 'rope', a: 'a', b: 'b', length: 30 }], 50),
    scene('rope-unequal-mass', [actor('a', 0, 0, { mass: 1, vx: -30 }),
      actor('b', 28, 0, { mass: 10, vx: 30 })],
      [{ id: 'rope', kind: 'rope', a: 'a', b: 'b', length: 30 }], 35),
    scene('rope-blocked-pull', [wall('wall', 0, 0, 3, 30),
      actor('a', -18, 0, { vx: -30, motor: { x: -80, y: 0, accel: 120 } }), actor('b', 18, 0)],
      [{ id: 'rope', kind: 'rope', a: 'a', b: 'b', length: 36 }], 40),
    scene('opposing-tethers', [actor('left', -30, 0, { mass: 10 }),
      actor('middle', 0, 0, { vx: 20 }), actor('right', 30, 0, { mass: 10 })],
      [{ id: 'l', kind: 'rope', a: 'left', b: 'middle', length: 30 },
        { id: 'r', kind: 'rope', a: 'middle', b: 'right', length: 30 }], 60),
    scene('deletion-lifecycle', [actor('a', 0, 0), actor('b', 30, 0)],
      [{ id: 'rope', kind: 'rope', a: 'a', b: 'b', length: 30 }], 30,
      [act(10, 'removeBody', 'b'), act(15, 'addBody', actor('b', 30, 0)),
        act(16, 'addJoint', { id: 'rope2', kind: 'rope', a: 'a', b: 'b', length: 30 }),
        act(25, 'removeJoint', 'rope2')]),
    scene('door-deferred-closure', [actor('a', -22, 0, { vx: 35 })], [], 50,
      [act(10, 'closeDoor', wall('door', 0, 0, 2, 25)), act(32, 'removeBody', 'door')],
      { doorClosure: { doorId: 'door', deferUntilClear: true } }),
  ];
}

// #451: frozen P0 reports retain baselineScenarios. Scale contact geometry to
// contestant r=12, use the real r=23 gladiator, and test supported live extents.
export function bodySpeedCap(radius, substeps) {
  if (!Number.isFinite(radius) || !(radius > 0) || ![2, 4, 8].includes(substeps)) throw new RangeError('invalid motion envelope');
  return 16 * Math.min(radius, 12) * substeps;
}

export function admitMotion(bodies, substeps) {
  for (const body of bodies) {
    if (body.kind === 'static') continue;
    const radius = body.shape === 'box' ? Math.min(body.hx, body.hy) : (body.radius ?? 8);
    const speed = Math.hypot(body.vx ?? 0, body.vy ?? 0);
    if (!Number.isFinite(speed) || speed > bodySpeedCap(radius, substeps))
      return { admitted: false, id: body.id, speed, cap: bodySpeedCap(radius, substeps), route: 'swept-query-or-explicit-teleport' };
  }
  return { admitted: true };
}

export function scenarios(substeps = 4) {
  const rows = baselineScenarios().map(source => {
    const s = structuredClone(source);
    const scaleBody = b => {
      for (const k of ['x', 'y', 'radius', 'hx', 'hy']) if (b[k] != null) b[k] *= 1.5;
    };
    s.scene.bodies.forEach(scaleBody);
    for (const j of s.scene.joints) j.length *= 1.5;
    for (const a of s.actions) {
      if (['addBody', 'closeDoor'].includes(a.method)) scaleBody(a.args[0]);
      if (a.method === 'addJoint') a.args[0].length *= 1.5;
    }
    delete s.springReference;
    return s;
  });
  const find = name => rows.find(s => s.name === name);
  const mixed = find('mixed-roles').scene.bodies;
  mixed.find(b => b.id === 'gladiator').radius = 23;
  mixed.find(b => b.id === 'gladiator').y = -42;
  const cap = bodySpeedCap(12, substeps);
  find('fast-thin-wall').scene.bodies.find(b => b.id === 'fast').vx = cap;
  const pair = find('moving-pair-crossing');
  pair.scene.bodies[0].vx = cap; pair.scene.bodies[1].vx = -cap;
  // Eight phase offsets prevent a lucky substep alignment hiding pass-through.
  pair.speedAdmission = true;
  for (const offset of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
    const s = structuredClone(pair); s.name = `moving-pair-offset-${offset}`;
    s.scene.bodies.forEach(b => { b.x += cap * 0.05 / substeps * offset; });
    // Vary separation too, rather than merely translating the whole pair.
    s.scene.bodies[1].x += cap * 0.05 / substeps * offset;
    rows.push(s);
  }
  for (const radius of [12, 23]) {
    const c = bodySpeedCap(radius, substeps);
    rows.push(scene(`over-cap-refused-r${radius}`, [actor('a', -60, 0, { radius, vx: c * 1.01 }),
      actor('b', 60, 0, { radius, vx: -c * 1.01 })], [], 4, [],
      { speedAdmission: true, expectRefused: true }));
    rows.push(scene(`game-pair-r${radius}`, [actor('a', -60, 0, { radius, vx: c }),
      actor('b', 60, 0, { radius, vx: -c })], [], 12, [], { speedAdmission: true }));
  }
  const mask = find('mask-hole-ring').scene.bodies;
  Object.assign(mask.find(b => b.id === 'inside'), { vx: cap });
  Object.assign(mask.find(b => b.id === 'outside'), { vx: cap / Math.SQRT2, vy: cap / Math.SQRT2 });
  const distant = find('distant-coordinates');
  distant.scene.bodies = [wall('thin', 51_820, 25_900, 0.5, 25), actor('a', 51_785, 25_900, { radius: 12, vx: cap })];
  distant.liveEnvelope = { width: 51_840, height: 25_920 };
  for (const [stiffness, damping] of [[20, 4], [2000, 60], [20000, 200]]) {
    const s = stiffness === 20 ? find('spring-decay') : structuredClone(find('spring-decay'));
    if (stiffness !== 20) s.name = `native-spring-stiff-${stiffness}`;
    Object.assign(s.scene.joints[0], { backend: 'native', stiffness, damping });
    s.springStability = { a: 'a', b: 'b', length: 60, maxAmplitude: 15, settleSeconds: 3, settledAmplitude: 0.5 };
    if (stiffness !== 20) rows.push(s);
  }
  // Invalid coincident probe remains explicitly outside promotion gates.
  find('zero-distance-spring').scene.joints[0].backend = 'native';
  return rows;
}

// Capacity cells are reproducible and separated even at 64 actors/512 bodies.
export function workload({ actors = 11, bodies = 0, tethers = 0, clustered = false,
  sleeping = 0, seed = 1 } = {}) {
  for (const [key, value] of Object.entries({ actors, bodies, tethers, sleeping })) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${key} must be a nonnegative integer`);
  }
  if (sleeping > bodies) throw new RangeError('sleeping cannot exceed bodies');
  const count = actors + bodies;
  if (tethers > count * (count - 1) / 2) throw new RangeError('too many unique tethers');
  let s = seed >>> 0;
  const random = () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
  const placed = [];
  for (let i = 0; i < count; i++) {
    const group = Math.floor(i / 100);
    const local = i % 100;
    const column = local % 10;
    const row = Math.floor(local / 10);
    const pitch = clustered ? 17 : 38;
    const x = group * 500 + column * pitch + (random() - 0.5) * 0.4;
    const y = row * pitch + (random() - 0.5) * 0.4;
    placed.push(i < actors
      ? actor(`a${i}`, x, y, { vx: (random() - 0.5) * 12,
        motor: { x: clustered ? 35 : 65, y: (random() - 0.5) * 20, accel: 80 } })
      : prop(`p${i - actors}`, x, y, { sleeping: i - actors < sleeping,
        vx: i - actors < sleeping ? 0 : (random() - 0.5) * 8,
        vy: i - actors < sleeping ? 0 : (random() - 0.5) * 8 }));
  }
  const pairs = [];
  if (tethers) {
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++)
      pairs.push({ i, j, distance: Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y) });
    pairs.sort((a, b) => a.distance - b.distance || a.i - b.i || a.j - b.j);
  }
  const joints = pairs.slice(0, tethers).map(({ i, j, distance }, n) =>
    ({ id: `t${n}`, kind: 'rope', a: placed[i].id, b: placed[j].id, length: distance + 1 }));
  const groupCount = Math.max(1, Math.ceil(count / 100));
  const east = (groupCount - 1) * 500 + 450;
  const bounds = [wall('bound-west', -120, 180, 4, 330),
    wall('bound-east', east, 180, 4, 330),
    wall('bound-north', east / 2 - 60, -120, east / 2 + 64, 4),
    wall('bound-south', east / 2 - 60, 480, east / 2 + 64, 4)];
  const pillars = Array.from({ length: groupCount }, (_, i) =>
    wall(`pillar-${i}`, i * 500 + 420, 210, 8, 25));
  return { bodies: [...placed, ...bounds, ...pillars], joints };
}
