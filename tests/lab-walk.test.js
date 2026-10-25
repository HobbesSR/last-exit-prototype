import test from 'node:test';
import assert from 'node:assert/strict';
import { builtMapCollision } from '../map/micro/adapter.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { regionExample } from '../map/micro/region-examples.ts';
import { canOccupy } from '../shared/movement.ts';
import { GATE_REACH } from '../shared/simulation/rules.ts';
import { keyIntent, toggleNearbyGate } from '../public/lab-walk.js';

const RADIUS = 14;
const nearestInReach = (map, body) => map.gates.filter(g => Math.hypot(g.x - body.x, g.y - body.y) < GATE_REACH)
  .sort((a, b) => Math.hypot(a.x - body.x, a.y - body.y) - Math.hypot(b.x - body.x, b.y - body.y))[0];
/** A depot's collision map, every gate open, and a walker whose nearest gate in reach can close beside it. */
function scene() {
  const region = buildRegion(regionExample({ type: 'depot', seed: 4217 }));
  const map = builtMapCollision({ cellSize: region.brief.cellSize, regions: [region], pairs: [] });
  for (const g of map.gates) g.open = true;
  for (const gate of map.gates) for (let r = RADIUS * 2; r < GATE_REACH; r += 2) for (let a = 0; a < 16; a++) {
    const body = { x: gate.x + r * Math.cos(a * Math.PI / 8), y: gate.y + r * Math.sin(a * Math.PI / 8) };
    const closed = { ...map, gates: map.gates.map(g => g === gate ? { ...g, open: false } : g) };
    if (nearestInReach(map, body) === gate && canOccupy(closed, body.x, body.y, RADIUS)) return { map, gate, body };
  }
  throw new Error('no clear spot beside a gate');
}

test('held keys become a unit move, opposite keys cancel', () => {
  assert.deepEqual(keyIntent(new Set(['KeyD', 'ArrowUp'])), { x: 1, y: -1 });
  assert.deepEqual(keyIntent(new Set(['KeyA', 'ArrowRight', 'KeyS'])), { x: 0, y: 1 });
  assert.deepEqual(keyIntent(new Set()), { x: 0, y: 0 });
});

test('E toggles the nearest gate in reach, and nothing out of reach', () => {
  const { map, gate, body } = scene();
  assert.equal(toggleNearbyGate(map, { x: gate.x + GATE_REACH * 40, y: gate.y }, RADIUS), null);
  assert.equal(toggleNearbyGate(map, body, RADIUS), 'Closed nearby gate.');
  assert.equal(gate.open, false);
  assert.equal(toggleNearbyGate(map, body, RADIUS), 'Opened nearby gate.');
  assert.equal(gate.open, true);
});

test('a gate never closes on the walker', () => {
  const { map, gate } = scene();
  const onGate = { x: gate.x, y: gate.y };
  assert.equal(nearestInReach(map, onGate), gate);
  assert.equal(toggleNearbyGate(map, onGate, RADIUS), 'Cannot close a gate on the walker.');
  assert.equal(gate.open, true, 'a refused close leaves the gate open');
});
