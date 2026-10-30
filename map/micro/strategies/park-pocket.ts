import { rect } from '../../../shared/shape.ts';
import { compareCells } from '../../kernel/cell.ts';
import { capsule, elementShapes, findRegionRoute } from '../geometry.ts';
import { hunterClearance, portalStands } from '../portals.ts';
import { PARK_HEDGE_POCKET } from '../placeables/park-hedge-pocket.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import type { BuilderCanvas } from '../canvas.ts';
import type { RegionBrief } from '../types.ts';

/** Builder policy, not placeable demand: two clear cells outside one fixed pocket. */
export const PARK_POCKET_LIMITS = Object.freeze({ candidates: 2048, routes: 8, side: 14, apron: 2 });

/** One atomic pocket before scatter. No RNG, growth, or final-proof retry loop. */
export function siteParkPocket(brief: RegionBrief, canvas: BuilderCanvas) {
  const size = brief.cellSize, { side, apron } = PARK_POCKET_LIMITS;
  const built = expectPlaced(PARK_HEDGE_POCKET.build({}, size));
  let candidates = 0, routes = 0;
  // A zero hedge parameter still means no hedges; callers own that choice.
  for (const cell of [...canvas.fill.cells].sort(compareCells)) {
    if (candidates === PARK_POCKET_LIMITS.candidates) break;
    candidates++;
    const envelope = rect(cell.x * size, cell.y * size, (side + 2 * apron) * size, (side + 2 * apron) * size);
    // Empty pocket/apron intent may include a route; only the connected walls block it.
    if (!canvas.fill.contains(envelope)) continue;
    const x = cell.x + apron, y = cell.y + apron;
    const elements = placedElements(built, 'park-pocket', x, y, size);
    if (elements.flatMap(e => elementShapes(e)).some(shape => !canvas.fits(shape))) continue;
    const target = { x: (x + 3) * size, y: (y + 7) * size };
    const stands = portalStands(brief).flatMap(p => p.points);
    const root = stands.toSorted((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y))[0];
    // No external access witness in a portal-free brief: leave its existing grammar alone.
    if (!root) break;
    routes++;
    const radius = hunterClearance(size);
    const route = findRegionRoute(canvas.access, elements.flatMap(e => elementShapes(e)), root, target, radius);
    if (route) {
      const access = route.slice(1).flatMap((p, i) => capsule(route[i]!, p, radius));
      if (!canvas.commit({ elements, areas: [envelope], extents: [envelope], access }))
        throw new Error(`Park pocket ${brief.id} failed its canvas commit.`);
      return { envelope, candidates, routes };
    }
    if (routes === PARK_POCKET_LIMITS.routes) break;
  }
  return { envelope: null, candidates, routes };
}
