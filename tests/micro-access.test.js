import test from 'node:test';
import assert from 'node:assert/strict';
import { rect } from '../shared/shape.ts';
import { resolveAccessRequirements, validateRegionAccess } from '../shared/map/micro/access.ts';

const cells = (width = 8, height = 6) => Array.from({ length: width * height }, (_, i) => ({ x: i % width, y: Math.floor(i / width) }));
const portPair = (required = 'hunter', allowed = required) => [
  { id: 'west', side: 'W', start: { x: 0, y: 2 }, length: 2, required, allowed },
  { id: 'east', side: 'E', start: { x: 7, y: 2 }, length: 2, required, allowed },
];
const input = (overrides = {}) => ({ cells: cells(), cellSize: 100, bodyProfile: 'cell', ports: portPair(), blockers: [], ...overrides });

test('open mouths do not make disconnected interior required access valid', () => {
  const result = validateRegionAccess(input({ blockers: [rect(395, 0, 10, 600)] }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => /disconnected/.test(error)));
});

test('a single required port still needs a clear crossing and interior standing room', () => {
  const one = [portPair()[0]];
  const result = validateRegionAccess(input({ ports: one, blockers: [rect(0, 200, 8, 200)] }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => /passage floor|standing room/.test(error)));
});

test('contestant-only geometry admits contestants and rejects hunters', () => {
  const ports = portPair('contestant', 'contestant');
  // The canonical 150-unit aperture is centred in each two-cell boundary run.
  const jambs = [rect(0, 200, 8, 25), rect(0, 375, 8, 25), rect(792, 200, 8, 25), rect(792, 375, 8, 25)];
  const result = validateRegionAccess(input({ ports, blockers: jambs }));
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.deepEqual(result.routes.map(route => route.role), ['contestant']);
});

test('the route finder proves a freeform reroute rather than trusting direct visibility', () => {
  const ports = portPair('contestant', 'contestant');
  const jambs = [rect(0, 200, 8, 25), rect(0, 375, 8, 25), rect(792, 200, 8, 25), rect(792, 375, 8, 25)];
  const result = validateRegionAccess(input({ ports, blockers: [...jambs, rect(395, 0, 10, 300)] }));
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.ok(result.routes[0].points.length > 2);
});

test('malformed contracts are rejected independently and no required ports need no routes', () => {
  const broken = input({ ports: [{ ...portPair()[0], required: 'hunter', allowed: 'contestant' }] });
  assert.throws(() => resolveAccessRequirements(broken), /Invalid or duplicate/);
  assert.equal(validateRegionAccess(broken).valid, false);
  const empty = validateRegionAccess(input({ ports: [] }));
  assert.deepEqual(empty, { valid: true, errors: [], routes: [] });
});
