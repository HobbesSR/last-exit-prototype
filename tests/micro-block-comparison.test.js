import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlock, planBlock } from '../map/micro/strategies/block.ts';
import { WorkBudget, WorkBudgetExceededError } from '../map/micro/decomposition/work-budget.ts';
import { validateDecompositionPlan } from '../map/micro/decomposition/validate.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { cellsOf } from './helpers/cells.js';
import { applyClearConstraints, withClearMargins } from '../map/kernel/margins.ts';

const key = ({ x, y }) => `${x},${y}`;
const options = () => ({ planner: 'sdk-experimental' });
function witness() {
  const cells = cellsOf(72, 24);
  return { id: 'comparison-block', seed: 1, type: 'block', cellSize: 40, cells,
    zones: [{ tier: 2, bonus: 0, lootChance: 0.04, cells: [...cells] }],
    portals: [{ id: 'north', axis: 'h', x: 24, y: 0, length: 2 },
      { id: 'south', axis: 'h', x: 24, y: 24, length: 2 }] };
}

test('experimental SDK selection partitions a block into competing spaced lots and safe alleys', () => {
  const input = witness(), plan = planBlock(input, options()), children = [...plan.lots, plan.alleys];
  assert.equal(plan.experimental.budgetExhausted, false);
  assert.equal(plan.experimental.rejected, undefined);
  assert.ok(plan.lots.length >= 2 && plan.lots.length <= 8, 'witness selects multiple lots');
  assert.ok(plan.allocation.search.considered <= 32);
  assert.deepEqual(validateDecompositionPlan(plan.allocation), []);
  assert.deepEqual(validateBriefPartition(input, children), []);
  const owned = children.flatMap(child => child.cells.map(key));
  assert.equal(new Set(owned).size, owned.length);
  assert.deepEqual(owned.sort(), input.cells.map(key).sort());
  for (const portal of input.portals) assert.deepEqual(plan.alleys.portals.find(p => p.id === portal.id), portal);
  const bays = plan.lots.map(lot => {
    const x = Math.min(...lot.cells.map(c => c.x)), y = Math.min(...lot.cells.map(c => c.y));
    return `${Math.floor(x / 27)},${Math.floor(y / 27)}`;
  });
  assert.equal(new Set(bays).size, bays.length, 'alternatives in a bay compete for ownership');
  for (const child of children) {
    const built = buildRegion(child);
    assert.deepEqual(validateFillConstraints(child, built.elements.flatMap(e => elementShapes(e, true))), []);
    assert.deepEqual(validatePortalReach({ ...child, blockers: built.elements.flatMap(e => elementShapes(e)) }).errors, []);
  }
  const built = buildBlock(input, undefined, options());
  assert.deepEqual(validateFillConstraints(input, built.elements.flatMap(e => elementShapes(e, true))), []);
  assert.deepEqual(validatePortalReach({ ...input, blockers: built.elements.flatMap(e => elementShapes(e)) }).errors, []);
});

test('experimental planning is deterministic and exposes exhausted work', () => {
  const input = witness();
  assert.deepEqual(planBlock({ ...input, cells: [...input.cells].reverse() }, options()), planBlock(input, options()));
  const limited = () => ({ ...options(), experimentalBudget: new WorkBudget(100) });
  const exhausted = planBlock(input, limited());
  assert.deepEqual(exhausted, planBlock(input, limited()));
  assert.equal(exhausted.experimental.budgetExhausted, true);
  assert.ok(exhausted.experimental.used > exhausted.experimental.limit);
  assert.throws(() => buildBlock(input, undefined, limited()), WorkBudgetExceededError);
});

test('experimental children retain inherited clear and fill margins', () => {
  const base = witness(), margin = withClearMargins(base);
  const inherited = [{ x: 5, y: 5 }, { x: 35, y: 5 }, { x: -1, y: 5 }];
  const input = { ...base, ...applyClearConstraints(base.cells, margin.clearCells, inherited) };
  const plan = planBlock(input, options()), children = [...plan.lots, plan.alleys];
  assert.equal(plan.experimental.budgetExhausted, false);
  assert.equal(plan.experimental.rejected, undefined);
  assert.ok(plan.lots.length >= 2);
  assert.deepEqual(validateBriefPartition(input, children), []);
  for (const cell of inherited.slice(0, 2)) {
    const owner = children.find(child => child.cells.some(c => key(c) === key(cell)));
    assert.ok(owner.clearCells.some(c => key(c) === key(cell)), 'owner retains inherited clearance');
    assert.ok(!owner.fillCells.some(c => key(c) === key(cell)), 'clear cell is excluded from fill');
  }
  assert.ok(children.some(child => child.clearCells.some(c => key(c) === '-1,5')), 'nearby exterior clearance is retained');
  for (const child of children) {
    const built = buildRegion(child);
    assert.deepEqual(validateFillConstraints(child, built.elements.flatMap(e => elementShapes(e, true))), []);
    assert.deepEqual(validatePortalReach({ ...child, blockers: built.elements.flatMap(e => elementShapes(e)) }).errors, []);
  }
  const built = buildBlock(input, undefined, options());
  assert.deepEqual(validateFillConstraints(input, built.elements.flatMap(e => elementShapes(e, true))), []);
  assert.deepEqual(validatePortalReach({ ...input, blockers: built.elements.flatMap(e => elementShapes(e)) }).errors, []);
});

