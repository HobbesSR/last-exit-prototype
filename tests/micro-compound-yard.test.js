import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildCompoundGeneration } from '../map/micro/strategies/compound.ts';
import { executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { compoundApproaches, compoundCordEvidence } from './helpers/compound-cord-geometry.js';

test('production review yard transfers useful ownership while retaining ring and gate access', () => {
  const original = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/compound-647-review-brief.json.gz', import.meta.url))));
  let diagnostics;
  const node = buildCompoundGeneration(original, { observeYard: value => diagnostics = value });
  const whole = flattenDelegationResult(node), approach = compoundApproaches(node);
  assert.equal(node.actualBuilder, 'compound');
  assert.equal(diagnostics.outcome, 'delegated');
  assert.ok(diagnostics.eligibleOffers.length <= 48);
  const retained = new Set(node.retained.brief.cells.map(c => `${c.x},${c.y}`));
  assert.ok(node.input.cells.filter(c => !retained.has(`${c.x},${c.y}`)).length >= 180, 'at least 180 cells actually transferred');
  const size = original.cellSize, box = approach.box;
  for (let y = box.y / size; y < (box.y + box.h) / size; y++)
    for (let x = box.x / size; x < (box.x + box.w) / size; x++)
      assert.ok(retained.has(`${x},${y}`), `ring and court cell ${x},${y} retained`);
  assert.ok(approach.terminals.length >= 2);
  assert.equal(compoundCordEvidence(node, whole).finalAccess, true, 'actual gate approaches remain reachable');
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  const blockers = whole.elements.flatMap(e => elementShapes(e));
  for (const owner of [...executionLeaves(node), whole]) {
    assert.deepEqual(validateFillConstraints(owner.brief, owner.elements.flatMap(e => elementShapes(e, true))), []);
    assert.deepEqual(validatePortalReach({ ...owner.brief, blockers }, { search: 'thorough' }).errors, [], owner.brief.id);
  }
});
