import { rect } from '../../shared/shape.ts';
import { discoverCordWitness } from '../../map/micro/cord-witness.ts';
import { createProspectiveParcels } from '../../map/micro/prospective-parcels.ts';
import { createAccessMask, elementShapes, travelClear } from '../../map/micro/geometry.ts';
import { hunterClearance } from '../../map/micro/portals.ts';

/** Recover actual outside door approaches from the realized building, not candidate policy. */
export function hutApproaches(node) {
  const house = node.retained.elements.find(e => e.label === 'hut-building');
  const trace = node.observerEvents?.find(t => t.label === 'hut-building');
  if (!house || !trace) return null;
  const door = trace.realization.openings.find(o => o.connectionId === 'door');
  const size = node.input.cellSize, { run, center } = door;
  const start = (run.axis === 'h' ? run.x : run.y) + center - 1;
  const offsets = [...new Set([Math.floor(start), Math.ceil(start)])];
  const steps = offsets.map(t => run.axis === 'h'
    ? { x: house.x / size + t, y: house.y / size + (run.y === 0 ? -2 : house.template.h / size) }
    : { x: house.x / size + (run.x === 0 ? -2 : house.template.w / size), y: house.y / size + t });
  return { house, fixedAccess: steps.map(p => rect(p.x * size, p.y * size, size * 2, size * 2)),
    terminals: steps.map(p => ({ x: (p.x + 1) * size, y: (p.y + 1) * size })) };
}

/** Independently reproduce the pre-handoff envelope witness and test its displacement. */
export function hutCordEvidence(node, whole) {
  const approach = hutApproaches(node);
  if (!approach) return null;
  const { house, fixedAccess, terminals } = approach;
  const initial = createProspectiveParcels(node.input, { fixedAccess, terminals });
  if (!initial.ok) throw Error(`Initial hut witness failed: ${initial.reason}`);
  const claim = initial.coordinator.tryClaim([rect(house.x, house.y, house.template.w, house.template.h)]);
  if (!claim.ok) throw Error(`Initial hut envelope failed: ${claim.reason}`);
  const paths = initial.coordinator.witness.paths, mask = createAccessMask(node.input), radius = hunterClearance(node.input.cellSize);
  const displaced = (node.offers ?? []).filter(o => {
    const squares = o.cells.map(c => rect(c.x * node.input.cellSize, c.y * node.input.cellSize, node.input.cellSize, node.input.cellSize));
    return paths.some(path => path.some((p, i) => i > 0 && !travelClear(mask, squares, path[i - 1], p, radius)));
  }).map(o => o.key);
  const final = discoverCordWitness(node.retained.brief, whole.elements.flatMap(e => elementShapes(e)), terminals);
  return { terminals, initialPaths: paths, displaced, finalAccess: final.ok,
    ...(final.ok ? { finalPaths: final.witness.paths } : { failure: final.reason }) };
}
