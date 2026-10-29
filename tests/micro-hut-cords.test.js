import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHutGeneration, HUT_EXECUTION_REGISTRY } from '../map/micro/strategies/hut.ts';
import { executeDelegation, executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { chainBrief, chainFixtures, reorderedBrief } from './helpers/chain-briefs.js';
import { cellsOf } from './helpers/cells.js';
import { hutCordEvidence, hutApproaches } from './helpers/hut-cord-geometry.js';
import { HOUSE } from '../map/micro/placeables/house.ts';
import { placedElements } from '../map/micro/placeables/placeable.ts';
import { createAccessMask, travelClear } from '../map/micro/geometry.ts';
import { hunterClearance } from '../map/micro/portals.ts';
import { planBlock } from '../map/micro/strategies/block.ts';

const input = (cellSize = 40) => chainBrief({ id: 'reroute', type: 'hut', seed: 1, cellSize,
  cells: cellsOf(24, 18), portals: [{ id: 'w', axis: 'v', x: 0, y: 8, length: 2 }, { id: 'e', axis: 'v', x: 24, y: 8, length: 2 }] });

for (const size of [16, 40, 80]) test(`production hut moves its yard route around useful boundary boxes at size ${size}`, () => {
  const original = input(size), node = buildHutGeneration(original), flat = flattenDelegationResult(node);
  const evidence = hutCordEvidence(node, flat);
  assert.ok(evidence.displaced.length, 'an accepted child intersects the pre-handoff house-envelope route');
  assert.equal(evidence.finalAccess, true, 'actual door approaches connect through final combined geometry');
  const house = node.retained.elements.find(e => e.label === 'hut-building');
  assert.ok(house.x > 0 && house.y > 0 && house.x + house.template.w < 24 * size && house.y + house.template.h < 18 * size,
    'the primary building is an interior island');
  assert.ok(node.children.length > 0);
  for (const offer of node.offers) {
    assert.ok(offer.cells.some(c => c.x === 0 || c.y === 0 || c.x === 23 || c.y === 17), 'patch touches the original boundary');
    const xs = offer.cells.map(c => c.x), ys = offer.cells.map(c => c.y);
    const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
    assert.ok(w >= 3 && h >= 3);
    assert.equal(offer.cells.length, w * h, 'useful full rectangle rather than an accidental circulation remnant');
  }
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(n => n.brief)), []);
  const blockers = flat.elements.flatMap(e => elementShapes(e));
  for (const owner of [...executionLeaves(node), flat]) {
    assert.deepEqual(validateFillConstraints(owner.brief, owner.elements.flatMap(e => elementShapes(e, true))), []);
    assert.deepEqual(validatePortalReach({ ...owner.brief, blockers }, { search: 'thorough' }).errors, []);
  }
  assert.deepEqual(buildHutGeneration(reorderedBrief(original)), node);
  for (const omitResults of [false, true]) {
    const snapshot = JSON.parse(JSON.stringify(saveDelegationSnapshot(node, { omitResults })));
    assert.deepEqual(readDelegationSnapshot(snapshot, HUT_EXECUTION_REGISTRY), node);
  }
});

test('refused production offers leave house, original ownership and access retained', () => {
  let probes = 0;
  const registry = { ...HUT_EXECUTION_REGISTRY, cover: { ...HUT_EXECUTION_REGISTRY.cover,
    receiving() { probes++; return 'fixture refuses cover'; }, build() { throw Error('refused child dispatched'); } } };
  const node = executeDelegation(input(), registry);
  assert.ok(probes > 0);
  assert.equal(node.children?.length ?? 0, 0);
  assert.deepEqual(node.retained.brief, node.input);
  assert.ok(node.retained.elements.find(e => e.label === 'hut-building'));
  assert.equal(hutCordEvidence(node, flattenDelegationResult(node)).finalAccess, true);
  const snapshot = JSON.parse(JSON.stringify(saveDelegationSnapshot(node, { omitResults: true })));
  assert.deepEqual(readDelegationSnapshot(snapshot, registry), node);
  assert.throws(() => readDelegationSnapshot(snapshot, { ...registry, cover: { ...registry.cover, version: 'changed-rejected-receiver' } }), /cover/);
});

test('concave, holed, internally cleared and nested hut yards keep final owner and door access', () => {
  const fixtures = chainFixtures().filter(f => ['ell-strip', 'ring-strip', 'field-strips-a'].includes(f.name))
    .map(f => chainBrief({ ...f, id: f.name, type: 'hut', seed: 1 }));
  const cells = cellsOf(44, 34), block = { ...input(), id: 'nested-block', type: 'block', cells,
    zones: [{ tier: 3, bonus: 0, lootChance: 0, cells }], portals: [
      { id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 44, y: 20, length: 3 },
      { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }] };
  delete block.fillCells; delete block.clearCells;
  const nested = planBlock(block).lots.find(lot => lot.type === 'hut');
  assert.ok(nested, 'the test exercises a real block lot');
  for (const brief of [...fixtures, nested]) {
    const node = buildHutGeneration(brief), flat = flattenDelegationResult(node);
    assert.ok(hutApproaches(node), brief.id);
    assert.equal(hutCordEvidence(node, flat).finalAccess, true, brief.id);
    const blockers = flat.elements.flatMap(e => elementShapes(e));
    for (const owner of [...executionLeaves(node), flat]) {
      assert.deepEqual(validateFillConstraints(owner.brief, owner.elements.flatMap(e => elementShapes(e, true))), []);
      assert.deepEqual(validatePortalReach({ ...owner.brief, blockers }, { search: 'thorough' }).errors, [], brief.id);
    }
  }
});

test('door approach reconstruction matches four hand-computed one-room entrances and physical door sweeps', () => {
  const brief = chainBrief({ type: 'hut', cells: cellsOf(10, 10), portals: [], cellSize: 40 });
  const expected = { N: { x: 200, y: 80 }, S: { x: 200, y: 320 }, W: { x: 80, y: 200 }, E: { x: 320, y: 200 } };
  for (const door of ['N', 'S', 'W', 'E']) {
    const placed = HOUSE.build({ w: 4, h: 4, door, spaces: 1, seed: 1 }, 40);
    assert.ok(!('refused' in placed));
    const [house] = placedElements(placed, 'hut-building', 3, 3, 40);
    const approach = hutApproaches({ input: brief, retained: { elements: [house] }, observerEvents: [{ label: 'hut-building', realization: placed.details.realization }] });
    assert.deepEqual(approach.terminals, [expected[door]]);
    assert.equal(travelClear(createAccessMask(brief), elementShapes(house), expected[door], { x: 200, y: 200 }, hunterClearance(40)), true);
  }
});

test('a verified hut partition that cannot be reproduced is an invariant error before dispatch', () => {
  let dispatched = 0;
  const original = HUT_EXECUTION_REGISTRY.hut;
  const registry = { ...HUT_EXECUTION_REGISTRY, hut: { ...original, build(brief, context, observe) {
    const seen = new Set();
    return original.build(brief, { get brief() { return context.brief; }, empty: context.empty,
      delegate(...args) { dispatched++; return context.delegate(...args); },
      prepareDelegation(offers, policy) {
        const prepared = context.prepareDelegation(offers, policy), key = JSON.stringify(offers.map(o => o.key));
        if (seen.has(key)) return { ...prepared, rejected: [{ key: 'fixture', reason: 'non-deterministic preparation' }] };
        seen.add(key); return prepared;
      } }, observe);
  } } };
  assert.throws(() => executeDelegation(input(), registry), /Verified hut handoff could not execute/);
  assert.equal(dispatched, 0, 'failed reproduction never publishes a changed partition');
});
