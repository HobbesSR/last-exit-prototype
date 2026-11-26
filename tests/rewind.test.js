import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, disposePhysics, setInput, step, snapshot } from '../shared/simulation.ts';
import { startGame } from '../shared/simulation/tick.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { viewLagFrom, MAX_REWIND_TICKS } from '../shared/simulation/rewind.ts';
import { HZ, INTERPOLATION_DELAY_TICKS } from '../shared/simulation/rules.ts';
import { createMatch } from '../server/match.js';
import { openField } from './helpers/arena.js';
import { roomHarness } from './helpers/room-harness.js';
import { now } from './helpers/scenario.js';

// On the shipped content and its engine (#920). A gladiator facing +x on open ground, a contestant in reach
// to hit, and a second contestant to the south; `away` is out of the 86 unit reach. The engine pins the map
// at creation, so the case that needs a wall builds it into its own map.
const y = 576, away = 1000;
function parts(obstacles = []) {
  const { map } = openField(2000, { obstacles });
  map.spawns = [{ x: 660, y }, { x: 600, y: 760 }]; map.hunterSpawns = [{ x: 600, y }];
  return { map, content: { ...defaultContent(), roster: { contestants: ['C0', 'C1'], gladiators: [{ name: 'G0', kit: 'warden' }] } } };
}
function seat(s) {
  const attacker = s.players.find(p => p.role === 'gladiator');
  const [target, shooter] = s.players.filter(p => p.role === 'contestant');
  for (const p of s.players) { p.bot = false; p.input = {}; }
  Object.assign(attacker, { heading: 0, attackCd: 0, cooldown: 0 });
  return { s, attacker, target, shooter };
}
/** A case on the duel, disposed of after it; `obstacles` are built into its map. */
const duel = (body, obstacles) => async () => {
  const { map, content } = parts(obstacles), s = await createGame(4217, map, content);
  try { await body(seat(s)); } finally { disposePhysics(s); }
};
/** Build `ticks` of history with the target where it currently stands. */
const settle = (s, ticks = MAX_REWIND_TICKS) => { for (let i = 0; i < ticks; i++) step(s); };

test('view lag is the half trip plus the delay the receive buffer holds a frame', () => {
  assert.equal(viewLagFrom(0), 0, 'no measurement, no compensation');
  assert.equal(viewLagFrom(null), 0);
  // 100 ms round trip is 50 ms one way, one tick at 20 Hz, plus the buffer's own two.
  assert.equal(viewLagFrom(1000 / HZ * 2), 1 + INTERPOLATION_DELAY_TICKS);
  assert.equal(viewLagFrom(10000), MAX_REWIND_TICKS, 'a hopeless connection is bounded, not believed');
});

async function swingAtPastPosition({ measured = false, obstacles = [] } = {}) {
  let hp;
  await duel(({ s, attacker, target }) => {
    const { boundary } = startGame(s);
    if (measured) assert.ok(boundary.roundTrip(attacker.id, 1000 / HZ * 2));
    settle(s);
    assert.ok(boundary.teleport(target.id, [away, y]));
    step(s);
    assert.ok(setInput(s, attacker.id, { seq: 1, attack: true, aim: 0 }));
    step(s);
    hp = now(s, target).hp;
  }, obstacles)();
  return hp;
}

test('without measured latency nothing is rewound', async () => {
  assert.equal(await swingAtPastPosition(), 100, 'a swing at empty space misses');
  assert.ok(await swingAtPastPosition({ measured: true }) < 100, 'measured latency can hit the past position');
});

test('cover is tested at the rewound position too', async () => {
  const wall = [{ id: 'w', kind: 'container', x: 628, y: y - 100, w: 8, h: 200 }];
  assert.ok(await swingAtPastPosition({ measured: true }) < 100, 'the historical target is hittable without cover');
  assert.equal(await swingAtPastPosition({ measured: true, obstacles: wall }), 100, 'cover blocks the historical hit');
});

test('the rewind history never reaches a snapshot or a recording', duel(({ s }) => {
  settle(s);
  // The frames are the core's own since #1245 (27 step 5e.2); the bounded window is `phase_seven.rs`'s test.
  assert.equal(Object.hasOwn(s, 'rewind'), false, 'history is kept in the core, not on the record');
  const frame = snapshot(s);
  assert.equal(Object.hasOwn(frame, 'rewind'), false, 'and stays out of the recorded frame');
  // It is derivable from the frames a recording already holds, so carrying it would store twice.
  assert.equal(JSON.stringify(frame).includes('rewind'), false);
}));

test('a room records each changed lag measurement as observation commands', async () => {
  // Schema 22 (26): the recording holds what the new tick's inbound queue takes (27.2 Boundary).
  const h = roomHarness({ reuseMaps: true }), { room, owner, writer } = await h.live();
  try {
    const id = owner.session.playerId, connection = owner.session.connectionId;
    assert.equal(room.setViewLag(connection, 1000 / HZ * 3), true);
    assert.equal(room.setViewLag(connection, 1000 / HZ * 3), true);
    h.wake(50);
    const observed = writer.frames.at(-1).commands.filter(c => c.type === 'observation' && ['viewLag', 'inputLead'].includes(c.kind));
    assert.deepEqual(observed.map(c => [c.kind, c.id]), [['viewLag', id], ['inputLead', id]], 'once, while unchanged');
    assert.ok(observed.every(c => Number.isInteger(c.ticks) && c.ticks > 0));
  } finally { await h.service.close(); }
});
