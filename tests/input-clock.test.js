import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputClock, DEFAULT_TARGET_MARGIN } from '../shared/input-clock.ts';
import { MAX_INPUT_LEAD_TICKS } from '../shared/simulation/input.ts';
import { HZ } from '../shared/simulation/rules.ts';

// The client's half of tick-stamped input (#1096). Time is passed in, so nothing here waits.
const TICK = 1000 / HZ;
// Frames for ticks 1..n, each arriving `delay` ms after its tick ran on a server clock where tick k runs at k * TICK.
const synced = (clock, n = 20, delay = 20) => { for (let k = 1; k <= n; k++) clock.observe(k, k * TICK + delay); return n * TICK + delay; };

test('nothing is stamped before a frame shows where the server is', () => {
  const clock = createInputClock();
  assert.equal(clock.stamp(0, 40), null);
});

test('the first stamp lands its round trip ahead of the newest frame, plus the target margin', () => {
  const clock = createInputClock();
  const now = synced(clock, 20, 20);
  // The frame for tick 20 arrived 20 ms after it ran; an input sent now arrives 20 ms later, before tick 21.
  assert.equal(clock.stamp(now, 40), 21 + DEFAULT_TARGET_MARGIN);
  assert.equal(clock.stamp(now + TICK, 40), 22 + DEFAULT_TARGET_MARGIN, 'and each later input is for the next tick');
});

test('time dilation: faster after a late input, slower over a full window of surplus, steady at the target', () => {
  const steady = createInputClock(), late = createInputClock(), ahead = createInputClock();
  let now = 0;
  for (const clock of [steady, late, ahead]) { now = synced(clock); clock.stamp(now, 40); }
  // Margins describe stamps already sent, so they are reported after the first.
  steady.observe(21, now, DEFAULT_TARGET_MARGIN);
  late.observe(21, now, -1);
  for (let i = 0; i < 20; i++) ahead.observe(21, now, DEFAULT_TARGET_MARGIN + 2);
  const then = now + TICK;
  for (const clock of [steady, late, ahead]) clock.stamp(then, 40);
  assert.equal(steady.delay(then), TICK);
  assert.ok(late.delay(then) < TICK, `catches up: ${late.delay(then)}`);
  assert.ok(ahead.delay(then) > TICK, `eases off: ${ahead.delay(then)}`);
});

test('a clock behind the server jumps forward and one far ahead steps back, never by steering alone', () => {
  const clock = createInputClock();
  const now = synced(clock, 60);
  const first = clock.stamp(now, 40);
  // Ten silent ticks (the player was not active): the next stamp would surely be late.
  const later = now + 10 * TICK;
  for (let k = 61; k <= 70; k++) clock.observe(k, k * TICK + 20);
  const rejoined = clock.stamp(later, 40);
  assert.equal(rejoined, first + 10, 'it rejoins the estimate rather than sending late inputs');
  // A new map's ticks start again from one, further behind than any server would buffer ahead.
  for (let k = 1; k <= 20; k++) clock.observe(k, later + k * TICK + 20);
  const restarted = clock.stamp(later + 20 * TICK + 20, 40);
  assert.ok(rejoined - restarted > MAX_INPUT_LEAD_TICKS - 20, 'the old stamps are far ahead of the new clock');
  assert.equal(restarted, 21 + DEFAULT_TARGET_MARGIN, 'it steps back to the new clock');
});

test('a late timer restarts the send schedule instead of bursting to catch up', () => {
  const clock = createInputClock();
  const now = synced(clock);
  clock.stamp(now, 40);
  clock.stamp(now + 10 * TICK, 40);
  assert.equal(clock.delay(now + 10 * TICK), TICK, 'the next send is a period after the late one, not overdue');
});
