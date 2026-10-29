import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY } from '../map/micro/strategies/compound.ts';
import { executeDelegation, executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { compoundCordEvidence } from './helpers/compound-cord-geometry.js';
import { cellsOf } from './helpers/cells.js';

const input = () => {
  const cells = cellsOf(40, 34, (x, y) => y < 20 || x < 20);
  return { id: 'compound-concave', seed: 1, type: 'compound', cellSize: 40, cells,
    zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals: [
      { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
      { id: 'east', axis: 'v', x: 40, y: 8, length: 2 }] };
};
const roundTrip = x => JSON.parse(JSON.stringify(x));

test('compound moves a yard cord while preserving ring, actual gate access and all owner routes', () => {
  const original = input(); let diagnostics;
  const node = buildCompoundGeneration(original, { observeYard: d => diagnostics = d });
  const whole = flattenDelegationResult(node), evidence = compoundCordEvidence(node, whole);
  assert.ok(evidence.displaced.length, 'an accepted boundary rectangle crosses the original route');
  assert.ok(evidence.displaced.some(key => node.offers.find(o => o.key === key).cells.some(c => c.x === 0 || c.y === 0 || c.x === 39 || c.y === 33)));
  assert.equal(evidence.finalAccess, true);
  assert.ok(evidence.terminals.length >= 2);
  assert.equal(diagnostics.outcome, 'delegated');
  assert.ok(diagnostics.accepted && diagnostics.probed <= 48);
  assert.ok(diagnostics.eligibleOffers.some(o => o.cells.every(c => c.x > 0 && c.y > 0 && c.x < 39 && c.y < 33)), 'explicit interior offers are considered');
  assert.ok(node.offers.some(o => o.cells.every(c => c.x > 0 && c.y > 0 && c.x < 39 && c.y < 33)),
    'an interior yard patch is actually relinquished alongside peripheral patches');
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  const blockers = whole.elements.flatMap(e => elementShapes(e));
  for (const owner of [...executionLeaves(node), whole]) {
    assert.deepEqual(validateFillConstraints(owner.brief, owner.elements.flatMap(e => elementShapes(e, true))), []);
    assert.deepEqual(validatePortalReach({ ...owner.brief, blockers }, { search: 'thorough' }).errors, []);
  }
  const reversed = structuredClone(original); reversed.cells.reverse(); reversed.portals.reverse(); reversed.zones[0].cells.reverse();
  assert.deepEqual(buildCompoundGeneration(reversed), node);
  for (const omitResults of [false, true])
    assert.deepEqual(readDelegationSnapshot(roundTrip(saveDelegationSnapshot(node, { omitResults })), COMPOUND_EXECUTION_REGISTRY), node);
});

test('compound yard observations are detached and terminal empty is explicit', () => {
  const original = input();
  const expected = buildCompoundGeneration(original);
  const observed = buildCompoundGeneration(original, { observeYard(d) {
    d.eligibleOffers.length = 0;
    d.probes.length = 0;
    d.refusals.changed = 999;
  } });
  assert.deepEqual(observed, expected);
  let diagnostics;
  const empty = buildCompoundGeneration({ ...original, fillCells: [] }, { observeYard: d => diagnostics = d });
  assert.equal(empty.actualBuilder, 'empty');
  assert.equal(diagnostics.outcome, 'no-space');
});

test('refused receiving leaves original ownership and recovers against the owning versions', () => {
  let probes = 0;
  const registry = { ...COMPOUND_EXECUTION_REGISTRY, cover: { ...COMPOUND_EXECUTION_REGISTRY.cover,
    receiving() { probes++; return 'fixture refuses cover'; }, build() { throw Error('refused child dispatched'); } } };
  const node = executeDelegation(input(), registry);
  assert.ok(probes > 0);
  assert.equal(node.children?.length ?? 0, 0);
  assert.deepEqual(node.retained.brief, node.input);
  assert.ok(node.retained.elements.length > 1);
  assert.equal(compoundCordEvidence(node, flattenDelegationResult(node)).finalAccess, true);
  for (const omitResults of [false, true]) {
    const snapshot = roundTrip(saveDelegationSnapshot(node, { omitResults }));
    assert.deepEqual(readDelegationSnapshot(snapshot, registry), node);
    if (omitResults) assert.throws(() => readDelegationSnapshot(snapshot, { ...registry,
      cover: { ...registry.cover, version: 'changed' } }), /cover/);
  }
});

test('a verified compound partition that cannot be reproduced throws before dispatch', () => {
  let dispatched = 0;
  const original = COMPOUND_EXECUTION_REGISTRY.compound;
  const registry = { ...COMPOUND_EXECUTION_REGISTRY, compound: { ...original, build(brief, context, observe) {
    const seen = new Set();
    return original.build(brief, { get brief() { return context.brief; }, empty: context.empty,
      delegate(...args) { dispatched++; return context.delegate(...args); },
      prepareDelegation(offers, policy) {
        const prepared = context.prepareDelegation(offers, policy), key = JSON.stringify(offers.map(o => o.key));
        if (seen.has(key)) return { ...prepared, rejected: [{ key: 'fixture', reason: 'non-deterministic preparation' }] };
        seen.add(key); return prepared;
      } }, observe);
  } } };
  assert.throws(() => executeDelegation(input(), registry), /Verified compound handoff could not execute/);
  assert.equal(dispatched, 0);
});
