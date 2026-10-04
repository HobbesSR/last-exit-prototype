import { bounds, circle, rect } from '../../../shared/shape.ts';
import { capsule, findRegionRoute, shapesOverlap } from '../geometry.ts';
import { hunterClearance, portalStands } from '../portals.ts';
import { microMetrics } from '../metrics.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { LootSite, RegionBrief, RegionMask } from '../types.ts';

/*
 * What the strategies that scatter pieces around protected routes share: `rubble` and
 * `ruins` (54). They protect the portals' approaches and one hunter route between them
 * in the empty shape first, then drop any piece that would touch what's protected, so
 * the portal promise holds by construction rather than by a check afterwards.
 */

/** A brief parameter from 0 to 1, or `fallback` when the brief doesn't set it. */
export function fraction(brief: RegionBrief, type: string, key: string, fallback: number): number {
  const value = brief.parameters?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError(`${type} ${key} must be a number from 0 to 1.`);
  return value;
}

/** Stable per-cell draws, independent of the order in which a brief lists its cells. */
export function draw(seed: number, x: number, y: number, channel: number): number {
  let n = Math.imul(seed ^ channel, 0x9e3779b1) ^ Math.imul(x, 0x85ebca6b) ^ Math.imul(y, 0xc2b2ae35);
  n = Math.imul(n ^ n >>> 16, 0x7feb352d);
  n = Math.imul(n ^ n >>> 15, 0x846ca68b);
  return ((n ^ n >>> 16) >>> 0) / 0x100000000;
}

/**
 * The shapes no piece may touch: a strip over every portal's stands and threshold crossing,
 * and one hunter route from the first portal to each other, found in the empty shape. One
 * portal carries no route obligation, so it protects nothing. `type` names the region type
 * in what it throws.
 */
export function protectedRoutes(brief: RegionBrief, mask: RegionMask, type: string): Shape[] {
  const radius = hunterClearance(brief.cellSize), stands = portalStands(brief, mask);
  const kept: Shape[] = [];
  if (stands.length < 2) return kept;
  for (const { portal, points } of stands) {
    if (!points.length) throw new Error(`${type} portal ${portal.id} is too short for a hunter.`);
    // One strip covers every stand and its threshold crossing, without a
    // protection shape per half-cell sample on a long portal.
    const line = (portal.axis === 'h' ? portal.y : portal.x) * brief.cellSize;
    const start = (portal.axis === 'h' ? portal.x : portal.y) * brief.cellSize;
    const margin = 2 * (radius + 1);
    kept.push(portal.axis === 'h'
      ? rect(start, line - margin, portal.length * brief.cellSize, 2 * margin)
      : rect(line - margin, start, 2 * margin, portal.length * brief.cellSize));
  }
  const root = stands[0]!.points[0]!;
  for (const { portal, points } of stands.slice(1)) {
    const route = findRegionRoute(mask, [], root, points[0]!, radius);
    if (!route) throw new Error(`${type} region ${brief.id} cannot join portal ${portal.id} in its empty shape.`);
    for (let i = 1; i < route.length; i++) kept.push(...capsule(route[i - 1]!, route[i]!, radius + 1));
  }
  return kept;
}

/**
 * Loot at each cell's centre that rolls under its zone's chance (52, "Tier zones"), where a
 * loot disc stays inside the region and clear of every piece. `channel` keeps the roll apart
 * from the strategy's other per-cell draws.
 */
export function cellLoot(brief: RegionBrief, mask: RegionMask, pieces: readonly Shape[], channel: number): LootSite[] {
  const size = brief.cellSize;
  // Each piece is filed under every cell its bounds touch, so a disc tests only its neighbours.
  const near = new Map<string, Shape[]>();
  for (const shape of pieces) {
    const box = bounds(shape);
    for (let y = Math.floor(box.y / size); y < Math.ceil((box.y + box.h) / size); y++)
      for (let x = Math.floor(box.x / size); x < Math.ceil((box.x + box.w) / size); x++) {
        const key = `${x},${y}`, list = near.get(key);
        if (list) list.push(shape); else near.set(key, [shape]);
      }
  }
  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(cell => [`${cell.x},${cell.y}`, zone] as const)));
  const radius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
  const reach = Math.ceil(radius / size - .5);
  const loot: LootSite[] = [];
  for (const cell of mask.cells) {
    const zone = zones.get(`${cell.x},${cell.y}`);
    if (!zone || draw(brief.seed, cell.x, cell.y, channel) >= zone.lootChance) continue;
    const x = (cell.x + .5) * size, y = (cell.y + .5) * size, site = circle(x, y, radius);
    if (!mask.contains(site)) continue;
    let blocked = false;
    for (let dy = -reach; dy <= reach && !blocked; dy++) for (let dx = -reach; dx <= reach; dx++)
      if (near.get(`${cell.x + dx},${cell.y + dy}`)?.some(shape => shapesOverlap(site, shape))) { blocked = true; break; }
    if (!blocked) loot.push({ x, y, tier: zone.tier });
  }
  return loot;
}
