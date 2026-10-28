import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDelegation } from '../map/micro/delegation.ts';
import { rect } from '../shared/shape.ts';

const cells = (x, y, w, h) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
const owned = cells(0, 0, 9, 6);
const parent = { id: 'parent', seed: 271, type: 'hut', cellSize: 40, cells: owned,
  zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned }], portals: [] };
const patch = { key: 'side', type: 'open', cells: cells(7, 0, 2, 6) };
const policy = extra => ({ receiving: () => null, ...extra });

test('crossing observation preserves output, including when callback mutates its event', () => {
  const offers = [patch, { key: 'west', type: 'open', cells: cells(0, 0, 2, 6) }];
  const expected = prepareDelegation(parent, offers, policy());
  const events = [];
  const actual = prepareDelegation(parent, offers, policy(), event => {
    events.push(structuredClone(event));
    event.offerKeys.length = 0;
    event.run.x = 999;
    if (event.portal) event.portal.id = 'mutated';
    event.protectedCells.push({ x: 999, y: 999 });
  });
  assert.deepEqual(actual, expected);
  assert.ok(events.some(e => e.reason === 'selected'));
  assert.deepEqual(events.map(e => e.offerKeys), [['side'], ['side', 'west'], ['side', 'west']]);
  assert.ok(events.every(e => e.portal && e.protectedCells.length === 0));
});

test('observer reports protected footprint, blocked travel, and short runs', () => {
  const events = [];
  const observe = event => events.push(event);
  const protectedPolicy = policy({ protectedCells: [{ x: 6, y: 1 }] });
  assert.deepEqual(prepareDelegation(parent, [patch], protectedPolicy, observe), prepareDelegation(parent, [patch], protectedPolicy));
  assert.equal(events[0].reason, 'protected-footprint');
  assert.deepEqual(events[0].protectedCells, [{ x: 6, y: 1 }]);
  events.length = 0;
  const blockedPolicy = policy({ blockers: [rect(275, 0, 10, 240)] });
  assert.deepEqual(prepareDelegation(parent, [patch], blockedPolicy, observe), prepareDelegation(parent, [patch], blockedPolicy));
  assert.equal(events[0].reason, 'blocked-travel');
  events.length = 0;
  const small = { key: 'corner', type: 'open', cells: cells(8, 0, 1, 1) };
  assert.deepEqual(prepareDelegation(parent, [small], policy(), observe), prepareDelegation(parent, [small], policy()));
  assert.ok(events.some(e => e.reason === 'too-short' && e.portal === null));
});
