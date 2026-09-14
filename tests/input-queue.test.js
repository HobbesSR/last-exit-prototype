import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, joinGame, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { movePlayer } from '../shared/movement.ts';

function fixture() {
  const s = createGame(4217);
  const p = joinGame(s, 'human', 'contestant', 'warden', 'Runner');
  // Open ground, so what is being measured is the input path rather than collision response.
  s.map.items = []; s.map.traps = [];
  return { s, p };
}

test('a tick spends exactly one input and acknowledges only that one', () => {
  const { s, p } = fixture();
  for (const seq of [1, 2, 3]) assert.ok(setInput(s, p.id, { seq, x: 1 }));
  assert.equal(p.lastSeq, -1, 'nothing is acknowledged before a tick spends it');
  assert.equal(p.receivedSeq, 3, 'though all three were accepted');
  for (const expected of [1, 2, 3]) { step(s); assert.equal(p.lastSeq, expected); }
});

test('acknowledgement follows consumption, not arrival', () => {
  const { s, p } = fixture();
  setInput(s, p.id, { seq: 7, x: 1 });
  setInput(s, p.id, { seq: 8, x: 1 });
  step(s);
  // The bug this separation exists to prevent: acknowledging on arrival tells a client its input was
  // applied while it is still queued, and the client then drops it from the inputs it replays.
  assert.equal(p.lastSeq, 7);
  assert.equal(playerView(s, snapshot(s), p.id).players.find(v => v.id === p.id).lastSeq, 7);
});

test('a client replaying unacknowledged inputs lands exactly where the server put it', () => {
  const { s, p } = fixture();
  const start = { x: p.x, y: p.y };
  // A client sends about one input per tick, so the queue stays shallow. Sending more than it can
  // hold is a different case with its own test below, and would drop the oldest here.
  const sent = [{ seq: 1, x: 1, y: 0 }, { seq: 2, x: 1, y: 0.5 }, { seq: 3, x: 0.3, y: 1 }, { seq: 4, x: -1, y: 1 }];
  for (const input of sent) setInput(s, p.id, input);
  for (let i = 0; i < sent.length; i++) step(s);

  // The client predicts with the same shared movement code, from the same start, over the same
  // inputs. Exactness here is what reconciliation depends on: any drift would reach the player as a
  // correction indistinguishable from a real one.
  const predicted = { ...p, ...start };
  for (const input of sent) movePlayer(s.map, predicted, input);
  assert.equal(predicted.x, p.x);
  assert.equal(predicted.y, p.y);

  // And the acknowledgement is what tells the client it may stop replaying them.
  assert.equal(p.lastSeq, 4);
  const unacknowledged = sent.filter(input => input.seq > p.lastSeq);
  assert.deepEqual(unacknowledged, [], 'every input the server spent is acknowledged');
});

test('reconciling from the acknowledgement reproduces the server mid-stream', () => {
  const { s, p } = fixture();
  const sent = [{ seq: 1, x: 1 }, { seq: 2, x: 1, y: 1 }, { seq: 3, y: 1 }, { seq: 4, x: -1 }];
  for (const input of sent) setInput(s, p.id, input);
  step(s); step(s); // only two of the four are spent

  const authoritative = snapshot(s).players.find(v => v.id === p.id);
  const predicted = { ...authoritative };
  for (const input of sent.filter(i => i.seq > authoritative.lastSeq)) movePlayer(s.map, predicted, input);
  // Letting the server catch up must land on the position the client already predicted.
  step(s); step(s);
  assert.equal(predicted.x, p.x);
  assert.equal(predicted.y, p.y);
});

test('a starved queue repeats movement but never re-fires a one-shot press', () => {
  const { s, p } = fixture();
  p.x = s.map.exit.x; p.y = s.map.exit.y;
  setInput(s, p.id, { seq: 1, x: 1, interact: true });
  step(s);
  const afterFirst = p.x;
  assert.ok(p.inputStalled === 0, 'a tick that spent an input is not stalled');
  // Nothing more arrives. Movement continues, because one late packet is far likelier than a player
  // releasing every key, but spending a charge or opening a door again would be the client's loss
  // turned into an action it never asked for.
  step(s);
  assert.ok(p.x > afterFirst, 'held movement carries on');
  assert.equal(p.inputStalled, 1, 'and the repeat is reported rather than hidden');
  assert.equal(p.input.interact, true, 'the last spent input is unchanged');
});

test('a long silence stops the player rather than repeating forever', () => {
  const { s, p } = fixture();
  setInput(s, p.id, { seq: 1, x: 1 });
  step(s);
  for (let i = 0; i < 12; i++) step(s);
  const settled = p.x;
  step(s);
  assert.equal(p.x, settled, 'a player whose client has gone quiet comes to a stop');
});

test('sending faster than the tick consumes is clamped to the newest intent', () => {
  const { s, p } = fixture();
  for (let seq = 1; seq <= 12; seq++) setInput(s, p.id, { seq, x: seq === 12 ? -1 : 1 });
  // Unbounded queueing would turn a fast client into ever-growing input lag, so the oldest are
  // dropped: the newest is closest to what the player currently intends.
  assert.ok(p.inputQueue.length <= 4, `queue is bounded, got ${p.inputQueue.length}`);
  assert.equal(p.inputQueue.at(-1).seq, 12, 'the newest input is the one kept');
  step(s);
  assert.ok(p.lastSeq >= 9, 'and the dropped ones are never acknowledged as spent');
});

test('duplicate and out-of-order inputs are refused', () => {
  const { s, p } = fixture();
  assert.ok(setInput(s, p.id, { seq: 5, x: 1 }));
  assert.equal(setInput(s, p.id, { seq: 5, x: -1 }), false, 'a duplicate sequence is refused');
  assert.equal(setInput(s, p.id, { seq: 4, x: -1 }), false, 'so is one that arrived late');
  assert.equal(setInput(s, p.id, { seq: 1.5, x: 1 }), false, 'and a non-integer sequence');
  assert.equal(p.inputQueue.length, 1);
});

test('the queue is private and never reaches another player', () => {
  const { s, p } = fixture();
  setInput(s, p.id, { seq: 1, x: 1 });
  const view = playerView(s, snapshot(s), s.players[1].id);
  const seen = view.players.find(v => v.id === p.id);
  for (const field of ['inputQueue', 'receivedSeq', 'inputStalled', 'lastSeq', 'input']) {
    assert.equal(Object.hasOwn(seen, field), false, `${field} is input bookkeeping and stays private`);
  }
  const own = playerView(s, snapshot(s), p.id).players.find(v => v.id === p.id);
  assert.equal(Object.hasOwn(own, 'inputQueue'), false, 'even its owner is not sent the queue itself');
  assert.equal(Object.hasOwn(own, 'lastSeq'), true, 'only the acknowledgement it reconciles against');
});

test('a resumed slot does not spend the previous occupant input', () => {
  const { s, p } = fixture();
  setInput(s, p.id, { seq: 1, x: 1 });
  setInput(s, p.id, { seq: 2, x: 1 });
  const rejoined = joinGame(s, 'second', 'contestant', 'warden', 'Other');
  assert.notEqual(rejoined.id, p.id, 'a fresh slot, not the same one');
  assert.equal(rejoined.inputQueue.length, 0);
  assert.equal(rejoined.lastSeq, -1);
  assert.equal(rejoined.receivedSeq, -1, 'and sequence numbering starts over for the new client');
});
