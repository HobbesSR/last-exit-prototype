import assert from 'node:assert/strict';
import test from 'node:test';
import { clusterMarks, createReplayTimeline, markLabel, markSeekTick } from '../public/replay-timeline.js';

const frame = tick => ({ state: { tick, marker: `state-${tick}` } });

test('render frames retain fractional time and advance at each playback speed', () => {
  const timeline = createReplayTimeline({ frames: Array.from({ length: 101 }, (_, tick) => frame(tick)) });
  for (const speed of [0.5, 1, 2, 4]) {
    let playhead = 0, sample;
    for (let i = 0; i < 60; i++) {
      sample = timeline.at(playhead + 20 / 60 * speed);
      assert.ok(sample);
      playhead = sample.tick;
      assert.equal(sample.state.tick, Math.floor(playhead));
      assert.equal(sample.missing, false);
    }
    assert.ok(Math.abs(playhead - 20 * speed) < 1e-10);
  }
  assert.equal(timeline.at(0.5).alpha, 0.5);
  assert.equal(timeline.at(101.5).tick, 100);
});

test('fractional gaps hold recorded positions without projectile extrapolation', () => {
  const timeline = createReplayTimeline({ frames: [frame(2), frame(5)], recording: { complete: false, endTick: 8 } });
  for (const tick of [0.5, 1.9, 3.2, 4.8, 6.5, 7.9, 8]) {
    const sample = timeline.at(tick);
    assert.equal(sample.missing, true);
    assert.equal(sample.alpha, 0);
  }
  assert.equal(timeline.at(2.5).missing, false);
  assert.equal(timeline.at(2.5).alpha, 0.5);
  assert.equal(timeline.at(5.5).state.tick, 5);
  for (const invalid of [NaN, Infinity, -1, '2']) assert.equal(timeline.at(invalid), null);
});

test('dense legacy recordings retain their tick playback', () => {
  const timeline = createReplayTimeline({ frames: [frame(0), frame(1), frame(2)] });
  assert.equal(timeline.complete, true); assert.equal(timeline.endTick, 2);
  assert.equal(timeline.at(1).state.tick, 1); assert.equal(timeline.at(1).missing, false);
});

test('sparse frames hold the previous state and report gaps and incomplete tails', () => {
  const timeline = createReplayTimeline({ frames: [frame(0), frame(4)], recording: { complete: false, droppedFrames: 3, endTick: 8 } });
  assert.equal(timeline.at(3).state.tick, 0); assert.equal(timeline.at(3).missing, true);
  assert.equal(timeline.at(4).missing, false);
  assert.equal(timeline.at(7).state.tick, 4); assert.equal(timeline.at(7).missing, true);
  assert.equal(timeline.endTick, 8); assert.equal(timeline.droppedFrames, 3);
});

test('the last duplicate at a tick wins', () => {
  const earlier = { state: { tick: 2, marker: 'earlier' } }, later = { state: { tick: 2, marker: 'later' } };
  assert.equal(createReplayTimeline({ frames: [frame(0), earlier, later] }).at(2).state.marker, 'later');
});

test('a leading gap falls back to the first frame and is marked missing', () => {
  const sample = createReplayTimeline({ frames: [frame(5), frame(7)], recording: { complete: false, endTick: 9 } }).at(0);
  assert.equal(sample.state.tick, 5); assert.equal(sample.frameTick, 5); assert.equal(sample.missing, true);
});

test('invalid inputs remain safe and do not manufacture states', () => {
  const empty = createReplayTimeline({ frames: [null, {}, { state: { tick: -1 } }, { state: { tick: '2' } }] });
  assert.equal(empty.at(0), null); assert.equal(empty.endTick, undefined);
  const timeline = createReplayTimeline({ frames: [frame(2)], recording: { complete: false, endTick: 'bad' } });
  assert.equal(timeline.endTick, 2); assert.equal(timeline.at(NaN), null);
});

test('the roster names every recorded player once, in first seen order', () => {
  const players = list => ({ state: { tick: list.tick, players: list.players } });
  const timeline = createReplayTimeline({ frames: [
    players({ tick: 0, players: [{ id: 'a', name: 'Ada', role: 'contestant' }, { id: 'w', name: 'Hunt', role: 'gladiator', kit: 'warden' }] }),
    players({ tick: 1, players: [{ id: 'a', name: 'Ada', role: 'contestant', status: 'dead' }, { id: 'b', name: 'Bo', role: 'contestant' }] }),
    players({ tick: 2, players: [{ id: 'w', name: 'Hunt', role: 'gladiator', kit: 'warden' }] })
  ] });
  assert.deepEqual(timeline.roster, [
    { id: 'a', name: 'Ada', role: 'contestant', kit: undefined },
    { id: 'w', name: 'Hunt', role: 'gladiator', kit: 'warden' },
    { id: 'b', name: 'Bo', role: 'contestant', kit: undefined }
  ]);
});

test('a roster tolerates frames without players', () => {
  assert.deepEqual(createReplayTimeline({ frames: [frame(0), frame(1)] }).roster, []);
  assert.deepEqual(createReplayTimeline({}).roster, []);
});

test('diagnostic marks keep known kinds at valid ticks, in tick order, and report overflow', () => {
  const diagnostics = { dropped: 3, marks: [
    { tick: 9, kind: 'server-stall', wakeMs: 450, owed: 9, simulated: 5 },
    { tick: 2, kind: 'manual', playerId: 'p1' },
    { tick: 4, kind: 'made-up' }, { tick: -1, kind: 'manual' }, { tick: 1.5, kind: 'manual' }, null,
    { tick: 9, kind: 'packet-gap', wakeMs: 'x' }] };
  const timeline = createReplayTimeline({ frames: [frame(0), frame(9)], diagnostics });
  assert.deepEqual(timeline.marks.map(m => [m.tick, m.kind]), [[2, 'manual'], [9, 'server-stall'], [9, 'packet-gap']]);
  assert.equal(timeline.marks[1].wakeMs, 450); assert.equal(timeline.marks[2].wakeMs, undefined);
  assert.equal(timeline.droppedMarks, 3);
  const plain = createReplayTimeline({ frames: [frame(0)] });
  assert.deepEqual(plain.marks, []); assert.equal(plain.droppedMarks, 0);
});

test('a mark seeks two seconds early, never before the first tick, and labels itself', () => {
  assert.equal(markSeekTick({ tick: 100 }, 20), 60);
  assert.equal(markSeekTick({ tick: 10 }, 20, 4), 4);
  assert.equal(markSeekTick({ tick: 10 }, undefined), 10);
  assert.equal(markLabel({ kind: 'server-stall', tick: 9, wakeMs: 450.4, owed: 9 }), 'Server stall (450 ms wake, 9 ticks owed) at tick 9');
  assert.equal(markLabel({ kind: 'manual', tick: 2 }), 'Manual mark at tick 2');
  assert.equal(markLabel({ kind: 'frame-drop', tick: 5, worstMs: 120, count: 7 }), 'Frame drops (worst 120 ms, 7 in a row) at tick 5');
});

test('marks whose pips would overlap share a cluster, by the rendered track width', () => {
  const marks = [10, 100, 100, 100, 101, 400].map((tick, i) => ({ tick, kind: 'manual', playerId: `p${i}` }));
  // 1000 ticks over 1000 px with 20 px pips: marks closer than 20 ticks collide.
  assert.deepEqual(clusterMarks(marks, 1000, 1000).map(c => [c.tick, c.marks.length]), [[10, 1], [100, 4], [400, 1]]);
  assert.deepEqual(clusterMarks([], 1000, 1000), []);
  const close = [0, 4].map(tick => ({ tick, kind: 'manual' }));
  assert.equal(clusterMarks(close, 200, 1000).length, 2, 'a wide track keeps distinct ticks apart');
  assert.equal(clusterMarks(close, 200, 69).length, 1, 'a narrow track merges them: 4 ticks is about 1 px');
  assert.equal(clusterMarks(marks, 1000, 0).length, 4, 'without a layout only equal ticks share a pip');
});
