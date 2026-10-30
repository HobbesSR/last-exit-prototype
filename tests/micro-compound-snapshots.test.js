import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY } from '../map/micro/strategies/compound.ts';
import { flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { COVER_EXECUTION, COVER_EXECUTOR_VERSION } from '../map/micro/strategies/cover.ts';
import { saveDelegationSnapshot, readDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const brief = (id, cells, portals, extra = {}) => ({ id, seed: 1, type: 'compound', cellSize: SIZE, cells,
  zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals, ...extra });
const concave = () => brief('compound-concave', cellsOf(40, 34, (x, y) => y < 20 || x < 20), [
  { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
  { id: 'east', axis: 'v', x: 40, y: 8, length: 2 },
]);
const roundTrip = value => JSON.parse(JSON.stringify(value));

test('observer sees the ring and keep once and snapshots preserve both events', () => {
  const observed = [], node = buildCompoundGeneration(concave(), { observe: trace => observed.push(trace) });
  assert.deepEqual(observed.map(trace => trace.label), ['compound', 'compound-keep']);
  assert.deepEqual(node.observerEvents, observed);
  assert.deepEqual(readDelegationSnapshot(roundTrip(saveDelegationSnapshot(node))).observerEvents, observed);
});

test('full and omitted compound snapshots recover the same hierarchy and result', () => {
  const node = buildCompoundGeneration(concave()), flat = flattenDelegationResult(node);
  assert.ok(node.children?.some(child => child.actualBuilder === 'cover'));
  const full = roundTrip(saveDelegationSnapshot(node));
  assert.deepEqual(readDelegationSnapshot(full), node);
  assert.deepEqual(delegationSnapshotResult(full), flat);
  const omitted = roundTrip(saveDelegationSnapshot(node, { omitResults: true }));
  assert.deepEqual(readDelegationSnapshot(omitted, COMPOUND_EXECUTION_REGISTRY), node);
  assert.deepEqual(delegationSnapshotResult(omitted, COMPOUND_EXECUTION_REGISTRY), flat);
  const older = roundTrip(omitted);
  older.generation.registryVersions.compound = 'compound-yard-4';
  older.generation.builderVersion = 'compound-yard-4';
  assert.throws(() => readDelegationSnapshot(older, COMPOUND_EXECUTION_REGISTRY), /compound/);
});

test('omitted snapshots recover a compound whose infill receiver accepts former cluster misses', () => {
  const original = brief('compound-mixed', cellsOf(36, 30, (x, y) => y < 18 || x < 18), [
    { id: 'west', axis: 'v', x: 0, y: 6, length: 2 },
    { id: 'east', axis: 'v', x: 36, y: 6, length: 2 },
  ], { seed: 2 });
  const node = buildCompoundGeneration(original), flat = flattenDelegationResult(node);
  assert.ok(node.children?.some(child => child.actualBuilder === 'cover'));
  assert.equal(node.children.length, node.offers.length, 'individual pieces now fit all offered lobes in this witness');
  assert.equal(COMPOUND_EXECUTION_REGISTRY.cover, COVER_EXECUTION);
  assert.equal(node.registryVersions.cover, COVER_EXECUTOR_VERSION);
  const omitted = roundTrip(saveDelegationSnapshot(node, { omitResults: true }));
  assert.deepEqual(readDelegationSnapshot(omitted, COMPOUND_EXECUTION_REGISTRY), node);
  assert.deepEqual(delegationSnapshotResult(omitted, COMPOUND_EXECUTION_REGISTRY), flat);
  assert.throws(() => readDelegationSnapshot(omitted, { ...COMPOUND_EXECUTION_REGISTRY,
    cover: { ...COVER_EXECUTION, version: 'cover-next' } }), /cover/);
});
