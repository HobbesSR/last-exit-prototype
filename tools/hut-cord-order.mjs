import assert from 'node:assert/strict';
import { rect } from '../shared/shape.ts';
import { createProspectiveParcels } from '../map/micro/prospective-parcels.ts';
import { executeDelegation, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { previewedCoverExecution } from '../map/micro/strategies/cover.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { builtRegion } from '../map/micro/result.ts';
import { hutApproaches } from '../tests/helpers/hut-cord-geometry.js';

/** Replay the observed candidates in each order, without changing the production builder. */
export function compareHutOrder(node, eligibleOffers) {
  const approach = hutApproaches(node);
  if (!approach) throw Error('Order comparison needs a sited hut and its observer trace.');
  const { house, fixedAccess, terminals } = approach;
  const run = offers => {
    const replay = executeDelegation(node.input, {
      hut: { version: 'hut-order-experiment', build(brief, context) {
        const created = createProspectiveParcels(brief, { handoff: context, fixedAccess, terminals });
        if (!created.ok) throw Error(`Order experiment initialization: ${created.reason}`);
        const coordinator = created.coordinator;
        const claim = coordinator.tryClaim([rect(house.x, house.y, house.template.w, house.template.h)]);
        if (!claim.ok) throw Error(`Order experiment claim: ${claim.reason}`);
        const populated = coordinator.populate(claim.handle, { elements: [house] });
        if (!populated.ok) throw Error(`Order experiment population: ${populated.reason}`);
        const settled = coordinator.settle(claim.handle, 'populated');
        if (!settled.ok) throw Error(`Order experiment settlement: ${settled.reason}`);
        const transferred = new Set();
        let accepted = false;
        for (const offer of offers) {
          if (offer.cells.some(c => transferred.has(`${c.x},${c.y}`))) continue;
          const proposal = coordinator.probeHandoff([offer], { externalPortals: 'retained' });
          if (proposal.ok && coordinator.acceptHandoff(proposal.proposal).ok) {
            accepted = true;
            for (const c of offer.cells) transferred.add(`${c.x},${c.y}`);
          }
        }
        if (accepted && !coordinator.executeHandoffs().ok) throw Error('Order experiment dispatch failed.');
        return builtRegion(context.brief, coordinator.elements, []);
      } },
      cover: previewedCoverExecution(),
    }, { maxDepth: node.maxDepth });
    const flat = flattenDelegationResult(replay);
    const errors = validatePortalReach({ ...node.input, blockers: flat.elements.flatMap(e => elementShapes(e)) }, { search: 'thorough' }).errors;
    return { acceptedKeys: (replay.offers ?? []).map(o => o.key).sort(),
      acceptedCells: (replay.offers ?? []).reduce((sum, offer) => sum + offer.cells.length, 0), errors };
  };
  const forward = run(eligibleOffers), reverse = run([...eligibleOffers].reverse());
  assert.deepEqual(forward.acceptedKeys, (node.offers ?? []).map(o => o.key).sort(),
    'Forward order must reproduce production accepted offers.');
  return { forward, reverse };
}
