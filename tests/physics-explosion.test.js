import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { enqueueExplosionImpulses } from '../shared/simulation/explosion-physics.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { openArea } from './helpers/arena.js';

function parts() {
  const map = { seed: 445, width: 800, height: 800,
    playableArea: openArea(800, 800, 100),
    buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: 150, y: 400 }], hunterSpawns: [{ x: 650, y: 400 }] };
  const content = structuredClone(contentById('content-6'));
  content.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'warden' }] };
  return { map, content };
}

async function physicsGame() {
  const fixture = parts();
  return createGame(445, fixture.map, fixture.content);
}

// A mine's damage, its next-tick impulses, static cover and the kill-then-next-actor run are the core's:
// `rust/core/src/tick/tests/hazard_tests.rs`, `mine_requires_solved_motion_and_pushes_only_existing_surviving_bodies_next_tick`
// and `static_cover_blocks_a_mines_damage_and_its_impulse`. `enqueueExplosionImpulses` is kept for the boundary test in
// `physics-items-boundaries.test.js`, which still arranges impulses through it.

test('explosion impulse uses linear falloff, deterministic zero-distance direction and stable body ID order', async () => {
  const s = await physicsGame();
  try {
    const runtime = physicsRuntime(s);
    const contestant = s.players.find(player => player.role === 'contestant');
    const gladiator = s.players.find(player => player.role === 'gladiator');
    contestant.x = 300; contestant.y = 400;
    gladiator.x = 360; gladiator.y = 400;
    runtime.world.setTransform(`actor:${contestant.id}`, { x: 300, y: 400, angle: 0 });
    runtime.world.setTransform(`actor:${gladiator.id}`, { x: 360, y: 400, angle: 0 });
    runtime.world.queueAddBody({ id: 'prop:test', kind: 'prop', shape: { kind: 'circle', radius: 8 }, x: 330, y: 400, mass: 1 });
    runtime.world.commitMutations();
    enqueueExplosionImpulses(s, { x: 300, y: 400 }, 120);
    assert.deepEqual(runtime.pendingImpulses.map(effect => effect.id), ['actor:c0', 'actor:g0', 'prop:test']);
    assert.deepEqual(runtime.pendingImpulses.map(effect => effect.value), [
      { x: 300, y: 0 }, { x: 150, y: 0 }, { x: 225, y: 0 },
    ]);
  } finally { disposePhysics(s); }
});
