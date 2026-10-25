import assert from 'node:assert/strict';
import test from 'node:test';
import { captureJellyWitnesses, stepCompression, emptyCompression, JELLY_PROFILE,
  jellySetups, runJellyWitness } from '../tools/physics/jelly.mjs';
import { retainedJellyFrame } from '../tools/physics/jelly-playback.mjs';

const captured = captureJellyWitnesses();

test('native jelly settles after initial stretch and wall loading without admitted-speed or containment failures', async () => {
  const { witnesses } = await captured;
  for (const w of witnesses.slice(0, 2)) {
    assert.ok(w.metrics.peakRadialError <= 15, JSON.stringify(w.metrics));
    assert.ok(w.metrics.tailRadialError <= 0.5, JSON.stringify(w.metrics));
    assert.equal(w.metrics.speedAdmissionFailures, 0);
    assert.equal(w.metrics.wallCrossings, 0);
    assert.ok(w.metrics.peakStaticPenetration <= 0.05, JSON.stringify(w.metrics));
    for (const frame of w.frames) for (const b of frame.bodies) {
      assert.ok(Math.abs(b.x) < 1000 && Math.abs(b.y) < 1000);
      if (b.kind !== 'static') assert.equal(b.radius, b.id === 'core' ? 12 : 4);
    }
  }
  assert.ok(witnesses[1].metrics.peakRadialError > 1, 'wall should measurably deform the shell');
});

test('opposed squeeze emits one held crush signal then recovers with an unchanged core; one-sided control stays neutral', async () => {
  const { witnesses } = await captured;
  const opposed = witnesses[2], control = witnesses[3];
  const events = opposed.frames.flatMap(f => f.events);
  assert.deepEqual(events.map(e => e.type), ['lab-crush-threshold', 'lab-recovered']);
  assert.ok(events[0].tick > JELLY_PROFILE.crushHoldTicks);
  assert.ok(events[1].tick >= 50, 'recovery follows removal of the presses');
  const crushed = opposed.frames.find(f => f.compression.crushed);
  assert.ok(crushed.compression.heldTicks >= JELLY_PROFILE.crushHoldTicks);
  assert.ok(opposed.frames.at(-1).compression.amount < 0.001);
  for (const f of opposed.frames) {
    const core = f.bodies.find(b => b.id === 'player');
    assert.equal(core.radius, 12);
    assert.equal(core.shape, 'circle');
  }
  assert.equal(control.metrics.peakCompression, 0);
  assert.deepEqual(control.frames.flatMap(f => f.events), []);
});

test('a short pressure pulse cannot crush, rotated opposing loads set the visual axis, and recovery clears the signal', () => {
  const rows = [
    { a: 'above', b: 'player', nx: 0, ny: 1, impulse: 100 },
    { a: 'below', b: 'player', nx: 0, ny: -1, impulse: 100 },
  ];
  let state = emptyCompression();
  state = stepCompression(state, rows, 'player');
  assert.equal(state.crushed, false);
  assert.equal(state.axisX, 0); assert.equal(state.axisY, 1);
  for (let i = 0; i < 30; i++) state = stepCompression(state, [], 'player');
  assert.equal(state.axisX, 0); assert.equal(state.axisY, 1, 'recovery preserves the loaded visual direction');
  assert.equal(state.crushed, false);
  assert.ok(state.amount < 0.001);
  for (const dt of [0, -1, NaN, Infinity])
    assert.throws(() => stepCompression(state, rows, 'player', dt), /dt/);
});

test('compression normalizes contact axes without scaling impulse loads', () => {
  const rows = [
    { a: 'player', b: 'left', nx: -1, ny: 0, impulse: 25 },
    { a: 'player', b: 'right', nx: 1, ny: 0, impulse: 25 },
  ];
  const expected = stepCompression(emptyCompression(), rows, 'player');
  const scaled = rows.map(c => ({ ...c, nx: c.nx * 7 }));
  assert.deepEqual(stepCompression(emptyCompression(), scaled, 'player'), expected);
  assert.equal(expected.pressure, 500);
  assert.equal(Math.hypot(expected.axisX, expected.axisY), 1);
  assert.throws(() => stepCompression(emptyCompression(), [{ ...rows[0], nx: 0 }], 'player'), /normal/);
});

test('authored containment planes work with walls on the left and below, and report a crossed plane', async () => {
  for (const rotate of [false, true]) {
    const setup = jellySetups()[1];
    setup.ticks = 45;
    // Reflect horizontally, or rotate 90 degrees: preserve all relative physics.
    for (const b of setup.scene.bodies) {
      const { x, y } = b;
      b.x = rotate ? -y : -x; b.y = rotate ? x : y;
      if (rotate) b.angle = Math.PI / 2;
    }
    for (const a of setup.actions) if (a.method === 'motor') {
      const { x, y } = a.args[1];
      a.args[1].x = rotate ? -y : -x; a.args[1].y = rotate ? x : y;
    }
    setup.containmentPlanes[0].nx = rotate ? 0 : -1;
    setup.containmentPlanes[0].ny = rotate ? 1 : 0;
    const w = await runJellyWitness(setup);
    assert.equal(w.metrics.wallCrossings, 0);
    assert.ok(w.metrics.peakStaticPenetration < 0.05);
    assert.ok(w.metrics.peakRadialError > 1, 'transformed wall is actually contacted');
    // Move only the diagnostic plane behind every body: it must flag violations.
    setup.ticks = 1;
    setup.containmentPlanes[0].offset = -1000;
    assert.ok((await runJellyWitness(setup)).metrics.wallCrossings > 0);
  }
});

test('identical actions reproduce ordered states/events exactly, and engine-free seeking returns detached frames', async () => {
  const first = await captured, second = await captureJellyWitnesses();
  assert.deepEqual(second, first);
  for (const w of first.witnesses) {
    for (const tick of [w.frames.at(-1).tick, 0, 31]) {
      const frame = retainedJellyFrame(w, tick);
      assert.deepEqual(frame, w.frames[tick]);
      frame.bodies[0].x = 9999;
      assert.notEqual(w.frames[tick].bodies[0].x, 9999);
    }
  }
});
