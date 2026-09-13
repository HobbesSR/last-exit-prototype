import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayTimeline } from '../public/replay-timeline.js';

const frame = tick => ({ state: { tick, marker: `state-${tick}` } });

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
