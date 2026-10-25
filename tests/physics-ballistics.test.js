import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PROFILE, createThrow, stepThrow, displayThrow } from '../tools/physics/ballistics.mjs';
import { captureWitnesses, scene } from '../tools/physics/ballistic-witness.mjs';
import { retainedFrame, drawBallisticFrame } from '../tools/physics/ballistic-playback.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const box = (id, extra = {}) => ({ id, x: 25, y: 40, w: 2, h: 20, zMin: 0, zMax: 80, ...extra });

test('retained laboratory evidence matches complete trajectories and its trace digest', async () => {
  const report = JSON.parse(await readFile('docs/reports/physics-p7-traces.json', 'utf8'));
  assert.deepEqual(report.witnesses, captureWitnesses().witnesses);
  const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(report.traceSha256, sha(JSON.stringify(report.witnesses)));
});

test('bounded thrown-object witnesses distinguish low/tall cover, roof art and explicit window intervals', () => {
  const recording = captureWitnesses();
  const byName = Object.fromEntries(recording.witnesses.map(w => [w.name, w]));
  const last = name => byName[name].frames.at(-1);
  assert.equal(last('low-cover').display.status, 'landed');
  assert.ok(last('low-cover').state.x > 70);
  assert.equal(last('tall-cover').events[0].obstacleId, 'tall');
  close(last('tall-cover').state.x, 58);
  assert.equal(last('decorative-roof').display.status, 'landed');
  assert.equal(last('explicit-ceiling').events[0].obstacleId, 'ceiling');
  assert.ok(last('window-opening').state.x > 70);
  assert.equal(last('window-sill').events[0].obstacleId, 'sill');
  assert.equal(last('window-lintel').events[0].obstacleId, 'lintel');
  assert.equal(last('mask-hole').events[0].obstacleId, 'void');
  close(last('mask-hole').state.x, 38);
  close(last('mask-outer').state.x, 198);
  for (const w of recording.witnesses) {
    assert.ok(w.frames.length <= PROFILE.maxTicks + 1);
    for (const f of w.frames) assert.ok(f.state.z >= 0 && Number.isFinite(f.state.z));
    assert.equal(w.frames.flatMap(f => f.events).filter(e => e.kind !== 'bounce').length, 1);
  }
});

test('analytic sweep detects vertical entry during planar overlap, despite both tick endpoints missing the slab', () => {
  const initial = createThrow({ x: 20, z: 20, vx: 400, vz: -400 });
  const geometry = scene([box('slab', { zMin: 10, zMax: 11 })]);
  const result = stepThrow(initial, geometry);
  const expected = (-400 + Math.sqrt(400 * 400 + 2 * PROFILE.gravity * 9)) / PROFILE.gravity;
  assert.equal(result.status, 'impact');
  close(result.events[0].time, expected);
  close(result.z, 11);
  assert.ok(initial.z > 11 && initial.z + initial.vz * .05 - 100 * .05 ** 2 < 6);
  assert.ok(result.x >= 23 && result.x <= 29);
});

test('apex tangency and descent onto a slab inside a planar footprint are contacts', () => {
  const apex = stepThrow(createThrow({ vx: 0, vz: 5 }),
    scene([box('apex', { x: 18, zMin: 24.0625, zMax: 25 })]));
  assert.equal(apex.status, 'impact'); close(apex.events[0].time, .025);
  const descent = stepThrow(createThrow({ vx: 0, vz: -200 }),
    scene([box('shelf', { x: 18, zMin: 8, zMax: 15 })]));
  assert.equal(descent.status, 'impact'); close(descent.z, 15);
});

test('earliest time precedes tie priority; exact impact/fuse/ground ties have one terminal outcome', () => {
  const initial = createThrow({ z: 1, vz: -15, fuse: .05 });
  const fuse = stepThrow(initial, scene());
  assert.equal(fuse.status, 'fused'); assert.deepEqual(fuse.events, [{ kind: 'fuse', time: .05 }]);
  assert.equal(fuse.bounces, 0);
  const impact = stepThrow(initial, scene([box('wall', { x: 27 })]));
  assert.equal(impact.status, 'impact'); assert.equal(impact.events.length, 1); close(impact.z, 0);
  const earlyFuse = stepThrow(createThrow({ ...initial, fuse: .01 }), scene([box('wall', { x: 27 })]));
  assert.equal(earlyFuse.status, 'fused'); close(earlyFuse.age, .01);
  const landed = stepThrow(createThrow({ ...initial, fuse: 1, bounces: 1 }), scene());
  assert.equal(landed.status, 'landed'); close(landed.z, 0);
  assert.deepEqual(stepThrow(impact, scene()), { ...impact, events: [] });
});

test('bounce consumes remaining tick time and cannot resolve the same terminal twice', () => {
  const initial = createThrow({ z: 1, vz: -40, fuse: 1 });
  const result = stepThrow(initial, scene());
  const t = (-40 + Math.sqrt(2000)) / 200;
  const remaining = .05 - t, outgoing = (40 + 200 * t) * .5;
  assert.equal(result.bounces, 1); assert.equal(result.status, 'flying');
  close(result.events[0].time, t); close(result.age, .05);
  close(result.z, outgoing * remaining - 100 * remaining ** 2);
  close(result.x, 25);
  const expired = stepThrow(createThrow({ ...initial, fuse: .04 }), scene());
  assert.deepEqual(expired.events.map(e => e.kind), ['bounce', 'fuse']); close(expired.age, .04);
});

test('mask wins same-time geometry ties; lexical ID resolves obstacle ties independently of authoring order', () => {
  const initial = createThrow({ vx: 1000, z: 100 });
  const holes = [{ id: 'void', x: 25, y: 40, w: 2, h: 20 }];
  const obstacles = [box('b', { zMax: 200 }), box('a', { zMax: 200 })];
  for (const order of [obstacles, [...obstacles].reverse()]) {
    assert.equal(stepThrow(initial, scene(order)).events[0].obstacleId, 'a');
    assert.equal(stepThrow(initial, scene(order, { holes })).events[0].obstacleId, 'void');
  }
});

test('admission rejects missing legacy height data, invalid planes, non-finite inputs and unbounded work', () => {
  for (const overrides of [{ vx: NaN }, { z: -1 }, { vx: 2001 }, { fuse: 11 }, { bounces: 2 }, { gravity: 2 }])
    assert.throws(() => createThrow(overrides));
  const initial = createThrow();
  const missing = box('legacy'); delete missing.zMax;
  assert.throws(() => stepThrow(initial, scene([missing])));
  assert.throws(() => stepThrow(initial, scene([], { groundPlaneId: 'upstairs' })));
  assert.throws(() => stepThrow(initial, scene(), .1));
  assert.throws(() => stepThrow(initial, scene(Array.from({ length: 1025 }, (_, i) => box(String(i))))));
  const copy = structuredClone(initial), geometry = scene();
  const sceneCopy = structuredClone(geometry);
  stepThrow(initial, geometry); assert.deepEqual(initial, copy); assert.deepEqual(geometry, sceneCopy);
});

test('scene admission rejects misspellings and validates decorative roof art without creating contacts', () => {
  const initial = createThrow();
  assert.throws(() => stepThrow(initial, scene([], { obstacle: [box('typo')] })), /Unknown scene field obstacle/);
  assert.throws(() => stepThrow(initial, scene([], { decorativeRoof: [] })), /Unknown scene field decorativeRoof/);
  const roof = { x: 15, y: 40, w: 30, h: 20 };
  assert.deepEqual(stepThrow(initial, scene([], { decorativeRoofs: [roof] })), stepThrow(initial, scene()));
  for (const decorativeRoofs of [{}, [{ ...roof, w: NaN }], Array(1025).fill(roof)])
    assert.throws(() => stepThrow(initial, scene([], { decorativeRoofs })));
});

test('outer-edge contact ID is reserved for unambiguous boundary reporting', () => {
  const initial = createThrow();
  assert.throws(() => stepThrow(initial, scene([box('bounds')])), /Reserved scene id bounds/);
  assert.throws(() => stepThrow(initial, scene([], {
    holes: [{ id: 'bounds', x: 25, y: 40, w: 2, h: 20 }],
  })), /Reserved scene id bounds/);
  const edge = stepThrow(createThrow({ x: 197, vx: 100 }), scene());
  assert.equal(edge.events[0].obstacleId, 'bounds');
});

test('JSON state-only playback seeks retained poses, holds sparse gaps and draws the stored shadow and sprite', () => {
  const recording = JSON.parse(JSON.stringify(captureWitnesses()));
  const witness = recording.witnesses[0];
  const sparse = { ...witness, frames: [witness.frames[0], witness.frames[5], witness.frames.at(-1)] };
  for (const tick of [9, 0, 5, 1, 999]) {
    const expected = [...sparse.frames].reverse().find(f => f.tick <= tick);
    assert.deepEqual(retainedFrame(sparse, tick), expected);
  }
  const frame = retainedFrame(witness, 5), original = structuredClone(frame);
  const calls = [];
  const ctx = new Proxy({}, { get: (_, method) => (...args) => calls.push([method, ...args]), set: () => true });
  drawBallisticFrame(ctx, witness, frame);
  assert.ok(calls.some(([method, x, y]) => method === 'ellipse' && x === frame.display.x && y === frame.display.y));
  assert.ok(calls.some(([method, x, y]) => method === 'fillRect' && x === frame.display.x - 2 && y === frame.display.y - frame.display.z - 4));
  assert.deepEqual(frame, original);
  assert.deepEqual(frame.display, displayThrow(frame.state));
});

test('admitted extreme launches remain valid throughout their bounded lifetime', () => {
  const geometry = scene([], { bounds: { x: -50000, y: -50000, w: 100000, h: 100000 } });
  for (const launch of [{ z: 1000, vx: 0, vz: 2000 }, { z: 1000, vx: 0, vz: -2000 },
    { z: 1000, vx: 2000, vz: 0 }, { z: 1000, vx: 0, vz: 0, age: 9.95 }]) {
    let state = createThrow({ ...launch, fuse: 10 });
    for (let i = 0; i < PROFILE.maxTicks && state.status === 'flying'; i++) {
      state = stepThrow(state, geometry);
      assert.doesNotThrow(() => displayThrow(state));
      assert.ok(state.z >= 0 && state.age <= 10);
    }
    assert.notEqual(state.status, 'flying');
  }
});
