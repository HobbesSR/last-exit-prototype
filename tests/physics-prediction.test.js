import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsPrediction, PREDICTION_LIMITS } from '../public/physics-prediction.js';

const map = () => ({ width: 600, height: 400, obstacles: [], gates: [],
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) } });
const player = (extra = {}) => ({ id: 'self', role: 'contestant', status: 'active', x: 100, y: 200,
  boost: 0, stun: 0, lastSeq: -1, inventory: ['kept'], health: 80, ...extra });
const body = (extra = {}) => ({ id: 'actor:self', actorId: 'self', kind: 'actor',
  shape: { kind: 'circle', radius: 9.6 }, x: 100, y: 200, angle: 0,
  vx: 0, vy: 0, generation: 1, ...extra });
const frame = (tick, extra = {}) => ({ tick, physicsProfile: 'P2',
  predictionMotor: { acceleration: 3600, braking: 3600, maxSpeed: 614.4 },
  players: [player()], bodies: [body()], tethers: [], gates: [], ...extra });
const move = seq => ({ seq, x: 1, y: 0, sneak: false, attack: true, interact: true });
const predictor = (arena = map(), clock = () => 0) => createPhysicsPrediction(arena, 'self', { clock });

test('local prediction moves with Rapier, replays unconsumed inputs once, and keeps gameplay authoritative', async () => {
  const p = await predictor();
  try {
    const correction = frame(10);
    p.correct(correction);
    const first = p.input(move(0));
    assert.ok(first.x > 100 && first.x < 130, `one tick moved ${first.x}`);
    assert.equal(first.y, 200);
    const once = { ...p.value() };
    p.input(move(0));
    assert.deepEqual(p.value(), once, 'duplicate sequence cannot advance the world');
    assert.deepEqual([p.value().inventory, p.value().health], [['kept'], 80],
      'predicted attack and interact do not resolve gameplay');
    assert.deepEqual(correction, frame(10), 'input does not mutate the correction');

    p.correct(frame(11, { players: [player({ lastSeq: 0 })], bodies: [body({ x: once.x, vx: once.vx })] }));
    assert.equal(p.stats().replayed, 0, 'consumed sequence is not replayed');
    assert.equal(p.value().x, once.x);
    p.input(move(0));
    assert.equal(p.value().x, once.x, 'acknowledged input cannot run twice');
    p.input(move(1));
    const twice = p.value().x;
    assert.ok(twice > once.x);
    p.correct(frame(12, { players: [player({ lastSeq: 0 })], bodies: [body({ x: once.x, vx: once.vx })] }));
    assert.equal(p.stats().replayed, 1);
    assert.ok(Math.abs(p.value().x - twice) < 0.001, 'fresh correction replays one pending tick');
  } finally { p.dispose(); }
});

test('same-tick authorized proxy blocks movement; omission of hidden body does not supply its collision', async () => {
  const proxy = { id: 'actor:other', actorId: 'other', kind: 'actor',
    shape: { kind: 'circle', radius: 9.6 }, x: 130, y: 200, angle: 0,
    vx: 0, vy: 0, generation: 1 };
  const open = await predictor(), blocked = await predictor();
  try {
    open.correct(frame(1));
    blocked.correct(frame(1, { bodies: [body(), proxy] }));
    for (let seq = 0; seq < 5; seq++) { open.input(move(seq)); blocked.input(move(seq)); }
    assert.ok(open.value().x > 130, `omitted hidden proxy left room: ${open.value().x}`);
    assert.ok(blocked.value().x < 112, `authorized proxy stopped travel: ${blocked.value().x}`);
    assert.equal(blocked.stats().reason, null);
  } finally { open.dispose(); blocked.dispose(); }
});

test('map wall remains a fixed blocker in the prediction island', async () => {
  const arena = map();
  arena.obstacles.push({ id: 'wall', x: 130, y: 150, w: 20, h: 100 });
  const p = await predictor(arena);
  try {
    p.correct(frame(1));
    for (let seq = 0; seq < 6; seq++) p.input(move(seq));
    assert.ok(p.value().x < 122, `wall stopped travel: ${p.value().x}`);
    assert.equal(p.stats().reason, null);
  } finally { p.dispose(); }
});

test('sensor loot lifecycle does not invalidate an unrelated local contact island', async () => {
  const p = await predictor();
  try {
    p.correct(frame(1)); p.input(move(0));
    const loot = { ...body({ id: 'item:loot', actorId: undefined }), kind: 'prop', itemId: 'loot' };
    p.correct(frame(2, { bodies: [body(), loot] }));
    assert.equal(p.stats().reason, null);
    assert.equal(p.stats().replayed, 1);
    assert.ok(p.value().x > 100, 'sensor appearance neither blocks nor discards movement');
  } finally { p.dispose(); }
});

test('corrections detach from input frames and cut on gaps, profile, generation, placement and tether', async () => {
  for (const [label, next, reason] of [
    ['gap', frame(3), 'frame-gap'],
    ['profile', frame(2, { physicsProfile: 'P3' }), 'profile-or-generation'],
    ['generation', frame(2, { bodies: [body({ generation: 2 })] }), 'profile-or-generation'],
    ['placement', frame(2, { bodies: [body({ discontinuity: 'placed' })] }), 'placement'],
    ['tether', frame(2, { tethers: [{ a: 'actor:self', b: 'actor:other' }] }), 'tethered'],
    ['hidden tether', frame(2, { predictionTethered: true }), 'tethered'],
  ]) {
    const p = await predictor();
    try {
      const first = frame(1);
      p.correct(first);
      p.input(move(0));
      first.bodies[0].x = 999;
      first.players[0].health = 1;
      p.correct(next);
      assert.equal(p.stats().reason, reason, label);
      assert.equal(p.value().x, 100, `${label} snaps to authority`);
      assert.equal(p.stats().inputs, 0, `${label} clears pending input`);
    } finally { p.dispose(); }
  }
});

test('stale authority and replay overflow cut speculative movement at their limits', async () => {
  let now = 0;
  const stale = await predictor(map(), () => now);
  try {
    stale.correct(frame(1));
    now = PREDICTION_LIMITS.staleMs + 1;
    stale.input(move(0));
    assert.equal(stale.stats().reason, 'stale-authority');
    assert.equal(stale.value().x, 100);
    assert.equal(stale.stats().inputs, 0);
  } finally { stale.dispose(); }

  const capped = await predictor();
  try {
    capped.correct(frame(1));
    for (let seq = 0; seq <= PREDICTION_LIMITS.replay; seq++) capped.input(move(seq));
    assert.equal(capped.stats().reason, 'replay-cap');
    assert.equal(capped.value().x, 100);
    assert.equal(capped.stats().inputs, 0);
    capped.input(move(PREDICTION_LIMITS.replay));
    assert.equal(capped.stats().inputs, 0, 'cut input cannot be re-admitted');
    for (let tick = 2; tick < 40; tick++) capped.correct(frame(tick));
    assert.equal(capped.stats().frames, PREDICTION_LIMITS.frames);
  } finally { capped.dispose(); }
});
