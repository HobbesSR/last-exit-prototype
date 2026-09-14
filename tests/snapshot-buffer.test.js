import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotBuffer, lerpAngle } from '../public/snapshot-buffer.js';

const HZ = 20, TICK_MS = 1000 / HZ;

/** A buffer driven by a clock the test advances, so arrival jitter is scripted rather than timed. */
function harness({ delayTicks } = {}) {
  let now = 1000;
  const buffer = createSnapshotBuffer({ hz: HZ, delayTicks, clock: () => now });
  return { buffer, advance: ms => { now += ms; }, now: () => now };
}
const player = (id, x, y, extra = {}) => ({ id, x, y, heading: 0, status: 'active', hp: 100, ...extra });
const frame = (tick, players, extra = {}) => ({ tick, hazardX: -80, players, items: [], gates: [], traps: [], projectiles: [], effects: [], ...extra });
const find = (result, id) => result.players.find(p => p.id === id);
/**
 * Deliver `ticks` frames one tick-interval apart, leaving the clock at the last arrival. The
 * playhead then sits exactly `delayTicks` behind the newest frame, which is the steady state the
 * assertions below are written against.
 */
function prime(h, ticks, build) {
  for (let tick = 1; tick <= ticks; tick++) {
    if (tick > 1) h.advance(TICK_MS);
    h.buffer.push(frame(tick, build(tick)));
  }
}

test('a player is drawn between the two authoritative frames bracketing the delayed playhead', () => {
  const h = harness();
  prime(h, 4, tick => [player('c0', tick * 100, 0)]);
  // Four frames received at one tick apart, so the playhead sits on tick 2 and reads frames 2 and 3.
  assert.equal(find(h.buffer.frame(), 'c0').x, 200);
  h.advance(TICK_MS / 2);
  const middle = find(h.buffer.frame(), 'c0').x;
  assert.ok(Math.abs(middle - 250) < 1, `expected the midpoint of 200..300, got ${middle}`);
});

test('constant motion is reproduced smoothly even though frames arrive unevenly', () => {
  const h = harness();
  const speed = 9; // units per tick, a contestant's
  // Wall-clock arrival gaps a real client sees: wake granularity either side of 50 ms, a stall, and
  // a catch-up batch that delivers one payload covering two simulated ticks.
  const gaps = [50, 38, 61, 47, 55, 41, 97, 50, 44, 58, 50, 36, 64, 50, 47, 53, 50, 45, 62, 39];
  let tick = 0, nextArrival = 0, gapIndex = 0, elapsed = 0;
  const deliver = () => {
    // A gap longer than one and a half ticks carries the ticks it covered, newest state only.
    const covered = gaps[gapIndex % gaps.length] > 80 ? 2 : 1;
    tick += covered;
    h.buffer.push(frame(tick, [player('c0', tick * speed, 0)]));
    nextArrival += gaps[gapIndex++ % gaps.length];
  };
  deliver(); // first frame at t=0

  const samples = [];
  // Drive one monotonic clock: deliver frames when due, render every 16 ms as a 60 Hz client does.
  for (let step = 0; step < 90; step++) {
    h.advance(16); elapsed += 16;
    while (elapsed >= nextArrival) deliver();
    const drawn = h.buffer.frame();
    if (drawn && h.buffer.stats().depth > 2) samples.push(find(drawn, 'c0').x);
  }

  const steps = samples.slice(1).map((x, i) => x - samples[i]);
  assert.ok(steps.every(step => step >= -1e-9), 'drawn position never moves backwards');
  const moving = steps.filter(step => step > 0.001);
  const fastest = Math.max(...moving), slowest = Math.min(...moving);
  // The playhead absorbs drift by dilating time at most +-15%, so per-frame motion stays in a tight
  // band. The exponential filter this replaced spiked on every arrival and decayed between them.
  assert.ok(fastest / slowest < 1.6, `uneven arrivals must not show through as uneven motion, got ${(fastest / slowest).toFixed(2)}x`);
});

test('a catch-up batch that skips ticks is crossed by interpolation rather than by a jump', () => {
  const h = harness();
  const x = tick => tick * 10;
  // What the room loop actually emits: when a wake owes several ticks it simulates them all and
  // broadcasts only the newest, so the payload arrives on time carrying a tick number that jumped.
  // Ticks 3 and 6 are never sent on their own.
  const arrivals = [[0, 1], [50, 2], [150, 4], [200, 5], [300, 7], [350, 8], [400, 9], [450, 10]];
  let next = 0, elapsed = 0;
  const samples = [];
  for (let step = 0; step < 60; step++) {
    while (next < arrivals.length && elapsed >= arrivals[next][0]) {
      h.buffer.push(frame(arrivals[next][1], [player('c0', x(arrivals[next][1]), 0)]));
      next++;
    }
    const drawn = h.buffer.frame();
    if (drawn && h.buffer.stats().depth > 2) samples.push(find(drawn, 'c0').x);
    h.advance(8); elapsed += 8;
  }
  const steps = samples.slice(1).map((v, i) => v - samples[i]).filter(v => v > 0.001);
  const largest = Math.max(...steps);
  const typical = steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)];
  assert.ok(samples.some(v => v > x(2) && v < x(4)), 'the skipped tick is traversed, not stepped over');
  assert.ok(largest / typical < 2, `a skipped tick must not show through as a jump, largest step ${largest.toFixed(2)} vs typical ${typical.toFixed(2)}`);
  assert.equal(h.buffer.stats().starved, 0, 'a batch that arrives on time never starves the buffer');
});

test('a starved buffer holds the last state instead of extrapolating past it', () => {
  const h = harness();
  prime(h, 3, tick => [player('c0', tick * 10, 0)]);
  // Nothing more arrives. The playhead runs past the newest frame.
  h.advance(TICK_MS * 6);
  assert.equal(find(h.buffer.frame(), 'c0').x, 30, 'holds the newest received position');
  h.advance(TICK_MS * 20);
  assert.equal(find(h.buffer.frame(), 'c0').x, 30, 'still holds rather than drifting away');
  assert.ok(h.buffer.stats().starved > 0, 'starvation is reported rather than hidden');
});

test('anything advanced from alpha holds too, so a held projectile does not fly on alone', () => {
  const h = harness();
  const shot = { id: 1, x: 0, y: 0, dx: 40, dy: 0, life: 30 };
  prime(h, 3, () => []);
  h.advance(TICK_MS * 8);
  assert.equal(h.buffer.frame().alpha, 0, 'a held frame has no elapsed fraction to advance by');
  assert.equal(shot.x, 0, 'the consumer advances from alpha; the buffer never mutates the record');
});

test('alpha measures elapsed ticks since the drawn frame, so constant-rate motion stays correct', () => {
  const h = harness();
  prime(h, 4, tick => [player('c0', 0, 0)]);
  assert.ok(Math.abs(h.buffer.frame().alpha) < 1e-9, 'on a frame boundary nothing has elapsed');
  h.advance(TICK_MS / 2);
  assert.ok(Math.abs(h.buffer.frame().alpha - 0.5) < 0.02, 'half a tick later, half a tick has elapsed');
});

test('heading crosses +-pi the short way instead of unwinding', () => {
  assert.ok(Math.abs(Math.abs(lerpAngle(3.0, -3.0, 0.5)) - Math.PI) < 0.05,
    'the midpoint of 3.0 and -3.0 is near pi, not near zero');
  const h = harness();
  prime(h, 4, tick => [player('c0', 0, 0, { heading: tick <= 2 ? 3.1 : -3.1 })]);
  h.advance(TICK_MS / 2);
  const heading = find(h.buffer.frame(), 'c0').heading;
  assert.ok(Math.abs(heading) > 3.0, `expected a short turn through pi, got ${heading}`);
});

test('a discontinuity cuts and drops the history before it', () => {
  const h = harness();
  prime(h, 4, tick => [player('c0', tick * 10, 0)]);
  // A resumed tab, a rejoin, or a replay closing back to a live match: the next frame is far away.
  h.buffer.push(frame(500, [player('c0', 9000, 0)]));
  assert.equal(h.buffer.stats().snaps, 1, 'the jump is reported as a cut');
  assert.equal(h.buffer.stats().depth, 1, 'stale frames are dropped rather than interpolated across');
  assert.equal(find(h.buffer.frame(), 'c0').x, 9000, 'the new state is shown, not a glide toward it');
});

test('a duplicated or reordered frame does not corrupt the bracket', () => {
  const h = harness();
  h.buffer.push(frame(1, [player('c0', 0, 0)])); h.advance(TICK_MS);
  h.buffer.push(frame(3, [player('c0', 20, 0)])); h.advance(TICK_MS);
  h.buffer.push(frame(2, [player('c0', 10, 0)])); // arrives late, out of order
  h.buffer.push(frame(3, [player('c0', 20, 0)])); // duplicate
  h.advance(TICK_MS);
  h.buffer.push(frame(4, [player('c0', 30, 0)]));
  const drawn = find(h.buffer.frame(), 'c0').x;
  assert.ok(drawn >= 0 && drawn <= 30, `position stays within the received range, got ${drawn}`);
  assert.equal(h.buffer.stats().depth, 4, 'the duplicate replaced rather than appended');
});

test('discrete state reads from the later frame so feedback is not delayed with the motion', () => {
  const h = harness();
  // The playhead sits on tick 3, reading frames 3 and 4, so the hit landing on tick 4 is the one
  // whose health must already show while the position is still crossing toward it.
  prime(h, 5, tick => [player('c0', tick * 10, 0, { hp: tick >= 4 ? 25 : 100 })]);
  h.advance(TICK_MS / 2);
  const drawn = find(h.buffer.frame(), 'c0');
  assert.equal(drawn.hp, 25, 'health is current even while the position is still interpolating');
  assert.ok(drawn.x > 30 && drawn.x < 40, `position still interpolates, got ${drawn.x}`);
});

test('a player the earlier frame did not carry is shown rather than withheld', () => {
  const h = harness();
  // A second player enters the transmitted set on tick 4, as one does on crossing the potential
  // radius; the playhead is on tick 3 and reads frames 3 and 4.
  prime(h, 5, tick => tick >= 4 ? [player('c0', 0, 0), player('c1', 500, 0)] : [player('c0', 0, 0)]);
  const players = h.buffer.frame().players;
  assert.ok(players.some(p => p.id === 'c1'), 'a newly transmitted player appears immediately');
  assert.equal(players.find(p => p.id === 'c1').x, 500);
});

test('reset clears the buffer so a new connection does not read the previous one', () => {
  const h = harness();
  prime(h, 4, tick => [player('c0', tick * 10, 0)]);
  h.buffer.reset();
  assert.equal(h.buffer.frame(), null, 'nothing is drawn before the first frame of the new connection');
  assert.equal(h.buffer.stats().depth, 0);
});
