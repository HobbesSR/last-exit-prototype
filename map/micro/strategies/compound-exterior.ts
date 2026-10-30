import { rect } from '../../../shared/shape.ts';
import { createAccessMask, createFillMask } from '../geometry.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { draw } from '../random.ts';
import { HOUSE } from '../placeables/house.ts';
import { placedElements } from '../placeables/placeable.ts';
import type { BuildingObserver } from '../building/trace.ts';
import type { Side } from '../port-terms.ts';
import type { RegionBrief, RegionElement } from '../types.ts';

interface Box { x: number; y: number; w: number; h: number }
interface Cell { x: number; y: number }
const key = (x: number, y: number) => `${x},${y}`;
const inside = (b: Box, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;

/** One detached dwelling in a useful exterior lobe, before offering yards to cover.
 * The full local bypass is retained as fixed access during the later handoff.
 * Primary ring/court authorship and its RNG channels are deliberately independent. */
export function buildCompoundExterior(brief: RegionBrief, ring: Box, gates: Cell[], observe?: BuildingObserver): {
  elements: RegionElement[]; boxes: Box[]; steps: Cell[];
} {
  const empty = { elements: [], boxes: [], steps: [] };
  const size = brief.cellSize, fill = createFillMask(brief), access = createAccessMask(brief);
  const fits = (x: number, y: number, box?: Box) => [0, 1].every(dy => [0, 1].every(dx =>
    access.has(x + dx, y + dy) && !inside(ring, x + dx, y + dy) && (!box || !inside(box, x + dx, y + dy))));
  const start = gates[0];
  if (!start || !fits(start.x, start.y)) return empty;
  const flood = (box?: Box) => {
    const reached = new Set([key(start.x, start.y)]), queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const { x, y } = queue[head]!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy, k = key(nx, ny);
        if (reached.has(k) || !fits(nx, ny, box)) continue;
        reached.add(k); queue.push({ x: nx, y: ny });
      }
    }
    return { reached, cells: queue };
  };
  // Only build if all actual gates belong to the same exterior yard component.
  // Preserve its side pockets as well as portal-to-portal connectivity below.
  let before: ReturnType<typeof flood> | undefined;
  const canvas = createBuilderCanvas(brief);
  const seed = Math.floor(draw(brief.seed, ring.x, ring.y, 40) * 2 ** 31);
  for (const [w, h, spaces] of [[6, 6, 3], [6, 4, 2], [4, 6, 2], [4, 4, 1], [4, 3, 1], [3, 4, 1], [3, 3, 1]] as const) {
    const candidates = fill.cells.filter(({ x, y }) => {
      if (!(x + w + 2 <= ring.x || ring.x + ring.w + 2 <= x || y + h + 2 <= ring.y || ring.y + ring.h + 2 <= y)) return false;
      for (let j = y - 2; j < y + h + 2; j++) for (let i = x - 2; i < x + w + 2; i++)
        if (!access.has(i, j) || (i >= x && i < x + w && j >= y && j < y + h && !fill.has(i, j))) return false;
      return true;
    }).sort((a, b) => draw(brief.seed, a.x, a.y, 41) - draw(brief.seed, b.x, b.y, 41) || a.y - b.y || a.x - b.x);
    if (!candidates.length) continue;
    before ??= flood();
    if (!gates.every(p => before!.reached.has(key(p.x, p.y)))) return empty;
    const houses = (['N', 'E', 'S', 'W'] as Side[]).map(door => ({ door, house: HOUSE.build({ w, h, spaces, door, seed }, size) }));
    if (houses.every(({ house }) => 'refused' in house)) continue;
    for (const { x, y } of candidates) {
      const box = { x, y, w, h };
      // Removing free space cannot connect an initially isolated lobe. Every
      // admitted collar must contain this corner, so avoid a futile flood there.
      if (!before.reached.has(key(x - 2, y - 2))) continue;
      if (!fits(start.x, start.y, box)) continue;
      const after = flood(box);
      if (!gates.every(p => after.reached.has(key(p.x, p.y)))) continue;
      if (!before.cells.every(p => !fits(p.x, p.y, box) || after.reached.has(key(p.x, p.y)))) continue;
      // Cover cannot take these two-cell bands or introduce new margins through them.
      const collar: Cell[] = [];
      const along = (from: number, to: number) => [...new Set([
        ...Array.from({ length: Math.floor((to - from) / 2) + 1 }, (_, i) => from + 2 * i), to,
      ])];
      for (const i of along(x - 2, x + w)) collar.push({ x: i, y: y - 2 }, { x: i, y: y + h });
      for (const j of along(y, y + h - 2)) collar.push({ x: x - 2, y: j }, { x: x + w, y: j });
      if (!collar.every(p => after.reached.has(key(p.x, p.y)))) continue;
      for (const { door, house } of houses) {
        if ('refused' in house) continue;
        const steps = house.details.steps.map(t => ({
          x: door === 'W' ? x - 2 : door === 'E' ? x + w : x + t,
          y: door === 'N' ? y - 2 : door === 'S' ? y + h : y + t,
        }));
        if (!steps.every(p => after.reached.has(key(p.x, p.y)))) continue;
        const elements = placedElements(house, 'compound-outbuilding', x, y, size);
        const protectedSteps = [...new Map([...collar, ...steps].map(p => [key(p.x, p.y), p])).values()];
        if (!canvas.commit({ elements, access: protectedSteps.map(p => rect(p.x * size, p.y * size, 2 * size, 2 * size)) })) continue;
        const { design, allocation, realization } = house.details;
        observe?.({ label: 'compound-outbuilding', origin: { x: x * size, y: y * size }, cellSize: size, design, allocation, realization });
        return { elements: [...canvas.elements], boxes: [box], steps: protectedSteps };
      }
    }
  }
  return empty;
}
