import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapPool } from '../server/map-pool.js';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE, LIVE_ZONE_SIZES, zoneSizeName } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { roomHarness } from './helpers/room-harness.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
/** A generator whose requests wait until the test answers them, with numbered seeds. */
function heldGenerator(makeMap = (seed, size) => ({ seed, size: zoneSizeName(size) })) {
  const held = [];
  let seeds = 100;
  const generate = (seed, size) => new Promise((resolve, reject) => held.push({ seed, size: zoneSizeName(size), resolve: () => resolve(makeMap(seed, size)), reject }));
  return { generate, held, draw: () => ++seeds };
}
const [small, medium] = LIVE_ZONE_SIZES;

test('the pool generates one map at a time, for the size with fewest ready, until each size has its share', async () => {
  const { generate, held, draw } = heldGenerator(), pool = createMapPool({ generate, draw, perSize: 2, sizes: [small, medium] });
  assert.equal(held.length, 1, 'one request at a time');
  for (let i = 0; i < 4; i++) { held[i].resolve(); await settle(); }
  assert.deepEqual(held.map(request => request.size), ['12x6', '24x12', '12x6', '24x12'], 'the default size first on a tie');
  assert.equal(held.length, 4, 'and nothing more once full');
  assert.deepEqual(pool.stock(), { '12x6': 2, '24x12': 2 });

  assert.deepEqual(pool.take(medium), { seed: 102, map: { seed: 102, size: '24x12' } }, 'the oldest map, with its seed');
  assert.equal(held.at(-1).size, '24x12', 'taking one starts its replacement');
  assert.deepEqual(pool.stock(), { '12x6': 2, '24x12': 1 });
  assert.equal(pool.take({ zoneWidth: 5, zoneHeight: 5 }), null, 'a size the pool does not keep');
  pool.close();
});

test('a failed generation is reported and refilling waits for the next map taken', async () => {
  const { generate, held, draw } = heldGenerator(), errors = [];
  const pool = createMapPool({ generate, draw, perSize: 1, sizes: [small], reportError: error => errors.push(error.message) });
  held[0].reject(new Error('generation broke')); await settle();
  assert.deepEqual(errors, ['generation broke']); assert.equal(held.length, 1, 'no retry loop');
  assert.equal(pool.take(small), null, 'nothing ready');
  assert.equal(held.length, 2, 'but asking tries again');
  pool.close();
  held[1].resolve(); await settle();
  assert.deepEqual(pool.stock(), {}, 'a map arriving after close is dropped');
  assert.equal(held.length, 2);
});

test('a room naming no seed opens on a pooled map at once; a named seed or an empty pool generates', async () => {
  const pooled = heldGenerator((seed, size) => generateLiveMap(seed, defaultContent(), size));
  const pool = createMapPool({ generate: pooled.generate, draw: pooled.draw, perSize: 1, sizes: [DEFAULT_LIVE_ZONE_SIZE] });
  const onDemand = [], generateMap = (seed, size) => { onDemand.push(seed); return Promise.resolve(generateLiveMap(seed, defaultContent(), size)); };
  const h = roomHarness({ generateMap, pool });
  try {
    pooled.held[0].resolve(); await settle();
    const room = h.directory.createRoom();
    assert.equal(room.seed, 101, 'the pooled map\'s seed'); assert.ok(room.match, 'its match exists at once');
    assert.deepEqual(h.service.summaries()[0].ready, true); assert.deepEqual(onDemand, []);
    assert.equal(pooled.held.length, 2, 'and the pool refills');

    const seeded = h.directory.createRoom(9);
    assert.equal(seeded.seed, 9); assert.deepEqual(onDemand, [9], 'an explicit seed is generated, not pooled');

    const player = h.peer(); player.send({ type: 'match' });
    assert.equal(onDemand.length, 2, 'matchmaking with the pool empty generates on demand');
    assert.notEqual(player.session.room.seed, 9);
    pooled.held[1].resolve(); await settle();
    const other = h.peer(); other.send({ type: 'match' });
    assert.equal(other.session.room, player.session.room, 'matchmaking still fills the open room first');
    await Promise.all([seeded.ready, player.session.room.ready]);
  } finally { pool.close(); await h.service.close(); }
});
