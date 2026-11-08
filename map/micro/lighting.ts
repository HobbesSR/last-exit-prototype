import type { LightingFieldAppearance, Vec2 } from '../../shared/types.ts';
import type { BuiltMap, RegionElement } from './types.ts';
import { rng } from './random.ts';

/** Versioned presentation recipe; no simulation stream, IDs or geometry are read or changed. */
export const REGIONAL_LIGHTING_VERSION = 'district-light-1';
const TINTS = ['cobaltBlue', 'showtimeMagenta', 'sodiumAmber', 'signalCyan'] as const;
const THEMES: Readonly<Record<string, number>> = {
  park: 3, plant: 3, rubble: 2, ruins: 2, checkpoint: 2, departure: 2,
  market: 1, charging: 1, landmark: 1, compound: 0, hut: 0, depot: 0, transit: 0, arrival: 0,
};

/**
 * Broad districts, rather than one draw per tile: at most six rectangular washes cover the
 * occupied map. Regional cell counts choose each district's land-use treatment. A separate
 * named seed channel breaks ties and varies intensity, independent of traversal/camera order.
 * Bounds are world coordinates after `origin`, including maps with negative contract cells.
 */
export function regionalLightingFields(map: BuiltMap<RegionElement>, origin: Vec2): LightingFieldAppearance[] {
  const regions = [...map.regions].sort((a, b) => a.brief.id < b.brief.id ? -1 : a.brief.id > b.brief.id ? 1 : 0);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { brief } of regions) for (const c of brief.cells) {
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + 1); maxY = Math.max(maxY, c.y + 1);
  }
  if (!Number.isFinite(minX)) return [];
  const width = maxX - minX, height = maxY - minY;
  const cols = Math.min(width, width >= height ? 3 : 2), rows = Math.min(height, width >= height ? 2 : 3);
  const votes = Array.from({ length: cols * rows }, () => [0, 0, 0, 0]);
  const focal = new Set<number>();
  for (const { brief } of regions) for (const c of brief.cells) {
    const col = Math.min(cols - 1, Math.floor((c.x - minX) / width * cols));
    const row = Math.min(rows - 1, Math.floor((c.y - minY) / height * rows));
    const district = row * cols + col;
    votes[district]![THEMES[brief.type] ?? 0]!++;
    if (brief.type === 'landmark' || Object.values(brief.coreElements ?? {}).some(count => count > 0)) focal.add(district);
  }
  const identity = JSON.stringify(regions.map(({ brief }) => [brief.id, brief.seed]));
  const fields: LightingFieldAppearance[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const index = row * cols + col, counts = votes[index]!, largest = Math.max(...counts);
    if (!largest) continue;
    const random = rng(0, `${REGIONAL_LIGHTING_VERSION}:${identity}:${col}:${row}`);
    const ties = counts.flatMap((count, i) => count === largest ? [i] : []);
    const tint = TINTS[ties[random.int(0, ties.length - 1)]!]!;
    const size = map.cellSize;
    const bounds = { x: origin.x + (minX + col * width / cols) * size,
      y: origin.y + (minY + row * height / rows) * size, w: width / cols * size, h: height / rows * size };
    fields.push({ id: `${REGIONAL_LIGHTING_VERSION}:${col}:${row}`, bounds, tint,
      intensity: 0.24 + random.next() * 0.06, falloff: Math.min(bounds.w, bounds.h) * 0.25,
      ...(focal.has(index) ? { focalEdge: { color: 'sodiumAmber', x: bounds.x, y: bounds.y,
        w: bounds.w, h: Math.min(size * 0.2, bounds.h), alpha: 0.24 } } : {}) });
  }
  return fields;
}
