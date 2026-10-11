import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDelegation, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';
import { measurement } from '../map/macro/src/chain/measurement.ts';
import { liveMapFromBuilt } from '../map/live.ts';

const cells = (x, w) => Array.from({ length: w * 6 }, (_, i) => ({ x: x + i % w, y: Math.floor(i / w) }));
const input = () => ({ id: 'snapshot', seed: 718, type: 'parent', cellSize: 40, cells: cells(0, 18),
  zones: [{ tier: 2, bonus: 1, lootChance: 0, cells: cells(0, 18) }],
  portals: [{ id: 'entrance', axis: 'h', x: 6, y: 0, length: 2 }], coreElements: { charger: 1 }, guidance: { route: 'yard' } });
const result = brief => ({ version: 'region-2', brief, elements: [{ label: 'kept', x: 0, y: 0, template: { w: 1, h: 1, parts: [] } }],
  coreElements: [], loot: [], manifest: { cells: brief.cells.length, structures: 0, obstacles: 0, gates: 0, loot: 0, coreElements: 0 } });
function registry(counter = { calls: 0 }, reverse = false, replace = false) {
  return {
    parent: { version: 'parent-1', build(_brief, context) {
      counter.calls++;
      const offers = [{ key: 'yard', type: 'child', cells: cells(12, 6), reasonTags: ['unused', 'yard'], guidance: { style: 'dry' } },
        { key: 'unfit', type: 'refused', cells: cells(0, 2), reasonTags: ['narrow'] }];
      context.delegate(reverse ? offers.reverse().map(o => ({ ...o, cells: o.cells.reverse() })) : offers);
      if (replace) context.empty('incompatible-core');
      return result(context.brief);
    } },
    child: { version: 'child-1', build(_brief, context) {
      counter.calls++;
      context.delegate([{ key: 'inner', type: 'leaf', cells: cells(16, 2), reasonTags: ['extra'], guidance: { weather: 'sun' } }]);
      return result(context.brief);
    } },
    leaf: { version: 'leaf-1', build(brief) { counter.calls++; return result(brief); } },
    refused: { version: 'refused-1', receiving: () => 'needs more space', build() { throw new Error('must never run'); } },
  };
}
const roundTrip = value => JSON.parse(JSON.stringify(value));

test('JSON snapshot derives interfaces and flat output without consulting any registry', () => {
  const counter = { calls: 0 }, node = executeDelegation(input(), registry(counter));
  const saved = roundTrip(saveDelegationSnapshot(node));
  assert.equal(Object.hasOwn(saved.generation, 'preparation'), false, 'interface views are derived');
  const poison = new Proxy({}, { get() { throw new Error('today registry was used'); } });
  const recovered = readDelegationSnapshot(saved, poison);
  assert.deepEqual(recovered, node);
  assert.deepEqual(delegationSnapshotResult(saved), flattenDelegationResult(node));
  assert.equal(counter.calls, 3);
  assert.deepEqual(recovered.preparation.rejected, [{ key: 'unfit', reason: 'Receiving builder for unfit: needs more space' }]);
  const child = recovered.children[0];
  assert.deepEqual(child.input.guidance, { style: 'dry' });
  assert.deepEqual(child.input.delegation.reasonTags, ['unused', 'yard']);
  assert.equal(child.input.id, node.children[0].input.id);
  assert.equal(child.input.seed, node.children[0].input.seed);
  assert.deepEqual(child.preparation.crossings, node.children[0].preparation.crossings);
  assert.deepEqual(recovered.registryVersions, { parent: 'parent-1', child: 'child-1', refused: 'refused-1', leaf: 'leaf-1' });
});

test('omitted results regenerate only matching versions and preserve authored decisions', () => {
  const node = executeDelegation(input(), registry()), saved = roundTrip(saveDelegationSnapshot(node, { omitResults: true }));
  assert.deepEqual(readDelegationSnapshot(saved, registry()), node);
  assert.throws(() => readDelegationSnapshot(saved), /recorded builder registry/);
  for (const name of ['parent', 'child', 'leaf', 'refused']) {
    const changed = registry(); changed[name].version = 'changed';
    assert.throws(() => readDelegationSnapshot(saved, changed), new RegExp(`builder ${name} version`));
  }
  const algorithm = roundTrip(saved); algorithm.algorithmVersion = 'future';
  assert.throws(() => readDelegationSnapshot(algorithm, registry()), /algorithm version future/);
  const changedDecisions = roundTrip(saved); changedDecisions.generation.decisions.rejected[0].reason = 'invented';
  assert.throws(() => readDelegationSnapshot(changedDecisions, registry()), /decisions differ/);
  const partial = roundTrip(saveDelegationSnapshot(node)); delete partial.generation.children[0].retained;
  assert.deepEqual(readDelegationSnapshot(partial, registry()), node);
  partial.generation.retained.elements[0].label = 'corrupt-kept-result';
  assert.throws(() => readDelegationSnapshot(partial, registry()), /Regenerated result differs/);
});

test('whole fallback retains abandoned decision history while deriving only terminal output', () => {
  const node = executeDelegation(input(), registry(undefined, false, true));
  const recovered = readDelegationSnapshot(roundTrip(saveDelegationSnapshot(node)));
  assert.equal(recovered.fallbackReason, 'incompatible-core');
  assert.deepEqual(recovered.preparation, node.preparation);
  assert.equal(recovered.children.length, 1);
  const flat = delegationSnapshotResult(saveDelegationSnapshot(node));
  assert.deepEqual(flat.elements, []);
  assert.deepEqual(flat.brief.coreElements, { charger: 1 });
  assert.deepEqual(readDelegationSnapshot(saveDelegationSnapshot(node, { omitResults: true }), registry(undefined, false, true)), node);
});

test('reordered equivalent cells, zones and requests produce identical saved generation objects', () => {
  const reversed = input(); reversed.cells.reverse(); reversed.zones[0].cells.reverse();
  assert.deepEqual(saveDelegationSnapshot(executeDelegation(reversed, registry(undefined, true))),
    saveDelegationSnapshot(executeDelegation(input(), registry())));
});

test('saved ownership and provenance corruption are refused without generation', () => {
  const original = saveDelegationSnapshot(executeDelegation(input(), registry()));
  for (const corrupt of [
    saved => { saved.generation.children[0].depth = 0; },
    saved => { saved.generation.children[0].input.seed++; },
    saved => { saved.generation.retained.brief.coreElements = {}; },
    saved => { saved.generation.decisions.acceptedKeys = ['unknown']; },
    saved => { saved.generation.requestedBuilder = 'other'; },
    saved => { saved.version = 'future'; },
  ]) {
    const saved = roundTrip(original); corrupt(saved);
    assert.throws(() => readDelegationSnapshot(saved));
  }
  const invalidJSON = roundTrip(original); invalidJSON.generation.input.seed = Infinity;
  assert.throws(() => readDelegationSnapshot(invalidJSON), /finite JSON/);
});

test('explicit undefined optional fields are rejected instead of disappearing in JSON', () => {
  const node = executeDelegation(input(), registry());
  node.retained.elements[0].rotation = undefined;
  assert.throws(() => saveDelegationSnapshot(node), /finite JSON/);

  const saved = saveDelegationSnapshot(executeDelegation(input(), registry()));
  saved.generation.retained.elements[0].rotation = undefined;
  assert.throws(() => readDelegationSnapshot(saved), /finite JSON/);
});

test('terminal core fallback remains visible to the existing report and live admission', () => {
  const requested = input(); requested.coreElements = { spawn: 1, charger: 1 };
  const node = executeDelegation(requested, { parent: { version: 'core-1', build(_brief, context) { context.empty('incompatible-footprint'); } } });
  const region = delegationSnapshotResult(roundTrip(saveDelegationSnapshot(node)));
  const built = { cellSize: requested.cellSize, regions: [region], pairs: [] };
  const report = measurement(built, { components: [[requested.id]] }, { setPieces: [] }, { setPieceClasses: [] });
  assert.equal(report.defects.filter(d => d.kind === 'broken-promise').length, 2);
  assert.ok(report.defects.some(d => d.message.includes('sited 0 spawn')));
  assert.throws(() => liveMapFromBuilt(718, built), /needs .* spawns/);
  assert.deepEqual(region.brief.coreElements, requested.coreElements);
});

test('complete empty offers and depth fallback round-trip with unchanged requested provenance', () => {
  const whole = executeDelegation(input(), { parent: { version: 'full-1', build(brief, context) {
    context.delegate([{ key: 'everything', cells: brief.cells, type: 'empty', reasonTags: ['cannot-build'] }]);
  } } });
  assert.deepEqual(readDelegationSnapshot(roundTrip(saveDelegationSnapshot(whole))), whole);
  for (const corrupt of [
    saved => { saved.generation.offers[0].type = 'child'; },
    saved => { saved.generation.offers[0].cells = saved.generation.offers[0].cells.slice(0, 2); },
    saved => { saved.generation.retained.manifest.structures = 9; },
    saved => { saved.generation.builderVersion = 'different-empty'; },
  ]) {
    const saved = roundTrip(saveDelegationSnapshot(whole)); corrupt(saved);
    assert.throws(() => readDelegationSnapshot(saved));
  }
  const bounded = executeDelegation(input(), registry(), { maxDepth: 0 });
  const saved = roundTrip(saveDelegationSnapshot(bounded));
  assert.deepEqual(readDelegationSnapshot(saved), bounded);
  assert.deepEqual(readDelegationSnapshot(saveDelegationSnapshot(bounded, { omitResults: true }), registry()), bounded);
  assert.equal(bounded.children.find(c => c.input.type === 'child').actualBuilder, 'empty');
  const wrongLimit = roundTrip(saved); wrongLimit.generation.maxDepth = 2;
  assert.throws(() => readDelegationSnapshot(wrongLimit), /depth fallback/);
  const unboundedContent = saveDelegationSnapshot(executeDelegation(input(), registry()));
  unboundedContent.generation.maxDepth = 0;
  assert.throws(() => readDelegationSnapshot(unboundedContent), /exceeds maximum/);
});

test('builder-authored reason strings cannot collide with semantic stopping conditions', () => {
  for (const reason of ['complete-region', 'depth-limit', 'explicit-empty']) {
    const node = executeDelegation(input(), { parent: { version: 'reasons-1', build(_brief, context) { context.empty(reason); } } });
    assert.equal(node.fallbackKind, 'builder-empty');
    assert.equal(node.fallbackReason, reason);
    assert.deepEqual(readDelegationSnapshot(roundTrip(saveDelegationSnapshot(node))), node);
  }
});

test('nested local portal promises recover when a grandchild touches an ancestor neighbor', () => {
  const builders = registry();
  builders.child.build = (_brief, context) => {
    // The original child-to-parent crossing is in the middle of this seam.
    // This corner connects through its retained child, rather than a new
    // direct crossing to the ancestor's retained ground on its west side.
    const corner = [{ x: 12, y: 0 }, { x: 13, y: 0 }, { x: 12, y: 1 }, { x: 13, y: 1 }];
    context.delegate([{ key: 'corner', type: 'empty', cells: corner }]);
    return result(context.brief);
  };
  const node = executeDelegation(input(), builders);
  assert.equal(node.children[0].preparation.children.length, 1);
  const saved = roundTrip(saveDelegationSnapshot(node));
  assert.deepEqual(readDelegationSnapshot(saved), node);
  assert.deepEqual(delegationSnapshotResult(saved), flattenDelegationResult(node));
});
