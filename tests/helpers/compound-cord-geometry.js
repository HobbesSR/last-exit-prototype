import { rect } from '../../shared/shape.ts';
import { discoverCordWitness } from '../../map/micro/cord-witness.ts';
import { createProspectiveParcels } from '../../map/micro/prospective-parcels.ts';
import { createAccessMask, elementShapes, findRegionRoute, travelClear } from '../../map/micro/geometry.ts';
import { hunterClearance, portalStands } from '../../map/micro/portals.ts';

/** Recover actual outer gate approaches from the realized openings, independently of siting. */
export function compoundApproaches(node) {
  const trace = node.observerEvents?.find(t => t.label === 'compound');
  if (!trace) return null;
  const { origin, allocation, realization } = trace, size = node.input.cellSize;
  const cells = allocation.footprint;
  const w = Math.max(...cells.map(c => c.x)) + 1, h = Math.max(...cells.map(c => c.y)) + 1;
  const openings = realization.openings.filter(o => /^gate-[NESW]$/.test(o.connectionId));
  const steps = openings.flatMap(o => {
    const side = o.connectionId.slice(-1), along = (o.run.axis === 'h' ? o.run.x : o.run.y) + o.center - 1;
    return [...new Set([Math.floor(along), Math.ceil(along)])].map(t => ({
      x: origin.x / size + (side === 'W' ? -2 : side === 'E' ? w : t),
      y: origin.y / size + (side === 'N' ? -2 : side === 'S' ? h : t), gate: o.connectionId,
    }));
  });
  return { box: rect(origin.x, origin.y, w * size, h * size), steps,
    fixedAccess: steps.map(p => rect(p.x * size, p.y * size, size * 2, size * 2)),
    terminals: steps.map(p => ({ x: (p.x + 1) * size, y: (p.y + 1) * size })) };
}

/** Initial witness pessimistically blocks the whole ring box, including the court. */
export function compoundCordEvidence(node, whole) {
  const approach = compoundApproaches(node);
  if (!approach) return null;
  const { box, fixedAccess, terminals, steps } = approach;
  if (!steps.length) throw Error('Realized compound has no outer gate openings');
  // External parent/child/whole promises are checked separately in thorough mode.
  // Prove each actual gate against final combined geometry from its nearest
  // original portal stand (31); avoid exhausting a global cord graph's segment
  // cap merely to verify two gate terminals in a many-portal production yard.
  const blockers = whole.elements.flatMap(e => elementShapes(e));
  const retainedMask = createAccessMask(node.retained.brief), clearance = hunterClearance(node.input.cellSize);
  const entries = portalStands(node.input);
  const finalPaths = [];
  let finalFailure;
  for (const terminal of terminals) {
    const candidates = entries.flatMap(entry => entry.points.map(point => ({ point, portal: entry.portal })))
      .sort((a, b) => Math.hypot(a.point.x - terminal.x, a.point.y - terminal.y)
        - Math.hypot(b.point.x - terminal.x, b.point.y - terminal.y));
    const nearest = candidates[0];
    const path = findRegionRoute(retainedMask, blockers, nearest?.point ?? terminals[0], terminal, clearance);
    if (path) { finalPaths.push(path); continue; }
    const fallback = discoverCordWitness({ ...node.retained.brief, portals: nearest ? [nearest.portal] : [] }, blockers, [terminals[0], terminal]);
    if (fallback.ok) finalPaths.push(...fallback.witness.paths);
    else { finalFailure = fallback.reason; break; }
  }
  const final = { ok: !finalFailure };
  const initial = createProspectiveParcels(node.input, { fixedAccess, terminals });
  let initialFailure, paths = [], displaced = null;
  if (!initial.ok) initialFailure = `initial: ${initial.reason}`;
  else {
    const claim = initial.coordinator.tryClaim([box]);
    if (!claim.ok) initialFailure = `ring box: ${claim.reason}`;
    else {
      paths = initial.coordinator.witness.paths;
      const mask = createAccessMask(node.input), radius = hunterClearance(node.input.cellSize);
      displaced = (node.offers ?? []).filter(o => {
        const squares = o.cells.map(c => rect(c.x * node.input.cellSize, c.y * node.input.cellSize, node.input.cellSize, node.input.cellSize));
        return paths.some(path => path.some((p, i) => i > 0 && !travelClear(mask, squares, path[i - 1], p, radius)));
      }).map(o => o.key);
    }
  }
  return { steps, terminals, initialReady: !initialFailure, ...(initialFailure ? { initialFailure } : {}),
    initialPaths: paths, displaced, finalAccess: final.ok,
    finalSearch: 'nearest-stand-grid-with-mesh-fallback',
    ...(final.ok ? { finalPaths } : { failure: finalFailure }) };
}
