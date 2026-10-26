import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDelegationPartition, executeDelegation, flattenDelegationPartition } from '../map/micro/delegation-execute.ts';
import { canonicalDelegationBrief, validateBriefPartition } from '../map/micro/delegation.ts';
import { saveDelegationSnapshot, readDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';

const cells = (x, width) => Array.from({ length: width * 6 }, (_, i) => ({ x: x + i % width, y: Math.floor(i / width) }));
const brief = (id, owned, extra = {}) => ({ id, seed: 91, type: 'owner', cellSize: 40,
  cells: owned, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned }], portals: [], ...extra });
const trace = label => ({ label, origin: { x: 0, y: 0 }, cellSize: 40, design: {}, allocation: {}, realization: {} });
const built = input => ({ version: 'region-2', brief: input,
  elements: [{ label: 'piece', x: 0, y: 0, template: { parts: [] } }],
  coreElements: [], loot: [{ x: 0, y: 0, tier: 1 }],
  manifest: { cells: input.cells.length, structures: 1, obstacles: 2, gates: 3,
    loot: 999, coreElements: 999, attempted: 4, rejected: 5, privateMetric: 88 } });

test('initial partition preserves planner order and interfaces, gathers nested labels and keeps recoverable roots', () => {
  const input = brief('region', cells(0, 24));
  const crossing = { id: 'initial-crossing', axis: 'v', x: 12, y: 2, length: 2 };
  const partition = [brief('region/right', cells(12, 12), { seed: 33, portals: [crossing] }),
    brief('region/left', cells(0, 12), { seed: 44, portals: [crossing] })];
  assert.deepEqual(validateBriefPartition(input, partition), []);
  const before = structuredClone(partition), observed = [];
  const registry = {
    owner: { version: 'owner-1', receiving() { throw Error('initial owners must bypass receiving'); },
      build(input, context, observe) {
        const edge = Math.max(...input.cells.map(c => c.x)) - 3;
        context.delegate([{ key: 'edge', type: 'patch',
          cells: input.cells.filter(c => input.id.endsWith('/left') ? c.x < 4 : c.x >= edge) }]);
        observe(trace('piece'));
        return built(context.brief);
      } },
    patch: { version: 'patch-1', build(input, _context, observe) { observe(trace('piece')); return built(input); } },
  };
  const execution = dispatchDelegationPartition(input, partition, registry, { observe: event => observed.push(event.label) });
  assert.deepEqual(partition, before);
  assert.deepEqual(execution.input, canonicalDelegationBrief(input));
  assert.deepEqual(execution.children.map(child => child.input), partition.map(canonicalDelegationBrief));
  assert.deepEqual(execution.children.map(child => child.depth), [0, 0]);
  for (const child of execution.children) {
    assert.equal(child.children[0].depth, 1);
    assert.deepEqual(child, executeDelegation(child.input, registry));
    const snapshot = saveDelegationSnapshot(child, { omitResults: true });
    assert.deepEqual(readDelegationSnapshot(snapshot, registry), child);
    assert.deepEqual(delegationSnapshotResult(saveDelegationSnapshot(child)).brief, child.input);
  }
  const flat = flattenDelegationPartition(execution);
  const labels = execution.children.flatMap(child => [`${child.input.id}/piece`, `${child.children[0].input.id}/piece`]);
  assert.deepEqual(flat.elements.map(element => element.label), labels);
  assert.deepEqual(observed, labels);
  assert.deepEqual(flat.brief, execution.input);
  assert.deepEqual(flat.manifest, { cells: 144, structures: 4, obstacles: 8, gates: 12,
    loot: 4, coreElements: 0, attempted: 16, rejected: 20 });
});

test('full initial content owner starts at depth zero while further patches obey the bound', () => {
  const input = brief('region', cells(0, 12));
  const owner = { ...input, id: 'region/only', seed: 23 };
  assert.deepEqual(validateBriefPartition(input, [owner]), []);
  const registry = { owner: { version: 'owner-1', build(input, context) {
    context.delegate([{ key: 'edge', type: 'unregistered-at-limit', cells: cells(8, 4) }]);
    return built(context.brief);
  } } };
  const execution = dispatchDelegationPartition(input, [owner], registry, { maxDepth: 0 });
  const root = execution.children[0];
  assert.equal(root.actualBuilder, 'owner');
  assert.equal(root.depth, 0);
  assert.deepEqual(root.registryVersions, { owner: 'owner-1' });
  assert.equal(root.children[0].fallbackKind, 'depth-limit');
  assert.equal(root.children[0].depth, 1);
  assert.equal(flattenDelegationPartition(execution).elements.length, 1);
});
