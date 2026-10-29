import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHutGeneration, HUT_EXECUTION_REGISTRY } from '../map/micro/strategies/hut.ts';
import { executeDelegation, executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { chainBrief, reorderedBrief } from './helpers/chain-briefs.js';
import { cellsOf } from './helpers/cells.js';
import { hutCordEvidence } from './helpers/hut-cord-geometry.js';

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
