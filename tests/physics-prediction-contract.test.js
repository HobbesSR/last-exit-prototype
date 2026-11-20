import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, playerView, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { characterMotor } from '../shared/simulation/actor-physics.ts';
import { movementSpeed } from '../shared/movement.ts';
import { HZ } from '../shared/simulation/rules.ts';
import { phaseThree } from '../shared/simulation/phase-three.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { openArea } from './helpers/arena.js';
import { predictionConstants } from '../shared/simulation/physics-presentation.ts';

const arena = () => ({ width: 600, height: 400,
  playableArea: openArea(600, 400, 100),
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 100, y: 200 }], stations: [], chargers: [], sensors: [],
  items: [], traps: [], buildings: [],
  exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = id => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A'], gladiators: [] } });

test('prediction motor equals the authoritative core across speed modifiers, surface ties and braking', async () => {
  const surfaces = [
    { id: 'z', x: 0, y: 0, w: 100, h: 100, priority: 2, speed: 0.7, traction: 0.1, braking: 0.1 },
    { id: 'a', x: 0, y: 0, w: 100, h: 100, priority: 2, speed: 0.5, traction: 0.2, braking: 0.4 },
  ];
  const p = { x: 10, y: 10 }, profile = { acceleration: 4200, braking: 2200 };
  assert.deepEqual(characterMotor(profile, surfaces, p, 3, 4, 200), { x: 60, y: 80, accel: 840 });
  assert.deepEqual(characterMotor(profile, surfaces, p, 0, 0, 200), { x: 0, y: 0, accel: 880 });
  assert.deepEqual(characterMotor({ acceleration: 3600, braking: 3600 }, undefined, p, 3, 4, 200), { x: 120, y: 160, accel: 3600 });
  assert.deepEqual(characterMotor(profile, surfaces, { x: 100, y: 10 }, 3, 4, 200), { x: 120, y: 160, accel: 4200 });
  const tuned = content('content-6');
  tuned.roster.gladiators = [{ name: 'G', kit: 'warden' }];
  Object.assign(tuned.actorPhysics, profile);
  const map = arena(); map.motorSurfaces = surfaces;
  const s = await createGame(1, map, tuned);
  try {
    const r = physicsRuntime(s);
    for (const actor of s.players) for (const boost of [0, 1]) for (const stun of [0, 1]) for (const sneak of [false, true])
      for (const [x, y] of [[0, 0], [3, 4]]) for (const position of [p, { x: 100, y: 10 }]) {
        Object.assign(actor, position, { boost, stun });
        const intents = []; intents[s.players.indexOf(actor)] = { input: { x, y, sneak } };
        phaseThree(s, intents, () => assert.fail('motor-only intent cannot damage'));
        const actual = r.world.snapshot().bodies.find(b => b.spec.id === `actor:${actor.id}`).motor;
        const speed = movementSpeed(actor, { sneak }, HZ);
        assert.deepEqual(actual, characterMotor(profile, surfaces, actor, x, y, speed), `${actor.role}: ${JSON.stringify({ boost, stun, sneak, x, y, position })}`);
      }
  } finally { disposePhysics(s); }
});

test('the match publishes only pinned motor tuning, once; no view repeats it', async () => {
  const tuned = content('content-6');
  Object.assign(tuned.actorPhysics, { acceleration: 4200, braking: 2200, maxSpeed: 540 });
  tuned.actorPhysics.maxImpulse = 777;
  const game = await createGame(1, arena(), tuned);
  try {
    const frame = snapshot(game), id = frame.players[0].id;
    frame.physics = { ...frame.physics, secret: 'private-setting' };
    const own = playerView(game, frame, id);
    // Sent with the map in welcome and ready (server/match.js `constants`), built from the match's content.
    const { predictionMotor } = predictionConstants(game.version, game.content.actorPhysics);
    assert.deepEqual(predictionMotor, { acceleration: 4200, braking: 2200, maxSpeed: 540, surfaces: true });
    assert.deepEqual(Object.keys(predictionMotor), ['acceleration', 'braking', 'maxSpeed', 'surfaces']);
    assert.equal(JSON.stringify(predictionMotor).includes('777'), false);
    assert.equal(JSON.stringify(own).includes('private-setting'), false);
    for (const view of [own, playerView(game, frame, 'missing')]) assert.equal(Object.hasOwn(view, 'predictionMotor'), false);
    frame.physics.world.constraints.push({ id: 'private-tether', a: `actor:${id}`, b: 'hidden-endpoint', maxDistance: 100 });
    const tethered = playerView(game, frame, id);
    assert.equal(tethered.predictionTethered, true, 'own fallback survives omission of a hidden tether endpoint');
    assert.deepEqual(tethered.tethers, []);
    assert.equal(JSON.stringify(tethered).includes('hidden-endpoint'), false);
    assert.equal(Object.hasOwn(playerView(game, frame, 'missing'), 'predictionTethered'), false);
  } finally { disposePhysics(game); }

  const stripped = content('content-6');
  delete stripped.actorPhysics;
  await assert.rejects(createGame(1, arena(), stripped), /actor physics required/);
});
