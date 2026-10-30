/** Opt-in #694 geometry only; never registered as a production builder. */
import { rect } from '../../shared/shape.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../../map/micro/geometry.ts';
import { validateFillConstraints } from '../../map/micro/margins.ts';
import { validatePortalReach, portalStands, hunterClearance } from '../../map/micro/portals.ts';

export const PATTERN = { width: 14, height: 14, thickness: 1, mouth: 2.5, minOwnerCells: 900, maxCandidates: 2048, maxPerOwner: 256 };

/** One connected five-part bottle wall, east mouth; all dimensions in cells. */
export function bottleElement(x, y, size) {
  const w = 14 * size, h = 14 * size, t = size, lip = (h - 2.5 * size) / 2;
  return { label: 'experiment-static-bottle', x, y, template: { w, h, parts: [
    rect(0, 0, w, t), rect(0, h - t, w, t), rect(0, t, t, h - 2 * t),
    rect(w - t, t, t, lip - t), rect(w - t, h - lip, t, lip - t),
  ].map(shape => ({ part: 'obstacle', kind: 'building', shape })) } };
}

/** Deterministic bounded siting; no speculative route/proof loop or growth. */
export function placeBottle(map) {
  let candidates = 0; const refusals = { envelope: 0, existingGeometry: 0, target: 0 };
  // Large real owners, park first then saved order. No replacement of existing content.
  const indices = map.results.map((_, i) => i).sort((a, b) => Number(map.results[b].brief.type === 'park') - Number(map.results[a].brief.type === 'park') || a - b);
  for (const index of indices) {
    const region = map.results[index], b = region.brief, s = b.cellSize;
    if (!['park', 'plant', 'hall', 'ruins'].includes(b.type) || b.cells.length < PATTERN.minOwnerCells) continue;
    const fill = createFillMask(b), owned = createRegionMask(b);
    const blockers = region.elements.flatMap(e => elementShapes(e, true));
    for (const box of fill.rectangles(14, 14).slice(0, PATTERN.maxPerOwner)) {
      if (++candidates > PATTERN.maxCandidates) return { ok: false, reason: 'candidate-budget', candidates: candidates - 1, refusals };
      const envelope = rect(box.x - 2 * s, box.y - 2 * s, 18 * s, 18 * s);
      if (!owned.contains(envelope)) { refusals.envelope++; continue; }
      if (blockers.some(shape => shapesOverlap(envelope, shape))) { refusals.existingGeometry++; continue; }
      const element = bottleElement(box.x, box.y, s), walls = elementShapes(element);
      // Core sites must remain intact. Loot candidates remain exact too, but collisions
      // are reported as experimental failures: never silently move/re-roll targets.
      if (region.coreElements.some(p => walls.some(w => shapesOverlap(w, rect(p.x - s, p.y - s, 2 * s, 2 * s))))) { refusals.target++; continue; }
      return { ok: true, index, owner: b.id, candidates, refusals, element, bounds: box };
    }
  }
  return { ok: false, reason: 'no-supported-clear-envelope', candidates, refusals };
}

/** Independent final proof, not an admission loop. Full-radius SDK hunter. */
export function validateBottle(region, element) {
  const brief = region.brief, blockers = [...region.elements, element].flatMap(e => elementShapes(e));
  const fillErrors = validateFillConstraints(brief, elementShapes(element, true));
  const reach = validatePortalReach({ ...brief, blockers }, { search: 'thorough' });
  const s = brief.cellSize, target = { x: element.x + 3 * s, y: element.y + 7 * s };
  const stands = portalStands(brief).flatMap(p => p.points);
  const nearest = stands.toSorted((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y))[0];
  const pocketRoute = nearest ? findRegionRoute(createAccessMask(brief), blockers, nearest, target, hunterClearance(s)) : null;
  return { fillErrors, valid: !fillErrors.length && reach.valid && !!pocketRoute,
    portalErrors: reach.errors, joins: reach.joins, meshBuilds: reach.meshBuilds, pocketRoute };
}

export function targetPairs(element, size, origin) {
  const point = (x, y) => ({ x: element.x + x * size + origin.x, y: element.y + y * size + origin.y });
  return [4, 7, 10].flatMap(y => [3, 7, 11].map(x => ({ category: 'barrier-target', from: point(-2, y), to: point(x, y) })))
    .concat([4, 7, 10].map(y => ({ category: 'barrier-crossing', from: point(-2, y), to: point(16, y) })))
    .concat([4, 7, 10].map(y => ({ category: 'mouth-control', from: point(16, 7), to: point(7, y) })));
}
