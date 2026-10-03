import { CELL_SCALE } from '../../kernel/scale.ts';
import { circle, rect } from '../../../shared/shape.ts';
import { buildOpen } from './open.ts';
import { capsule, createRegionMask, findRegionRoute, shapesOverlap } from '../geometry.ts';
import { hunterClearance, portalStands } from '../portals.ts';
import { microMetrics } from '../metrics.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

const DEFAULT_DENSITY = 0.85;
const DEFAULT_SQUEEZE_SHARE = 0.8;

function fraction(brief: RegionBrief, key: string, fallback: number): number {
  const value = brief.parameters?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(`Rubble ${key} must be a number from 0 to 1.`);
  return value;
}

/** Stable per-cell draws, independent of the order in which a brief lists its cells. */
function draw(seed: number, x: number, y: number, channel: number): number {
  let n = Math.imul(seed ^ channel, 0x9e3779b1) ^ Math.imul(x, 0x85ebca6b) ^ Math.imul(y, 0xc2b2ae35);
  n = Math.imul(n ^ n >>> 16, 0x7feb352d);
  n = Math.imul(n ^ n >>> 15, 0x846ca68b);
  return ((n ^ n >>> 16) >>> 0) / 0x100000000;
}

/**
 * Rubble has no children (54). Two-cell-spaced debris leaves selected 1.5-cell
 * gaps. Full portal approaches and one hunter route from the first portal to
 * each other portal are protected before any debris is placed.
 */
export function buildRubble(brief: RegionBrief): BuiltRegion {
  const density = fraction(brief, 'density', DEFAULT_DENSITY);
  const squeezeShare = fraction(brief, 'squeezeShare', DEFAULT_SQUEEZE_SHARE);
  const mask = createRegionMask(brief);
  const spanX = mask.bounds.w / brief.cellSize, spanY = mask.bounds.h / brief.cellSize;
  // The catalogue's shape need is proposed; open is the last resort (17 M24).
  if (brief.cells.length < 12 || Math.min(spanX, spanY) < 3) return buildOpen(brief);

  const radius = hunterClearance(brief.cellSize);
  const stands = portalStands(brief, mask);
  const protectedShapes: Shape[] = [];
  if (stands.length > 1) {
    for (const { portal, points } of stands) {
      if (!points.length) throw new Error(`Rubble portal ${portal.id} is too short for a hunter.`);
      // One strip covers every stand and its threshold crossing, without a
      // protection shape per half-cell sample on a long portal.
      const line = (portal.axis === 'h' ? portal.y : portal.x) * brief.cellSize;
      const start = (portal.axis === 'h' ? portal.x : portal.y) * brief.cellSize;
      const margin = 2 * (radius + 1);
      protectedShapes.push(portal.axis === 'h'
        ? rect(start, line - margin, portal.length * brief.cellSize, 2 * margin)
        : rect(line - margin, start, 2 * margin, portal.length * brief.cellSize));
    }
    const root = stands[0]!.points[0]!;
    for (const { portal, points } of stands.slice(1)) {
      const route = findRegionRoute(mask, [], root, points[0]!, radius);
      if (!route) throw new Error(`Rubble region ${brief.id} cannot join portal ${portal.id} in its empty shape.`);
      for (let i = 1; i < route.length; i++) protectedShapes.push(...capsule(route[i - 1]!, route[i]!, radius + 1));
    }
  }

  const elements: RegionElement[] = [];
  const debris = new Map<string, Shape>();
  let squeezeDebris = 0;
  // A half-cell square at every other cell leaves exactly 1.5 cells between
  // neighbors. The narrow variant leaves 1.9 cells, above hunter clearance.
  for (const cell of mask.cells) {
    if ((cell.x & 1) || (cell.y & 1) || draw(brief.seed, cell.x, cell.y, 1) >= density) continue;
    const squeeze = draw(brief.seed, cell.x, cell.y, 2) < squeezeShare;
    const width = (squeeze ? 2 - CELL_SCALE.squeeze : 0.1) * brief.cellSize;
    const shape = rect((cell.x + .5) * brief.cellSize - width / 2,
      (cell.y + .5) * brief.cellSize - width / 2, width, width);
    if (!mask.contains(shape) || protectedShapes.some(keep => shapesOverlap(shape, keep))) continue;
    const label = `rubble-${cell.x}-${cell.y}`;
    elements.push({ label, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h,
      parts: [{ part: 'obstacle', shape, kind: 'ruin-wall' }] } });
    debris.set(`${cell.x},${cell.y}`, shape);
    if (squeeze) squeezeDebris++;
  }

  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(cell => [`${cell.x},${cell.y}`, zone] as const)));
  const lootRadius = microMetrics({ cellSize: brief.cellSize, bodyProfile: 'cell' }).lootRadius;
  const loot: BuiltRegion['loot'] = [];
  for (const cell of mask.cells) {
    const zone = zones.get(`${cell.x},${cell.y}`);
    if (!zone || draw(brief.seed, cell.x, cell.y, 3) >= zone.lootChance) continue;
    const x = (cell.x + .5) * brief.cellSize, y = (cell.y + .5) * brief.cellSize;
    const site = circle(x, y, lootRadius);
    if (!mask.contains(site)) continue;
    // Every piece of debris stays in its own cell. A disc can reach at most
    // two neighboring cells on each side over the supported cell scale.
    let blocked = false;
    for (let dy = -2; dy <= 2 && !blocked; dy++) for (let dx = -2; dx <= 2; dx++) {
      const shape = debris.get(`${cell.x + dx},${cell.y + dy}`);
      if (shape && shapesOverlap(site, shape)) { blocked = true; break; }
    }
    if (!blocked) loot.push({ x, y, tier: zone.tier });
  }
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0,
      loot: loot.length, coreElements: 0, squeezeDebris } };
}
