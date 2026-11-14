import test from 'node:test';
import assert from 'node:assert/strict';
import { briefErrors, buildRegion } from '../map/micro/region-types.ts';
import { canonicalDelegationBrief, canonicalPreparedDelegationBrief, prepareDelegation } from '../map/micro/delegation.ts';

const brief = () => ({
  id: 'one', type: 'open', seed: 7, cellSize: 40, cells: [{ x: 0, y: 0 }],
  zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: [{ x: 0, y: 0 }] }], portals: [],
});

test('dispatch and delegation reject invalid scales and portal placement before execution', () => {
  let calls = 0;
  const registry = { open: () => calls++ };
  const invalid = [
    ...[0, -1, NaN, Infinity].map(cellSize => [ { ...brief(), cellSize }, /positive finite cell size/ ]),
    [{ ...brief(), portals: [{ id: 'outside', axis: 'h', x: 2, y: 0, length: 1 }] }, /perimeter/],
    [{ ...brief(), portals: [{ id: 'bad', axis: 'h', x: 0, y: 0, length: 0 }] }, /not a run/],
    [{ ...brief(), zones: [] }, /exactly one zone/],
    [{ ...brief(), coreElements: { spawn: -1 } }, /whole count/],
    [{ ...brief(), fillCells: brief().cells, clearCells: brief().cells }, /available for filling/],
  ];
  for (const [input, diagnostic] of invalid) {
    const before = structuredClone(input);
    assert.match(briefErrors(input).join(' '), diagnostic);
    for (const run of [() => buildRegion(input, registry), () => canonicalDelegationBrief(input),
      () => canonicalPreparedDelegationBrief(input), () => prepareDelegation(input, [], { receiving: () => null })]) {
      assert.throws(run, error => {
        assert.equal(error.message, `Invalid brief: ${briefErrors(input).join(' ')}`);
        return true;
      });
    }
    assert.deepEqual(input, before);
  }
  assert.equal(calls, 0);
});

test('dispatch preserves input order while delegation alone canonicalizes and derives margins', () => {
  const cells = [{ x: 1, y: 0 }, { x: 0, y: 0 }];
  const zone = { tier: 1, bonus: 0, lootChance: 0 };
  const input = { ...brief(), cells, zones: cells.map(c => ({ ...zone, cells: [c] })),
    portals: [{ id: 'short', axis: 'h', x: 0, y: 0, length: 1 }] };
  const before = structuredClone(input);
  assert.deepEqual(briefErrors(input), []);
  const dispatched = buildRegion(input, { open: b => b });
  assert.deepEqual(dispatched, before);
  assert.notEqual(dispatched, input);
  const canonical = canonicalDelegationBrief(input);
  assert.deepEqual(canonical.cells, [...cells].reverse());
  assert.equal(canonical.zones.length, 1);
  assert.ok(canonical.fillCells);
  assert.ok(canonical.clearCells.length);
  assert.deepEqual(canonicalPreparedDelegationBrief(canonical), canonical);
  assert.deepEqual(input, before);
  // Preserve each entry point's existing policy for partially specified margins.
  const clearOnly = { ...brief(), clearCells: brief().cells };
  assert.match(briefErrors(clearOnly).join(' '), /available for filling/);
  assert.deepEqual(canonicalDelegationBrief(clearOnly).fillCells, []);
});
