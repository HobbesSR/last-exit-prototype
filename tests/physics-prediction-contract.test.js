import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, playerView, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { characterMotor } from '../shared/simulation/actor-physics.ts';
import { MOVEMENT_SPEED, movementSpeed } from '../shared/movement.ts';
import { HZ } from '../shared/simulation/rules.ts';
import { openArea } from './helpers/arena.js';
import { predictionConstants } from '../shared/simulation/physics-presentation.ts';

const arena = () => ({ width: 600, height: 400,
  playableArea: openArea(600, 400, 100),
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 100, y: 200 }], stations: [], chargers: [], sensors: [],
  items: [], traps: [], buildings: [],
  exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = id => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A'], gladiators: [] } });

// The cases are shared with the core's motor: `rust/core/src/tick/motor.rs` `motor_matches_the_parity_table` reads the
// same file, so neither side can move without the other.
test('prediction motor and speed equal the shared parity table across speed modifiers, surface ties and braking', () => {
  const surfaces = [], rows = [];
  let tuning;
  for (const line of readFileSync(new URL('./fixtures/motor-parity.txt', import.meta.url), 'utf8').split('\n')) {
    const [kind, ...f] = line.split(' ');
    if (kind === 'tuning') tuning = f.map(Number);
    else if (kind === 'surface') {
      const [priority, x, y, w, h, speed, traction, braking] = f.slice(1).map(Number);
      surfaces.push({ id: f[0], priority, x, y, w, h, speed, traction, braking });
    } else if (kind === 'row') rows.push(f);
  }
  const [contestant, gladiator, contestantBoost, gladiatorBoost, stun, sneakScale, acceleration, braking] = tuning;
  assert.deepEqual([contestant / HZ, gladiator / HZ, contestantBoost, gladiatorBoost, stun, sneakScale],
    Object.values(MOVEMENT_SPEED), 'the table is tuned like the game');
  const profile = { acceleration, braking };
  assert.equal(rows.length, 64);
  for (const row of rows) {
    const [role, ...n] = row, [boostFlag, stunFlag, sneakFlag, x, y, px, py, speed, mx, my, accel] = n.map(Number);
    const actor = { role, boost: boostFlag, stun: stunFlag };
    assert.equal(movementSpeed(actor, { sneak: sneakFlag === 1 }, HZ), speed, row.join(' '));
    assert.deepEqual(characterMotor(profile, surfaces, { x: px, y: py }, x, y, speed), { x: mx, y: my, accel }, row.join(' '));
  }
  // Beside the table: no surface list at all, and the tie's winner at a fixed speed.
  const p = { x: 10, y: 10 };
  assert.deepEqual(characterMotor({ acceleration: 3600, braking: 3600 }, undefined, p, 3, 4, 200), { x: 120, y: 160, accel: 3600 });
  assert.deepEqual(characterMotor(profile, surfaces, p, 3, 4, 200), { x: 60, y: 80, accel: 840 });
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
