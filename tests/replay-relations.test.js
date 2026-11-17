import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameNormalizer, bodyRelations } from '../public/relational-frame.js';
import { createReplayTimeline } from '../public/replay-timeline.js';
import { createPhysicsPrediction } from '../public/physics-prediction.js';
import { openArea } from './helpers/arena.js';

const shape = { kind: 'circle', radius: 10 };
const actor = (id, playerIdx, x) => ({ id, kind: 'actor', owner: { kind: 'actor', playerIdx }, shape, generation: 1, x, y: 50, angle: 0, vx: 0, vy: 0 });
const map = { width: 400, height: 200, obstacles: [], playableArea: openArea(400, 200, 100),
  gates: [{ gateIdx: 0, id: 'door', kind: 'door', x: 200, y: 50, w: 10, h: 20, open: false }] };

test('live numeric relations hydrate self, item poses and static gates without retaining private state in roster', () => {
  const frames = createFrameNormalizer(map, [{ playerIdx: 0, id: 'c0', name: 'Ada', role: 'contestant' }]);
  const source = { tick: 1, self: { playerIdx: 0, status: 'active', inventory: ['private'] }, players: [],
    items: [{ id: 7 }], gates: [{ gateIdx: 0, open: true, locked: false }],
    bodies: [actor(3, 0, 20), { id: 4, kind: 'prop', owner: { kind: 'item', itemId: 7 }, shape, x: 30, y: 40, angle: 0 }] };
  const shown = frames.normalize(source);
  assert.deepEqual([shown.players[0].id, shown.players[0].x, shown.items[0].x], ['c0', 20, 30]);
  assert.equal(shown.bodies[0].id, 3);
  assert.equal(bodyRelations(shown.bodies).byActor(0).id, 3);
  assert.equal(bodyRelations(shown.bodies).byItem(7).id, 4);
  assert.deepEqual([shown.gates[0].x, shown.gates[0].w, shown.gates[0].open], [200, 10, true]);
  assert.equal(map.gates[0].open, false);
  const observed = frames.normalize({ tick: 2, players: [{ playerIdx: 0, status: 'active' }], bodies: [actor(3, 0, 25)] });
  assert.equal(observed.players[0].inventory, undefined);
  frames.seats([{ playerIdx: 0, id: 'replacement', name: 'Bo', role: 'contestant' }]);
  assert.equal(frames.normalize({ players: [{ playerIdx: 0 }] }).players[0].name, 'Bo');
  assert.equal(shown.players[0].name, 'Ada', 'a seat update cannot relabel an older frame');
  assert.equal(source.players.length, 0);
});

test('numeric replay seeks hydrate detached poses and restore gate geometry and historical metadata', () => {
  const state = (tick, name, x, open) => ({ tick, players: [{ playerIdx: 0, id: 'c0', name, status: 'active' }],
    bodies: [actor(3, 0, x)], gates: [{ gateIdx: 0, open, locked: false }] });
  const recording = { map, frames: [{ state: state(1, 'Ada', 10, false) }, { state: state(2, 'Bo', 20, true) }] };
  const before = structuredClone(recording), timeline = createReplayTimeline(recording);
  for (const tick of [2, 1, 2, 1]) {
    const sample = timeline.at(tick).state;
    assert.equal(sample.players[0].x, tick * 10);
    assert.equal(sample.players[0].name, tick === 1 ? 'Ada' : 'Bo');
    assert.equal(sample.gates[0].w, 10);
    assert.equal(sample.gates[0].open, tick === 2);
  }
  assert.equal(timeline.positionAt('c0', 1).x, 10);
  assert.notEqual(timeline.at(1).state.players[0], recording.frames[0].state.players[0]);
  assert.deepEqual(recording, before);
});

test('legacy replay bodies, item owners and tether endpoints normalize to numeric relations', () => {
  const recording = { map, frames: [{ state: { tick: 1, players: [{ id: 'old', name: 'Ada', status: 'active', x: 1, y: 2 }],
    items: [{ id: 'loot', x: 2, y: 3 }], bodies: [
      { ...actor('actor:old', 0, 10), owner: undefined, actorId: 'old' },
      { id: 'item:loot', kind: 'prop', itemId: 'loot', shape, x: 20, y: 30, angle: 0 }],
    tethers: [{ id: 'hook:old', a: 'actor:old', b: 'item:loot' }],
    hookFlights: [{ id: 'flight', a: 'actor:old', x: 15, y: 20 }], gates: [{ id: 'door', open: true }] } }] };
  const frame = createReplayTimeline(recording).at(1).state, relations = bodyRelations(frame.bodies);
  assert.equal(typeof frame.bodies[0].id, 'number');
  assert.equal(frame.players[0].x, 10);
  assert.equal(typeof frame.items[0].id, 'number');
  assert.equal(frame.items[0].x, 20);
  assert.equal(relations.byActor(0).id, frame.tethers[0].a);
  assert.equal(relations.byItem(frame.items[0].id).id, frame.tethers[0].b);
  assert.equal(frame.hookFlights[0].casterIdx, 0);
  assert.equal(frame.gates[0].x, 200);
});

test('prediction resolves actor slot zero and keeps numeric body references across correction', async () => {
  const prediction = await createPhysicsPrediction(map, 'c0', { clock: () => 0 });
  try {
    prediction.correct({ tick: 1, physicsProfile: 'P2', players: [{ playerIdx: 0, id: 'c0', role: 'contestant', status: 'active', x: 20, y: 50 }],
      bodies: [actor(3, 0, 20)], gates: [{ gateIdx: 0, open: true }], tethers: [],
      predictionMotor: { acceleration: 3600, braking: 3600, maxSpeed: 614.4 } });
    assert.equal(prediction.stats().reason, null);
    assert.ok(prediction.input({ seq: 0, tick: 2, x: 1, y: 0 }).x > 20);
  } finally { prediction.dispose(); }
});
