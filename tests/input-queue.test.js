import { renderedPlayerView as playerView } from './helpers/relational.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { disposePhysics, joinGame, setInput, step, snapshot, } from '../shared/simulation.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { openField } from './helpers/arena.js';
import { roomHarness } from './helpers/room-harness.js';
import { now, stagePhysics } from './helpers/scenario.js';
import { inputLeadFrom, MAX_INPUT_LEAD_TICKS } from '../shared/simulation/input.ts';

// On the shipped content and its engine (#920): a joined contestant on open ground, so what is measured is the
// input path rather than collision response, with a bot contestant beside them and a bot gladiator far off.
const scene = body => async () => {
  const { map } = openField(3000);
  const { s } = await stagePhysics(map, { content: defaultContent(), actors: [{ role: 'contestant', x: 600, y: 576 },
    { role: 'contestant', x: 600, y: 200 }, { role: 'gladiator', x: 2800, y: 1000 }] });
  const p = joinGame(s, 'human', 'contestant', 'warden', 'Runner');
  try { await body({ s, p }); } finally { disposePhysics(s); }
};
test('a tick spends exactly one input and acknowledges only that one', scene(({ s, p }) => {
  for (const seq of [1, 2, 3]) assert.ok(setInput(s, p.id, { seq, x: 1 }));
  assert.equal(p.lastSeq, -1, 'nothing is acknowledged before a tick spends it');
  assert.equal(p.receivedSeq, 3, 'though all three were accepted');
  for (const expected of [1, 2, 3]) { step(s); assert.equal(p.lastSeq, expected); }
}));

test('acknowledgement follows consumption, not arrival', scene(({ s, p }) => {
  setInput(s, p.id, { seq: 7, x: 1 });
  setInput(s, p.id, { seq: 8, x: 1 });
  step(s);
  // The bug this separation exists to prevent: acknowledging on arrival tells a client its input was
  // applied while it is still queued, and the client then drops it from the inputs it replays.
  assert.equal(p.lastSeq, 7);
  assert.equal(playerView(s, snapshot(s), p.id).players.find(v => v.id === p.id).lastSeq, 7);
}));

test('a starved queue repeats movement', scene(({ s, p }) => {
  p.x = s.map.exit.x; p.y = s.map.exit.y;
  setInput(s, p.id, { seq: 1, x: 1, interact: true });
  step(s);
  const afterFirst = now(s, p).x;
  // Nothing more arrives. Movement continues, because one late packet is far likelier than a player
  // releasing every key, but spending a charge or opening a door again would be the client's loss
  // turned into an action it never asked for.
  step(s);
  assert.ok(now(s, p).x > afterFirst, 'held movement carries on');
}));

test('a long silence stops the player rather than repeating forever', scene(({ s, p }) => {
  setInput(s, p.id, { seq: 1, x: 1 });
  step(s);
  for (let i = 0; i < 12; i++) step(s);
  const settled = now(s, p).x;
  step(s);
  assert.equal(now(s, p).x, settled, 'a player whose client has gone quiet comes to a stop');
}));

test('sending faster than the tick consumes is clamped to the newest intent', scene(({ s, p }) => {
  for (let seq = 1; seq <= 12; seq++) setInput(s, p.id, { seq, x: seq === 12 ? -1 : 1 });
  // Unbounded queueing would turn a fast client into ever-growing input lag, so the oldest are
  // dropped: the newest is closest to what the player currently intends.
  assert.ok(p.inputQueue.length <= 4, `queue is bounded, got ${p.inputQueue.length}`);
  assert.equal(p.inputQueue.at(-1).seq, 12, 'the newest input is the one kept');
  step(s);
  assert.ok(p.lastSeq >= 9, 'and the dropped ones are never acknowledged as spent');
}));

test('duplicate and out-of-order inputs are refused', scene(({ s, p }) => {
  assert.ok(setInput(s, p.id, { seq: 5, x: 1 }));
  assert.equal(setInput(s, p.id, { seq: 5, x: -1 }), false, 'a duplicate sequence is refused');
  assert.equal(setInput(s, p.id, { seq: 4, x: -1 }), false, 'so is one that arrived late');
  assert.equal(setInput(s, p.id, { seq: 1.5, x: 1 }), false, 'and a non-integer sequence');
  assert.equal(p.inputQueue.length, 1);
}));

test('the queue is private and never reaches another player', scene(({ s, p }) => {
  setInput(s, p.id, { seq: 1, x: 1 });
  const view = playerView(s, snapshot(s), s.players[1].id);
  const seen = view.players.find(v => v.id === p.id);
  for (const field of ['inputQueue', 'receivedSeq', 'inputStalled', 'inputMargin', 'lastSeq', 'input']) {
    assert.equal(Object.hasOwn(seen, field), false, `${field} is input bookkeeping and stays private`);
  }
  const own = playerView(s, snapshot(s), p.id).players.find(v => v.id === p.id);
  assert.equal(Object.hasOwn(own, 'inputQueue'), false, 'even its owner is not sent the queue itself');
  assert.equal(Object.hasOwn(own, 'lastSeq'), true, 'only the acknowledgement it reconciles against');
}));

test('a newly joined slot starts with no queue and its own sequence numbering', scene(({ s, p }) => {
  setInput(s, p.id, { seq: 1, x: 1 });
  setInput(s, p.id, { seq: 2, x: 1 });
  const joined = joinGame(s, 'second', 'contestant', 'warden', 'Other');
  assert.notEqual(joined.id, p.id, 'a fresh slot, not the same one');
  assert.equal(joined.inputQueue.length, 0);
  assert.equal(joined.lastSeq, -1);
  assert.equal(joined.receivedSeq, -1, 'and sequence numbering starts for the new client');
}));

test('a resumed slot spends only the new session input, from its own low sequence numbers', async () => {
  const h = roomHarness({ reuseMaps: true });
  try {
    const { room, owner } = await h.live();
    h.wake(50);
    const id = owner.session.playerId, p = room.game.players.find(q => q.id === id);
    // Queued but never spent: the old client goes away with these still waiting.
    for (const seq of [5, 6, 7]) owner.send({ type: 'input', seq, x: 1 });
    assert.equal(p.inputQueue.length, 3);
    const { resumeKey } = owner.messages.find(m => m.type === 'welcome');
    const back = h.joined(room, { resumeKey });
    assert.equal(back.session.playerId, id, 'the same slot, not a fresh one');
    assert.equal(p.inputQueue.length, 0, 'the old queue went with the old session');
    // The new client numbers from the start; a slot still expecting 8 would refuse this.
    back.send({ type: 'input', seq: 1, x: -1 });
    assert.equal(p.receivedSeq, 1);
    h.wake(50);
    assert.equal(p.lastSeq, 1, 'the one tick spent the new input');
    h.wake(50);
    assert.equal(p.lastSeq, 1, 'and no old input is spent after it');
  } finally { await h.service.close(); }
});

// Tick-stamped input (#1096, 24): the in-process form above stands in for a client with no network.
const own = (s, p) => playerView(s, snapshot(s), p.id).players.find(v => v.id === p.id);

test('a stamped input waits for its own tick and is spent on it', scene(({ s, p }) => {
  const due = s.tick + 3;
  assert.ok(setInput(s, p.id, { seq: 1, tick: due, x: 1 }));
  step(s);
  assert.equal(own(s, p).inputMargin, 2, 'it arrived two ticks before the next tick ran');
  step(s);
  assert.equal(p.lastSeq, -1, 'nothing is spent before its tick');
  step(s);
  assert.equal(s.tick, due);
  assert.equal(p.lastSeq, 1, 'and it is spent on that tick');
  assert.equal(Object.hasOwn(own(s, p), 'inputMargin'), false, 'a tick with no arrivals reports no margin');
}));

test('a late stamp is discarded, never rewound, and reported to the client', scene(({ s, p }) => {
  const x = p.x;
  assert.equal(setInput(s, p.id, { seq: 1, tick: s.tick, x: 1, interact: true }), false, 'its tick has already run');
  assert.equal(p.receivedSeq, 1, 'though it was received');
  step(s);
  assert.equal(p.lastSeq, -1, 'no tick spends it');
  assert.equal(now(s, p).x, x);
  assert.equal(own(s, p).inputMargin, -1, 'the client is told it arrived one tick late');
}));

test('how far ahead a stamp may run follows the measured round trip', scene(({ s, p }) => {
  assert.ok(inputLeadFrom(40) < inputLeadFrom(220), 'a slower measured link is granted more lead');
  assert.equal(inputLeadFrom(null), MAX_INPUT_LEAD_TICKS, 'an unmeasured one the most a measurement could grant');
  assert.equal(inputLeadFrom(5000), MAX_INPUT_LEAD_TICKS);
  p.inputLeadTicks = inputLeadFrom(40);
  const next = s.tick + 1;
  assert.equal(setInput(s, p.id, { seq: 1, tick: next + p.inputLeadTicks + 1 }), false, 'beyond the lead is refused');
  assert.ok(setInput(s, p.id, { seq: 2, tick: next + p.inputLeadTicks }), 'the lead itself is buffered');
}));

test('a newer stamp supersedes buffered inputs for its tick or later, keeping one per tick in sequence order', scene(({ s, p }) => {
  const next = s.tick + 1;
  for (const [seq, tick] of [[1, next], [2, next + 1], [3, next + 2]]) assert.ok(setInput(s, p.id, { seq, tick, x: 1 }));
  assert.ok(setInput(s, p.id, { seq: 4, tick: next + 1, x: -1 }), 'a client whose clock stepped back');
  assert.deepEqual(p.inputQueue.map(i => [i.seq, i.tick]), [[1, next], [4, next + 1]]);
  const spent = [];
  for (let i = 0; i < 3; i++) { step(s); spent.push(p.lastSeq); }
  assert.deepEqual(spent, [1, 4, 4], 'the third tick has nothing and repeats');
}));

test('the wire refuses an input without a tick stamp', async () => {
  const { acceptClientMessage } = await import('../server/protocol.js');
  const session = { rejectedMessages: 0 };
  assert.equal(acceptClientMessage(session, { type: 'input', seq: 1, x: 1 }, { log: null }).ok, false);
  const accepted = acceptClientMessage(session, { type: 'input', seq: 1, tick: 9, x: 1 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.message.tick, 9);
});
