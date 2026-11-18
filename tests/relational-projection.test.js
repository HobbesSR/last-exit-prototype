import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizePhysics } from '../shared/simulation.ts';
import { createMatch } from '../server/match.js';
import { broadcast, remember, viewEncoders } from '../server/room-views.js';
import { contentById } from '../shared/simulation/content.ts';
import { arena } from './helpers/arena.js';
import { readServerMessage } from '../shared/wire-schema.ts';

const scene = () => arena({ seed: 1153, cols: 10, rows: 8, cellSize: 100,
  spawns: [{ x: 200, y: 300 }], hunterSpawns: [{ x: 400, y: 300 }],
  items: [{ id: 'loot', kind: 'cell', charge: 100, x: 300, y: 300 }],
  gates: [{ id: 'door-2', kind: 'door', x: 700, y: 300, w: 20, h: 70, open: false, locked: true }] }).map;
const content = () => ({ ...structuredClone(contentById('content-7')), discovery: false,
  roster: { contestants: ['Original'], gladiators: [{ name: 'Hunter', kit: 'hook' }] } });

test('wire self/observed records use numeric relations, one pose and dynamic-only gates', async () => {
  const match = await createMatch(1153, undefined, scene(), content());
  try {
    match.join('session', 'contestant', 'runner', 'First');
    const captured = match.snapshot(), view = match.project(captured, 'session');
    assert.equal(view.self.playerIdx, 0);
    assert.deepEqual(view.players.map(p => p.playerIdx), [1]);
    for (const p of [view.self, ...view.players]) {
      for (const key of ['id', 'name', 'role', 'kit', 'seat', 'x', 'y']) assert.equal(Object.hasOwn(p, key), false, key);
    }
    const item = view.items[0], body = view.bodies.find(b => b.owner.kind === 'item');
    assert.equal(typeof item.id, 'number'); assert.equal(body.owner.itemId, item.id);
    assert.equal('x' in item, false); assert.equal('y' in item, false);
    assert.ok(view.bodies.every(b => typeof b.id === 'number' && b.owner && b.shape));
    assert.deepEqual(view.gates, [{ gateIdx: 0, open: false, locked: true }]);
    const map = match.payloadMap('live');
    assert.equal(map.gates[0].gateIdx, 0); assert.equal(map.gates[0].x, 700);
    assert.equal(match.seatMetadata(captured)[0].name, 'First');
    match.diagnosticState.players[0].status = 'eliminated';
    // A capture with no active actor body retains its explicit fallback pose.
    synchronizePhysics(match.diagnosticState);
    const bodyless = match.snapshot();
    assert.equal(bodyless.bodies.some(b => b.owner.kind === 'actor' && b.owner.playerIdx === 0), false);
    assert.equal(bodyless.players[0].x, 200);
  } finally { match.dispose(); }
});

test('seat updates follow the selected historical tick and precede its state', async () => {
  const match = await createMatch(1153, undefined, scene(), content());
  try {
    const history = match.snapshot(), received = [], session = { deliver(text) { received.push(readServerMessage(text)); return true; } };
    const room = { match, clients: new Set([session]), history: [history], ...viewEncoders() };
    match.join('late', 'contestant', 'runner', 'Replacement');
    const current = match.snapshot();
    broadcast(room, current);
    assert.deepEqual(received.map(m => m.type), ['seats', 'state']);
    assert.equal(received[0].roster[0].name, 'Original');
    received.length = 0;
    // Same tick, new captured history (as with a paused room's replacement frame).
    remember(room, current); broadcast(room, current);
    assert.deepEqual(received.map(m => m.type), ['seats', 'state']);
    assert.equal(received[0].roster[0].name, 'Replacement');
    assert.equal(match.seatMetadata(history)[0].name, 'Original');
    received.length = 0; broadcast(room, current);
    assert.deepEqual(received.map(m => m.type), ['state'], 'unchanged metadata is not repeated each tick');
  } finally { match.dispose(); }
});
