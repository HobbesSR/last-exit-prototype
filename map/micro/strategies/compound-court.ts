import { rect } from '../../../shared/shape.ts';
import type { Side } from '../port-terms.ts';
import type { BuildingObserver } from '../building/trace.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { draw } from '../random.ts';
import { HOUSE } from '../placeables/house.ts';
import { COVER_PIECE, type CoverPieceName } from '../placeables/cover-piece.ts';
import { demandShapes, expectPlaced, placedElements } from '../placeables/placeable.ts';
import type { RegionBrief, RegionElement } from '../types.ts';

interface Box { x: number; y: number; w: number; h: number }

/** Two clear cells surround each footprint and separate it from every other one.
 * Each bypass therefore joins the untouched court perimeter and ring approaches. */
export function buildCompoundCourt(brief: RegionBrief, ring: Box, observe?: BuildingObserver): RegionElement[] {
  const size = brief.cellSize, canvas = createBuilderCanvas(brief), boxes: Box[] = [];
  const court = { x: ring.x + 3, y: ring.y + 3, w: ring.w - 6, h: ring.h - 6 };
  const center = { x: ring.x + Math.floor(ring.w / 2) - 1, y: ring.y + Math.floor(ring.h / 2) - 1 };
  const shape = (b: Box) => rect(b.x * size, b.y * size, b.w * size, b.h * size);
  const allowed = (b: Box) => b.x >= court.x + 2 && b.y >= court.y + 2
    && b.x + b.w <= court.x + court.w - 2 && b.y + b.h <= court.y + court.h - 2
    && !(center.x < b.x + b.w && center.x + 2 > b.x && center.y < b.y + b.h && center.y + 2 > b.y)
    && boxes.every(p => b.x >= p.x + p.w + 2 || p.x >= b.x + b.w + 2
      || b.y >= p.y + p.h + 2 || p.y >= b.y + b.h + 2)
    && canvas.fits(shape(b));
  // The ring is capped at 24 cells, so the 18-cell court bounds this search.
  const candidates = (w: number, h: number, channel: number): Box[] => {
    const result: Box[] = [];
    for (let y = court.y + 2; y + h <= court.y + court.h - 2; y++)
      for (let x = court.x + 2; x + w <= court.x + court.w - 2; x++) {
        const b = { x, y, w, h };
        if (allowed(b)) result.push(b);
      }
    return result.sort((a, b) => draw(brief.seed, a.x, a.y, channel) - draw(brief.seed, b.x, b.y, channel));
  };
  const seed = Math.floor(draw(brief.seed, ring.x, ring.y, 31) * 2 ** 31);
  let placedHouse = false;
  for (const [w, h, spaces] of [[6, 6, 3], [6, 4, 2], [4, 6, 2], [4, 4, 1]] as const) {
    const sites = candidates(w, h, 32);
    if (!sites.length) continue;
    const houses = (['N', 'E', 'S', 'W'] as Side[]).map(door => HOUSE.build({ w, h, spaces, door, seed }, size));
    for (const b of sites) {
      for (const house of houses) {
        if ('refused' in house) continue;
        const elements = placedElements(house, 'compound-keep', b.x, b.y, size);
        const access = demandShapes(house.demand, b.x, b.y, size).slice(1);
        if (!canvas.commit({ elements, access })) continue;
        boxes.push(b);
        const { design, allocation, realization } = house.details;
        observe?.({ label: 'compound-keep', origin: { x: b.x * size, y: b.y * size }, cellSize: size, design, allocation, realization });
        placedHouse = true;
        break;
      }
      if (placedHouse) break;
    }
    if (placedHouse) break;
  }
  for (const [index, piece] of (['container', 'barrier', 'crate', 'crate'] as CoverPieceName[]).entries()) {
    let placed = false;
    for (const turned of [false, true]) {
      const cover = expectPlaced(COVER_PIECE.build({ piece, turned, length: 0.5, offset: 0.5 }, size));
      for (const b of candidates(cover.demand.body.w, cover.demand.body.h, 33 + index)) {
        const elements = placedElements(cover, `compound-court-cover-${index + 1}`, b.x, b.y, size);
        if (!canvas.commit({ elements })) continue;
        boxes.push(b); placed = true; break;
      }
      if (placed) break;
    }
  }
  return [...canvas.elements];
}
