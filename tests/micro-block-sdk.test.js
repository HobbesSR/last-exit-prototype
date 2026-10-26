import test from 'node:test';
import assert from 'node:assert/strict';
import { planBlock } from '../map/micro/strategies/block.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { validateDecompositionPlan } from '../map/micro/decomposition/validate.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { hintErrors, hintedCells } from '../map/micro/hints.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { regionExample } from '../map/micro/region-examples.ts';

const key = ({ x, y }) => `${x},${y}`;
const shifted = (cells, dx, dy) => cells.map(c => ({ x: c.x + dx, y: c.y + dy }));

function withBoundaryHints(input, shape) {
  return { ...input, hints: shape === 'neck'
    ? [{ axis: 'v', x: 0, y: 0, length: 4 }, { axis: 'v', x: 0, y: 14, length: 4 }]
    : [{ axis: 'h', x: 10, y: 18, length: 4 }] };
}

test('SDK fallback rescues a neck and cross with one safe lot and a connected open remainder', () => {
  for (const shape of ['neck', 'cross']) {
    const input = withBoundaryHints(regionExample({ type: 'block', shape, width: 24, height: 18, seed: 1, northPortal: shape === 'neck' }), shape);
    const plan = planBlock(input), children = [...plan.lots, plan.alleys];
    assert.ok(plan.allocation, `${shape}: bounded fallback is inspectable`);
    assert.equal(plan.allocation.strategy, 'block-single-lot-fallback');
    assert.ok(plan.lots.length > 0, `${shape}: fallback selects a lot`);
    assert.ok(plan.lots.length <= 1);
    assert.ok(plan.allocation.search.considered <= 64);
    assert.ok(plan.allocation.search.expanded <= 64);
    assert.deepEqual(validateDecompositionPlan(plan.allocation), []);
    assert.deepEqual(new Set(plan.allocation.pieces[0].cells.map(key)), new Set(plan.lots[0].cells.map(key)));
    assert.equal(plan.allocation.residuals.length, 1, 'the SDK remainder is one connected open child');
    assert.deepEqual(new Set(plan.allocation.residuals[0].cells.map(key)), new Set(plan.alleys.cells.map(key)));
    assert.deepEqual(validateBriefPartition(input, children), [], `${shape}: exact ownership and paired portals`);

    const owners = children.flatMap(child => child.cells.map(key));
    assert.equal(new Set(owners).size, owners.length, `${shape}: cells have one owner`);
    assert.deepEqual([...owners].sort(), input.cells.map(key).sort(), `${shape}: every parent cell is owned`);
    for (const portal of input.portals)
      assert.ok(plan.alleys.portals.some(p => p.id === portal.id && p.axis === portal.axis && p.x === portal.x && p.y === portal.y && p.length === portal.length),
        `${shape}: original portal ${portal.id} stays in the open residual`);

    const childHints = children.flatMap(child => hintedCells(child).map(key));
    assert.equal(new Set(childHints).size, childHints.length, `${shape}: hints are not duplicated`);
    assert.deepEqual([...childHints].sort(), hintedCells(input).map(key).sort(), `${shape}: hints survive partition`);
    for (const child of children) assert.deepEqual(hintErrors(child), [], `${shape}: ${child.id} has valid clipped hints`);

    for (const child of children) {
      const built = buildRegion(child);
      assert.deepEqual(validateFillConstraints(child, built.elements.flatMap(element => elementShapes(element, true))), [],
        `${shape}: ${child.id} geometry respects inherited fill/clear margins`);
      assert.deepEqual(validatePortalReach({ ...child, blockers: built.elements.flatMap(element => elementShapes(element)) }).errors, [],
        `${shape}: ${child.id} keeps its own hunter portal promise`);
    }
    const result = buildRegion(input);
    assert.deepEqual(validatePortalReach({ ...input, blockers: result.elements.flatMap(element => elementShapes(element)) }).errors, [],
      `${shape}: emitted block geometry keeps the original hunter portal promise`);
  }
});

test('fallback allocation is stable under input ordering and coordinate translation', () => {
  const input = withBoundaryHints(regionExample({ type: 'block', shape: 'neck', width: 24, height: 18, seed: 1, northPortal: true }), 'neck');
  const original = planBlock(input), reordered = planBlock({ ...input, cells: [...input.cells].reverse() });
  assert.deepEqual(reordered, original, 'cell enumeration does not affect the selected fallback');

  const dx = 31, dy = -17;
  const translated = planBlock({ ...input, cells: shifted(input.cells, dx, dy),
    zones: input.zones.map(zone => ({ ...zone, cells: shifted(zone.cells, dx, dy) })),
    portals: input.portals.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
    hints: input.hints.map(h => ({ ...h, x: h.x + dx, y: h.y + dy })),
  });
  const canonical = cells => cells.map(c => ({ x: c.x, y: c.y })).sort((a, b) => a.y - b.y || a.x - b.x);
  assert.deepEqual(canonical(shifted(translated.lots[0].cells, -dx, -dy)), canonical(original.lots[0].cells));
  assert.deepEqual(canonical(shifted(translated.alleys.cells, -dx, -dy)), canonical(original.alleys.cells));
  assert.deepEqual(translated.allocation.pieces.map(p => p.id), original.allocation.pieces.map(p => p.id));
  assert.deepEqual(translated.allocation.search, original.allocation.search);
});

test('thin regions and regions beyond SDK bounds retain safe ownership without an SDK claim', () => {
  const thinCells = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 64; x++) thinCells.push({ x, y });
  const thin = { id: 'thin-block', seed: 1, type: 'block', cellSize: 200, cells: thinCells,
    zones: [{ tier: 2, bonus: 0, lootChance: 0, cells: thinCells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 1, length: 2 }] };
  const thinPlan = planBlock(thin);
  assert.equal(thinPlan.lots.length, 0);
  assert.ok(thinPlan.allocation, 'maximum span and cell scale remain eligible');
  assert.equal(thinPlan.allocation.pieces.length, 0);
  assert.equal(thinPlan.alleys.cells.length, thinCells.length);
  assert.equal(planBlock({ ...thin, cellSize: 201 }).allocation, undefined, 'cell scale above the SDK limit skips the fallback');

  const wideCells = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 65; x++) wideCells.push({ x, y });
  const wide = { ...thin, id: 'wide-thin-block', cells: wideCells,
    zones: [{ tier: 2, bonus: 0, lootChance: 0, cells: wideCells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 1, length: 2 }] };
  const widePlan = planBlock(wide);
  assert.equal(widePlan.allocation, undefined, 'more than 64 cells on an axis skips SDK context creation');
  assert.equal(widePlan.lots.length, 0);
  assert.equal(widePlan.alleys.cells.length, wideCells.length);
});
