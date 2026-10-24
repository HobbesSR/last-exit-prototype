import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createPhysicsGame, disposePhysics, playerView, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { actorMotor, characterMotor } from '../shared/simulation/actor-physics.ts';

const arena = () => ({ width: 600, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 100, y: 200 }], stations: [], chargers: [], sensors: [],
  items: [], traps: [], routes: [], nodes: [], streets: [], modules: [], buildings: [],
  exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = id => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A'], gladiators: [] } });

test('shared motor keeps the authoritative surface priority, tie break and fallback arithmetic', () => {
  const surfaces = [
    { id: 'z', x: 0, y: 0, w: 100, h: 100, priority: 2, speed: 0.7, traction: 0.1, braking: 0.1 },
    { id: 'a', x: 0, y: 0, w: 100, h: 100, priority: 2, speed: 0.5, traction: 0.2, braking: 0.4 },
  ];
  const p = { x: 10, y: 10 }, profile = { acceleration: 4200, braking: 2200 };
  assert.deepEqual(characterMotor(profile, surfaces, p, 3, 4, 200), { x: 60, y: 80, accel: 840 });
  assert.deepEqual(characterMotor(profile, surfaces, p, 0, 0, 200), { x: 0, y: 0, accel: 880 });
  assert.deepEqual(characterMotor(undefined, surfaces, p, 3, 4, 200), { x: 120, y: 160, accel: 3600 });
  assert.deepEqual(characterMotor(profile, surfaces, { x: 100, y: 10 }, 3, 4, 200), { x: 120, y: 160, accel: 4200 });
  assert.deepEqual(actorMotor({ content: { actorPhysics: profile }, map: { motorSurfaces: surfaces } }, p, 3, 4, 200),
    characterMotor(profile, surfaces, p, 3, 4, 200));
});

test('own physics view publishes only pinned motor tuning; directed and legacy views omit it', async () => {
  const tuned = content('content-physics-2');
  Object.assign(tuned.actorPhysics, { acceleration: 4200, braking: 2200, maxSpeed: 540 });
  tuned.actorPhysics.maxImpulse = 777;
  const game = await createPhysicsGame(1, arena(), tuned);
  try {
    const frame = snapshot(game), id = frame.players[0].id;
    frame.physics.settings.secret = 'private-setting';
    const own = playerView(game, frame, id);
    assert.deepEqual(own.predictionMotor, { acceleration: 4200, braking: 2200, maxSpeed: 540 });
    assert.deepEqual(Object.keys(own.predictionMotor), ['acceleration', 'braking', 'maxSpeed']);
    assert.equal(JSON.stringify(own.predictionMotor).includes('777'), false);
    assert.equal(JSON.stringify(own).includes('private-setting'), false);
    assert.equal(Object.hasOwn(playerView(game, frame, 'missing'), 'predictionMotor'), false);
    assert.equal(Object.hasOwn(playerView(game, { ...frame, bodies: undefined }, id), 'predictionMotor'), false);
    frame.physics.world.constraints.push({ id: 'private-tether', a: `actor:${id}`, b: 'hidden-endpoint', maxDistance: 100 });
    const tethered = playerView(game, frame, id);
    assert.equal(tethered.predictionTethered, true, 'own fallback survives omission of a hidden tether endpoint');
    assert.deepEqual(tethered.tethers, []);
    assert.equal(JSON.stringify(tethered).includes('hidden-endpoint'), false);
    assert.equal(Object.hasOwn(playerView(game, frame, 'missing'), 'predictionTethered'), false);
  } finally { disposePhysics(game); }

  const p1 = await createPhysicsGame(1, arena(), content('content-1'));
  try {
    assert.deepEqual(playerView(p1, snapshot(p1), p1.players[0].id).predictionMotor,
      { acceleration: 3600, braking: 3600, maxSpeed: 768 });
  } finally { disposePhysics(p1); }

  const legacy = createGame(1, arena(), content('content-1'));
  assert.equal(Object.hasOwn(playerView(legacy, snapshot(legacy), legacy.players[0].id), 'predictionMotor'), false);
});
