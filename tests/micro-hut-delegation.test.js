import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHut, buildHutGeneration, HUT_EXECUTION_REGISTRY } from '../map/micro/strategies/hut.ts';
import { buildBlock, planBlock } from '../map/micro/strategies/block.ts';
import { executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { saveDelegationSnapshot, readDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';
import { createAccessMask, elementShapes, travelClear } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { measurement } from '../map/macro/src/chain/measurement.ts';
import { liveMapFromBuilt } from '../map/live.ts';
import { generate, readMap } from '../map/tools/core.ts';
import { chainMapToJson, chainMapToBson } from '../map/macro/src/chain/saving.ts';

const SIZE = 40;
const rectangle = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, n) =>
  ({ x: n % w, y: Math.floor(n / w) })).filter(({ x, y }) => keep(x, y));
const input = (id, cells, portals = [], extra = {}) => ({ id, seed: 3, type: 'hut', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0, cells }], portals, ...extra });
const broad = () => input('concave-yard', rectangle(28, 12, (x, y) => y < 8 || x < 18), [
  { id: 'north', axis: 'h', x: 2, y: 0, length: 3 },
  { id: 'west', axis: 'v', x: 0, y: 7, length: 3 },
], { seed: 1 });
const placed = result => result.elements.flatMap(element => elementShapes(element, true));
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const house = result => result.elements.find(element => element.template?.encloses);
const roundTrip = value => JSON.parse(JSON.stringify(value));
const assertGeometry = result => {
  assert.deepEqual(validateFillConstraints(result.brief, placed(result)), []);
  assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, []);
};

test('a broad concave yard gives cover a lobe while preserving the house, door, and combined access', () => {
  const original = broad(), node = buildHutGeneration(original), flat = flattenDelegationResult(node);
  assert.equal(node.actualBuilder, 'hut');
  assert.ok(node.children?.some(child => child.actualBuilder === 'cover'), 'a real cover child was built');
  assert.ok(node.preparation.rejected.some(({ reason }) => reason.includes('cover has no usable placement')),
    'a lobe with unusable inherited fill remains with the hut');
  assert.ok(house(node.retained), 'the house stays with the hut');
  assert.deepEqual(node.retained.brief.portals.filter(portal => original.portals.some(p => p.id === portal.id)),
    original.portals, 'the hut keeps its original portal promise');
  assert.deepEqual(house(flat), house(node.retained));
  assert.ok(house(flat).template.parts.some(part => part.part === 'gate'), 'the outside door remains');
  assert.ok(flat.elements.some(element => element.label.includes('/delegate/') && !element.template.encloses), 'cover contributes geometry');
  assert.equal(flat.manifest.cells, original.cells.length);
  assert.deepEqual(flat.brief, node.input);
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  assert.ok(node.preparation.crossings.length, 'the handoff has paired crossings');
  const allBlockers = blockers(flat), leaves = executionLeaves(node);
  for (const crossing of node.preparation.crossings) {
    const owners = leaves.filter(leaf => leaf.brief.portals.some(portal => portal.id === crossing.portal.id));
    assert.equal(owners.length, 2, `both sides own crossing ${crossing.portal.id}`);
    assert.deepEqual(owners[0].brief.portals.find(portal => portal.id === crossing.portal.id),
      owners[1].brief.portals.find(portal => portal.id === crossing.portal.id));
  }
  for (const leaf of leaves) {
    assertGeometry(leaf);
    const mask = createAccessMask(leaf.brief), radius = hunterClearance(SIZE);
    for (const { portal, points } of portalStands(leaf.brief)) {
      assert.ok(points.length, `${leaf.brief.id}: ${portal.id} has hunter stands`);
      for (const point of points)
        assert.ok(travelClear(mask, allBlockers, point, point, radius), `${leaf.brief.id}: ${portal.id} stand is clear in combined geometry`);
      for (let i = 1; i < points.length; i++)
        assert.ok(travelClear(mask, allBlockers, points[i - 1], points[i], radius), `${leaf.brief.id}: ${portal.id} run is clear in combined geometry`);
    }
  }
  assertGeometry(flat);
  assert.deepEqual(buildHut(original), { ...flat, brief: original });
});

test('production hut adapters preserve Layout briefs for full chain saves', () => {
  const map = generate('last-exit-001');
  const json = chainMapToJson(map), bson = chainMapToBson(map);
  assert.deepEqual(readMap(JSON.parse(json)), map);
  assert.deepEqual(readMap(bson), map);
});

test('a small yard retains its house without forcing a cover patch', () => {
  const original = input('small-yard', rectangle(6, 6), [{ id: 'south', axis: 'h', x: 1, y: 6, length: 2 }]);
  const node = buildHutGeneration(original), flat = flattenDelegationResult(node);
  assert.ok(house(flat));
  assert.equal(node.children?.length ?? 0, 0);
  assert.equal(flat.elements.length, 1);
  assertGeometry(flat);
});

test('split inherited fill refuses unbuildable cover without losing retained yard', () => {
  const original = broad();
  original.seed = 3;
  original.fillCells = original.cells.filter(cell => cell.x < 18);
  const node = buildHutGeneration(original), flat = flattenDelegationResult(node);
  assert.ok(house(flat));
  assert.ok(node.offers?.length, 'the hut still identifies yard lobes');
  assert.equal(node.children?.length ?? 0, 0);
  assert.ok(node.preparation.rejected.every(({ reason }) => reason.includes('cover has no usable placement')));
  assert.equal(node.preparation.rejected.length, node.offers.length);
  assert.equal(node.retained.brief.cells.length, original.cells.length, 'rejected cells stay retained');
  assertGeometry(flat);
});

test('canonical cells, portals, and zones give the same real hut delegation', () => {
  const original = broad(), reversed = structuredClone(original);
  original.zones = [
    { tier: 1, bonus: 0, lootChance: 0, cells: original.cells.filter(cell => cell.x < 14) },
    { tier: 3, bonus: 0, lootChance: 0, cells: original.cells.filter(cell => cell.x >= 14) },
  ];
  reversed.zones = structuredClone(original.zones);
  reversed.cells.reverse();
  reversed.portals.reverse();
  reversed.zones.reverse();
  for (const zone of reversed.zones) zone.cells.reverse();
  assert.deepEqual(buildHutGeneration(reversed), buildHutGeneration(original));
});

test('depth zero keeps the hut and records cover requests as terminal empty children', () => {
  const original = broad(), node = buildHutGeneration(original, { maxDepth: 0 });
  assert.ok(node.children?.length, 'the hut still offers spare yard');
  assert.ok(house(node.retained));
  for (const child of node.children) {
    assert.equal(child.requestedBuilder, 'cover');
    assert.equal(child.actualBuilder, 'empty');
    assert.equal(child.fallbackKind, 'depth-limit');
    assert.deepEqual(child.retained.brief, child.input);
  }
  const flat = flattenDelegationResult(node);
  assert.equal(flat.elements.length, 1);
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  assertGeometry(flat);
});

test('no usable fill replaces the whole hut with empty and keeps original obligations', () => {
  const original = input('no-fill-hut', rectangle(6, 6), [{ id: 'south', axis: 'h', x: 1, y: 6, length: 2 }],
    { fillCells: [], coreElements: { spawn: 1 } });
  const node = buildHutGeneration(original), flat = flattenDelegationResult(node);
  assert.equal(node.actualBuilder, 'empty');
  assert.equal(node.requestedBuilder, 'hut');
  assert.equal(node.fallbackKind, 'builder-empty');
  assert.deepEqual(flat.elements, []);
  assert.deepEqual(flat.loot, []);
  assert.deepEqual(flat.brief.coreElements, { spawn: 1 });
  assert.deepEqual(flat.brief.portals, original.portals);
  assert.equal(flat.manifest.cells, original.cells.length);
  const built = { cellSize: SIZE, regions: [flat], pairs: [] };
  const report = measurement(built, { components: [[original.id]] }, { setPieces: [] }, { setPieceClasses: [] });
  assert.ok(report.defects.some(defect => defect.kind === 'broken-promise' && defect.message.includes('sited 0 spawn')));
  assert.throws(() => liveMapFromBuilt(1, built), /needs .* spawns/);
});

test('a real pilot snapshot recovers full and omitted results', () => {
  const node = buildHutGeneration(broad());
  assert.ok(node.children?.some(child => child.actualBuilder === 'cover'));
  const full = roundTrip(saveDelegationSnapshot(node));
  assert.deepEqual(readDelegationSnapshot(full), node);
  assert.deepEqual(delegationSnapshotResult(full), flattenDelegationResult(node));
  const omitted = roundTrip(saveDelegationSnapshot(node, { omitResults: true }));
  assert.deepEqual(readDelegationSnapshot(omitted, HUT_EXECUTION_REGISTRY), node);
  assert.deepEqual(delegationSnapshotResult(omitted, HUT_EXECUTION_REGISTRY), flattenDelegationResult(node));
});

test('a hut on the eastern side of a large authored map keeps its global snapshot coordinates', () => {
  const original = broad(), shift = cells => cells.map(cell => ({ x: cell.x + 10_000, y: cell.y }));
  original.cells = shift(original.cells);
  for (const zone of original.zones) zone.cells = shift(zone.cells);
  for (const portal of original.portals) portal.x += 10_000;
  const node = buildHutGeneration(original), flat = flattenDelegationResult(node);
  assert.ok(house(flat));
  assert.ok(node.offers?.length, 'global coordinates do not exclude the pilot handoff');
  assertGeometry(flat);
  assert.deepEqual(readDelegationSnapshot(roundTrip(saveDelegationSnapshot(node))), node);
  assert.deepEqual(readDelegationSnapshot(roundTrip(saveDelegationSnapshot(node, { omitResults: true })), HUT_EXECUTION_REGISTRY), node);
  const invalid = broad(); invalid.cells[0].x = Number.MAX_SAFE_INTEGER;
  assert.throws(() => buildHutGeneration(invalid), /safe integers.*offsets/);
});

test('a planned block hut lot builds through the production path with its nested label', () => {
  const cells = rectangle(44, 34), original = input('nested-block', cells, [
    { id: 'west', axis: 'v', x: 0, y: 7, length: 3 },
    { id: 'east', axis: 'v', x: 44, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 },
  ], { type: 'block', seed: 1 });
  const plan = planBlock(original), lot = plan.lots.find(child => child.type === 'hut');
  assert.ok(lot, 'the block makes a hut lot');
  const nested = buildHutGeneration(lot), block = buildBlock(original);
  assert.ok(house(flattenDelegationResult(nested)));
  const prefix = `${lot.id.slice(original.id.length + 1)}/`;
  assert.ok(block.elements.some(element => element.label === `${prefix}hut-building`));
  for (const element of flattenDelegationResult(nested).elements)
    assert.ok(block.elements.some(placed => placed.label === `${prefix}${element.label}`), `block retains ${element.label}`);
  assertGeometry(block);
});
