import { renderedSnapshot } from './helpers/relational.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, setInput, snapshot } from '../shared/simulation.ts';
import { startGame, stepGame } from '../shared/simulation/tick.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { createMatch } from '../server/match.js';
import { createReplayTimeline } from '../public/replay-timeline.js';
import { enqueueExplosionImpulses } from '../shared/simulation/explosion-physics.ts';
import { openArea } from './helpers/arena.js';

const parts = () => ({ map: { seed: 445, width: 800, height: 400,
  playableArea: openArea(800, 400, 100),
  buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
  chargers: [], sensors: [], traps: [],
  items: [{ id: 'sleeping', kind: 'cell', charge: 100, x: 300, y: 200 }],
  physicsProps: [{ id: 'hidden', profile: 'crate', x: 650, y: 200 }],
  entry: { x: 50, y: 200 }, exit: { x: 750, y: 200 }, spawns: [{ x: 120, y: 200 }] },
  content: { ...structuredClone(contentById('content-6')), roster: { contestants: ['A'], gladiators: [] }, discovery: false } });

// The pickup and the drop are the core's (`rust/core/src/tick/tests/item_tests.rs`); this holds that loot never blocks a
// placement and that the removal and the placement reach the frame as typed discontinuities. A stale impulse on a replaced
// body is the world's (`world.rs`), which a started game does not let a test arrange.
test('loot never blocks actor placement, and its pickup and drop are typed discontinuities', async () => {
  const { map, content } = parts(), s = await createGame(445, map, content);
  try {
    const p = s.players[0]; p.bot = false;
    stepGame(s); // the first tick admits the item's body
    assert.ok(startGame(s).boundary.teleport(p.id, [300, 200]), 'a placement onto loot is accepted');
    const seen = [];
    for (let seq = 1; seq <= 3; seq++) { setInput(s, p.id, { seq }); seen.push(...stepGame(s).discontinuities); }
    assert.ok(seen.some(d => d.kind === 'removed' && d.body.kind === 'item'), 'the pickup removes the body');
    setInput(s, p.id, { seq: 4, drop: true });
    assert.ok(stepGame(s).discontinuities.some(d => d.kind === 'placed' && d.body.kind === 'item'), 'the drop places it again');
  } finally { disposePhysics(s); }
});

test('many same-boundary explosions keep one bounded impulse per body/generation', async () => {
  const { map, content } = parts(), s = await createGame(445, map, content);
  try {
    const r = physicsRuntime(s);
    for (let i = 0; i < 200; i++) enqueueExplosionImpulses(s, { x: 200, y: 200 }, 500);
    assert.equal(r.pendingImpulses.length, 3);
    for (const impulse of r.pendingImpulses) assert.ok(Math.hypot(impulse.value.x, impulse.value.y) <= (impulse.id.startsWith('actor:') ? 600 : 300));
  } finally { disposePhysics(s); }
});

test('client maps omit crate authoring while recordings retain engine-free physical frames', async () => {
  const { map, content } = parts();
  const match = await createMatch(445, undefined, map, content);
  try {
    assert.equal(Object.hasOwn(match.payloadMap('live'), 'physicsProps'), false);
    assert.equal(Object.hasOwn(match.payloadMap('spectator', match.snapshot()), 'physicsProps'), false);
    assert.equal(match.map().physicsProps[0].id, 'hidden');
    const a = match.snapshot(), b = match.advance();
    const timeline = createReplayTimeline({ schema: 12, minSchema: 10, map: match.map(), frames: [{ state: a }, { state: b }] });
    // State-only timeline preserves recorded body and item identity across backward seeks.
    assert.deepEqual(timeline.at(b.tick).state.bodies, b.bodies);
    assert.deepEqual(timeline.at(a.tick).state.items, renderedSnapshot(map, a).items);
  } finally { match.dispose(); }
});

// Retired with the rules they called (#1358): a swap reserving its drop's body slots ahead of older overflow is the core's
// (`item_tests.rs`: `a_swap_reserves_its_body_slot_before_a_due_arrival`, `a_successful_swap_reuses_capacity_and_locks_out_only_the_dropper`).

test('invalid tiny physical profiles are refused before item/body admission', async () => {
  for (const change of [p => p.loot.radius = 0.01, p => p.loot.mass = 1e-9, p => p.prop.hx = 0.01]) {
    const { map, content } = parts(); change(content.worldPhysics);
    await assert.rejects(createGame(445, map, content), /world physics profile/);
  }
});

// Forty pickup/drop cycles that conserve the objective and grow no bodies are the core's
// (`item_tests.rs`: `forty_transfers_between_actors_conserve_units_rounds_charge_and_identity`).
