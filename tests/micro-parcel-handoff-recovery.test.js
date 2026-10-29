import test from 'node:test';
import assert from 'node:assert/strict';
import { createProspectiveParcels } from '../map/micro/prospective-parcels.ts';
import { executeDelegation, executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { saveDelegationSnapshot, readDelegationSnapshot } from '../map/micro/delegation-snapshot.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { createAccessMask, elementShapes, travelClear } from '../map/micro/geometry.ts';
import { hunterClearance } from '../map/micro/portals.ts';
import { builtRegion } from '../map/micro/result.ts';
import { rect } from '../shared/shape.ts';

const cells = (x, y, w, h) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
const input = () => {
  const owned = cells(0, 0, 14, 10);
  return { id: 'handoff', type: 'parent', seed: 646, cellSize: 40, cells: owned,
    zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 4, length: 2 }, { id: 'east', axis: 'v', x: 14, y: 4, length: 2 }] };
};
const must = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };

for (const transfer of [false, true]) test(`cumulative ${transfer ? 'whole-portal' : 'no-transfer'} handoffs execute once and recover exact interfaces`, () => {
  let childBuilds = 0;
  const registry = {
    parent: { version: 'handoff-fixture-1', build(brief, context) {
      const c = must(createProspectiveParcels(brief, { handoff: context, terminals: [{ x: 300, y: 300 }] })).coordinator;
      const claim = must(c.tryClaim([rect(240, 120, 80, 120)]));
      must(c.populate(claim.handle, { elements: [{ label: 'interior', x: 250, y: 130,
        template: { w: 60, h: 100, parts: [{ part: 'obstacle', kind: 'crate', shape: rect(0, 0, 60, 100) }] } }] }));
      must(c.settle(claim.handle, 'populated'));
      const policy = { externalPortals: transfer ? 'whole-child' : 'retained' };
      const a = { key: 'a', type: 'child', cells: transfer ? cells(0, 0, 3, 10) : cells(2, 0, 3, 6) };
      const b = { key: 'b', type: 'child', cells: cells(10, 7, 4, 3) };
      if (!transfer) {
        const squares = a.cells.map(p => rect(p.x * 40, p.y * 40, 40, 40));
        assert.ok(c.witness.paths.some(path => path.some((p, i) => i &&
          !travelClear(createAccessMask(brief), squares, path[i - 1], p, hunterClearance(40)))),
        'the useful peripheral hunk intersects the interior-first route');
      }
      must(c.acceptHandoff(must(c.probeHandoff([a], policy)).proposal));
      const final = must(c.probeHandoff([b], policy));
      must(c.acceptHandoff(final.proposal));
      assert.equal(childBuilds, 0, 'hypothetical plans never build children');
      const dispatched = must(c.executeHandoffs()).dispatch;
      assert.deepEqual(dispatched.prepared, final.proposal.prepared);
      assert.equal(childBuilds, 2);
      assert.equal(c.executeHandoffs().ok, false, 'only one execution batch');
      assert.deepEqual(context.brief, dispatched.prepared.retained);
      return builtRegion(context.brief, c.elements, []);
    } },
    child: { version: 'child-geometry-fixture-1', receiving: () => null, build(brief) {
      childBuilds++;
      const cell = brief.fillCells[0];
      assert.ok(cell, 'handoff leaves useful child fill');
      return builtRegion(brief, [{ label: 'child-content', x: cell.x * 40 + 16, y: cell.y * 40 + 16,
        template: { w: 8, h: 8, parts: [{ part: 'obstacle', kind: 'crate', shape: rect(0, 0, 8, 8) }] } }], []);
    } },
  };
  const node = executeDelegation(input(), registry);
  const leaves = executionLeaves(node);
  assert.deepEqual(validateBriefPartition(node.input, leaves.map(r => r.brief)), []);
  for (const leaf of leaves) {
    const blockers = leaf.elements.flatMap(e => elementShapes(e, true));
    assert.deepEqual(validateFillConstraints(leaf.brief, blockers), []);
    assert.equal(validatePortalReach({ ...leaf.brief, blockers }, { search: 'thorough' }).valid, true);
  }
  const flat = flattenDelegationResult(node);
  assert.equal(validatePortalReach({ ...flat.brief, blockers: flat.elements.flatMap(e => elementShapes(e, true)) }, { search: 'thorough' }).valid, true);
  assert.equal(node.children.some(c => c.input.portals.some(p => p.id === 'west')), transfer);
  const full = JSON.parse(JSON.stringify(saveDelegationSnapshot(node)));
  assert.deepEqual(readDelegationSnapshot(full), node);
  childBuilds = 0;
  const omitted = JSON.parse(JSON.stringify(saveDelegationSnapshot(node, { omitResults: true })));
  assert.deepEqual(readDelegationSnapshot(omitted, registry), node);
});
