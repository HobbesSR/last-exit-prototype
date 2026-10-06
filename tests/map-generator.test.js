import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapGenerator } from '../server/map-generator.js';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { roomHarness } from './helpers/room-harness.js';

test('the map worker returns exactly the map generated inline', async () => {
  const maps = createMapGenerator();
  try {
    const [first, second] = await Promise.all([maps.generate(4217, DEFAULT_LIVE_ZONE_SIZE), maps.generate(9, DEFAULT_LIVE_ZONE_SIZE)]);
    assert.equal(JSON.stringify(first), JSON.stringify(generateLiveMap(4217, defaultContent(), DEFAULT_LIVE_ZONE_SIZE)));
    assert.equal(JSON.stringify(second), JSON.stringify(generateLiveMap(9, defaultContent(), DEFAULT_LIVE_ZONE_SIZE)), 'requests are answered in their own order');
  } finally { await maps.close(); }
});

/** A generator whose maps arrive only when the test says, so the time between can be observed. */
function heldGenerator() {
  const held = [];
  const generateMap = (seed, size) => new Promise((resolve, reject) => held.push({ resolve: () => resolve(generateLiveMap(seed, defaultContent(), size)), reject }));
  return { generateMap, held };
}

test('rooms made by an asynchronous generator hold their place, and matchmakers share one', async () => {
  const { generateMap, held } = heldGenerator(), h = roomHarness({ generateMap });
  try {
    const first = h.peer(), second = h.peer(), gone = h.peer();
    first.send({ type: 'match', role: 'contestant' }); second.send({ type: 'match', role: 'any' }); gone.send({ type: 'match' });
    assert.equal(held.length, 1, 'one room is generated for everyone matchmaking meanwhile');
    assert.equal(h.service.rooms.size, 0); assert.equal(first.session.room, undefined);
    h.service.disconnect(gone.session);
    for (let i = 0; i < 7; i++) assert.ok(h.service.createRoom(9));
    assert.equal(h.service.createRoom(9), null, 'a room still generating counts against the cap');
    held[0].resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(first.session.room); assert.equal(first.session.room, second.session.room, 'both join the room they waited for');
    assert.equal(gone.session.room, undefined, 'a session that left meanwhile is not admitted');
    assert.equal(first.messages.find(m => m.type === 'welcome').matchmade, true);
  } finally { await h.service.close(); }
});

test('a generator failure is reported to the matchmaker and frees the place', async () => {
  const { generateMap, held } = heldGenerator(), errors = [];
  const h = roomHarness({ generateMap, reportError: error => errors.push(error.message) });
  try {
    const player = h.peer(); player.send({ type: 'match' });
    held[0].reject(new Error('generation broke')); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, ['generation broke']);
    assert.match(player.messages.at(-1).message, /could not be generated/);
    for (let i = 0; i < 8; i++) assert.ok(h.service.createRoom(9), 'the failed room no longer holds a place');
  } finally { await h.service.close(); }
});
