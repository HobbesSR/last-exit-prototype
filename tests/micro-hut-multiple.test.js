import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHutGeneration, HUT_EXECUTION_REGISTRY } from '../map/micro/strategies/hut.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { createAccessMask, elementShapes } from '../map/micro/geometry.ts';
import { discoverCordWitness } from '../map/micro/cord-witness.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { chainBrief, chainFixtures, reorderedBrief } from './helpers/chain-briefs.js';
import { cellsOf } from './helpers/cells.js';
import { hutApproaches } from './helpers/hut-cord-geometry.js';

const houses = node => node.retained.elements.filter(e => /^hut-building(?:-\d+)?$/.test(e.label));
function checkGeometry(node) {
  const flat = flattenDelegationResult(node), mask = createAccessMask(node.input), size = node.input.cellSize;
  const buildings = houses(node), terminals = [];
  assert.ok(buildings.length <= 8);
  for (const [index, house] of buildings.entries()) {
    const x = house.x / size, y = house.y / size, w = house.template.w / size, h = house.template.h / size;
    if (index) {
      for (let j = y - 2; j < y + h + 2; j++) for (let i = x - 2; i < x + w + 2; i++)
        assert.ok(mask.has(i, j), `${house.label} lacks access ring at ${i},${j}`);
    }
    for (const other of buildings.slice(0, index)) {
      const ox = other.x / size, oy = other.y / size, ow = other.template.w / size, oh = other.template.h / size;
      assert.ok(x >= ox + ow + 2 || ox >= x + w + 2 || y >= oy + oh + 2 || oy >= y + h + 2,
        `${house.label} too close to ${other.label}`);
    }
    const trace = node.observerEvents.find(e => e.label === house.label);
    assert.ok(trace, `missing realization for ${house.label}`);
    const approach = hutApproaches({ input: node.input, retained: { elements: [{ ...house, label: 'hut-building' }] },
      observerEvents: [{ ...trace, label: 'hut-building' }] });
    terminals.push(...approach.terminals);
  }
  const blockers = flat.elements.flatMap(e => elementShapes(e));
  assert.deepEqual(validatePortalReach({ ...flat.brief, blockers }, { search: 'thorough' }).errors, []);
  if (terminals.length) {
    const witness = discoverCordWitness(node.retained.brief, blockers, terminals);
    assert.equal(witness.ok, true, `all actual door approaches reachable: ${witness.reason}`);
  }
}

const roomy = () => chainBrief({ id: 'multi-hut', type: 'hut', seed: 1, cells: cellsOf(32, 24), portals: [
  { id: 'w', axis: 'v', x: 0, y: 8, length: 3 }, { id: 'e', axis: 'v', x: 32, y: 12, length: 3 }] });

test('roomy hut places several spaced houses before yard handoff and preserves every entrance', () => {
  const brief = roomy(), node = buildHutGeneration(brief);
  assert.ok(houses(node).length > 1);
  assert.equal(houses(node)[0].label, 'hut-building');
  checkGeometry(node);
  assert.deepEqual(buildHutGeneration(reorderedBrief(brief)), node);
  for (const omitResults of [false, true]) {
    const snapshot = JSON.parse(JSON.stringify(saveDelegationSnapshot(node, { omitResults })));
    assert.deepEqual(readDelegationSnapshot(snapshot, HUT_EXECUTION_REGISTRY), node);
    if (omitResults) {
      snapshot.generation.registryVersions.hut = 'hut-yard-3';
      snapshot.generation.builderVersion = 'hut-yard-3';
      assert.throws(() => readDelegationSnapshot(snapshot, HUT_EXECUTION_REGISTRY), /hut.*version/i);
    }
  }
});

test('concave and internally cleared regions retain valid routes and secondary house rings', () => {
  for (const fixture of chainFixtures().filter(f => ['ell-strip', 'field-strips-a'].includes(f.name))) {
    const node = buildHutGeneration(chainBrief({ ...fixture, id: fixture.name, type: 'hut', seed: 1 }));
    assert.ok(houses(node).length, fixture.name);
    checkGeometry(node);
  }
});

test('compact and no-fit regions retain the primary fallback behavior', () => {
  const compact = buildHutGeneration(chainBrief({ id: 'compact', type: 'hut', cells: cellsOf(6, 6), portals: [] }));
  assert.equal(houses(compact).length, 1);
  checkGeometry(compact);
  const noFit = buildHutGeneration(chainBrief({ id: 'no-fit', type: 'hut', cells: cellsOf(2, 2), portals: [] }));
  assert.equal(houses(noFit).length, 0);
  assert.equal(noFit.actualBuilder, 'empty');
});
