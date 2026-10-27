import test from 'node:test';
import assert from 'node:assert/strict';
import { regionExample } from '../map/micro/region-examples.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { validateBriefPartition } from '../map/micro/delegation.ts';
import { createAccessMask, elementShapes } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';

// Known defect #611: retain the geometric witness until a separately versioned
// planner correction replaces this characterization with a passing child check.
test('neck alley has an exact hunter-width barrier despite connected partition and passing parent', () => {
  const brief = regionExample({ type: 'block', shape: 'neck', width: 36, height: 30, seed: 1 });
  const plan = planBlock(brief), child = buildRegion(plan.alleys);
  assert.deepEqual(validateBriefPartition(brief, [...plan.lots, plan.alleys]), []);
  assert.equal(plan.lots.length, 5);
  assert.equal(plan.lots.reduce((n, lot) => n + lot.cells.length, 0), 508);
  assert.equal(child.elements.length, 0);
  const errors = validatePortalReach({ ...plan.alleys, blockers: [] }).errors;
  assert.equal(errors.length, 7);
  assert.ok(errors.includes('Portal hunter-east is unreachable from portal hunter-west.'));
  const parent = buildRegion(brief);
  assert.deepEqual(validatePortalReach({ ...brief, blockers: parent.elements.flatMap(e => elementShapes(e)) }).errors, []);

  // Continuous separating cut x=11.5 cells. Above y=19 the excluded lot
  // reaches x=11; below y=20 the excluded neck boundary begins at x=12.
  // No body can cross the line between those two corners: at its midpoint
  // the greatest possible clearance is sqrt(.5^2 + .5^2) cells.
  const access = createAccessMask(plan.alleys), size = brief.cellSize;
  for (let y = 0; y < 19; y++) for (let x = 3; x < 11; x++) assert.equal(access.has(x, y), false);
  for (let y = 20; y < 30; y++) for (let x = 12; x < 24; x++) assert.equal(access.has(x, y), false);
  assert.equal(access.bounds.y, 0);
  assert.equal(access.bounds.h, 30 * size);
  const stands = portalStands(plan.alleys);
  assert.ok(stands.find(s => s.portal.id === 'hunter-west').points.every(p => p.x < 11.5 * size));
  assert.ok(stands.find(s => s.portal.id === 'hunter-east').points.every(p => p.x > 11.5 * size));
  const maximumCutRadius = Math.SQRT1_2 * size;
  assert.ok(microMetrics({ cellSize: size, bodyProfile: 'cell' }).body.hunter > maximumCutRadius);
  assert.ok(hunterClearance(size) > maximumCutRadius);
});
