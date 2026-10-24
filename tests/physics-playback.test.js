import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotBuffer } from '../public/snapshot-buffer.js';
import { createReplayTimeline } from '../public/replay-timeline.js';

const body = (id, x, angle = 0, extra = {}) => ({ id, kind: 'prop', shape: { kind: 'box', hx: 5, hy: 3 }, x, y: 20,
  angle, vx: 0, vy: 0, omega: 0, sleeping: false, generation: 1, ...extra });
const state = (tick, bodies, tethers = [], extra = {}) => ({ tick, players: [], items: [], traps: [], gates: [], projectiles: [], effects: [],
  physicsProfile: 'p3', bodies, tethers, ...extra });

test('replay seeks return the exact retained physics lists and hold sparse gaps', () => {
  const a = state(2, [body('p', 10), body('q', 15)], [{ id: 'rope', a: 'p', b: 'q' }]);
  const b = state(5, [body('p', 50), body('q', 70)], [{ id: 'rope', a: 'p', b: 'q' }]);
  const timeline = createReplayTimeline({ frames: [{ state: a }, { state: b }], recording: { complete: false, endTick: 8 } });
  for (const tick of [5, 3, 2, 7, 5]) {
    const sample = timeline.at(tick);
    assert.strictEqual(sample.state, tick < 5 ? a : b);
    assert.equal(sample.alpha, 0, 'exact ticks and omitted intervals do not invent motion');
  }
  assert.equal(timeline.at(3.5).missing, true);
  assert.equal(timeline.at(7).missing, true);
});

test('body interpolation uses adjacent compatible ticks and shortest arc; art follows body', () => {
  let now = 0;
  const buffer = createSnapshotBuffer({ hz: 20, delayTicks: 0, clock: () => now });
  const player = { id: 'a', x: 999, y: 999, heading: 0 };
  buffer.push(state(1, [body('b', 0, 3.1, { kind: 'actor', actorId: 'a' })], [], { players: [player] }));
  now = 50;
  buffer.push(state(2, [body('b', 100, -3.1, { kind: 'actor', actorId: 'a' })], [], { players: [player] }));
  // Read halfway between stored frames without a solver or Rapier import.
  now = 25;
  const read = buffer.frame();
  assert.equal(read.bodies[0].x, 50);
  assert.ok(Math.abs(read.bodies[0].angle) > 3, 'angle takes the short arc through pi');
  assert.deepEqual([read.players[0].x, read.players[0].y], [50, 20]);
});

test('spawn, removal, generation, profile, placement and tick gaps hold then cut bodies and ropes', () => {
  const scenarios = [
    [state(1, [body('p', 0)]), state(2, [body('p', 100), body('q', 200)])],
    [state(1, [body('p', 0), body('q', 10)], [{ id: 'r', a: 'p', b: 'q' }]), state(2, [body('p', 100)])],
    [state(1, [body('p', 0)]), state(2, [body('p', 100, 0, { generation: 2 })])],
    [state(1, [body('p', 0)]), state(2, [body('p', 100)], [], { physicsProfile: 'other' })],
    [state(1, [body('p', 0)]), state(2, [body('p', 100, 0, { discontinuity: 'placed' })])],
    [state(1, [body('p', 0)]), state(3, [body('p', 100)])],
  ];
  for (const [a, b] of scenarios) {
    let now = 0;
    const buffer = createSnapshotBuffer({ hz: 20, delayTicks: 0, clock: () => now });
    buffer.push(a); now = (b.tick - a.tick) * 50; buffer.push(b);
    now /= 2;
    assert.deepEqual(buffer.frame().bodies, a.bodies, `hold before tick ${b.tick}`);
    assert.deepEqual(buffer.frame().tethers, a.tethers);
    now = (b.tick - a.tick) * 50;
    assert.deepEqual(buffer.frame().bodies, b.bodies, `cut at tick ${b.tick}`);
    assert.deepEqual(buffer.frame().tethers, b.tethers);
  }
});
