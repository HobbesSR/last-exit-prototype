import type { Game, GameMap, InventoryItem, MatchContent, Vec2 } from './types.ts';
import { hypot } from './math.ts';

/**
 * The shared spatial reward/danger selector (F-12, F-15; 14 "Weapon quality").
 *
 * The map's bounding rectangle is split into five virtual columns and five rows. These are
 * distribution zones, not map tiles: a live chain map's frame is exactly the diamond plan's 5 x 5
 * zone grid (55), so its columns agree with loot `tier` metadata; a legacy diamond is inscribed in
 * the same rectangle; any other map gets the same proportional split of whatever rectangle it has.
 * Horizontal progress supplies the base mix and distance from the middle row adds 0/1/2, capped at 5.
 *
 * Rewards and danger read the same selector but own their curves. Novelty is a separate vertical
 * axis; its catalogue is empty until special items are authored, so nothing reads it yet.
 */
export const TIER_GRID = 5;
const MIDDLE = (TIER_GRID - 1) / 2;

export interface VirtualZone { col: number; row: number }

const band = (value: number, extent: number): number =>
  extent > 0 && Number.isFinite(value) ? Math.min(TIER_GRID - 1, Math.max(0, Math.floor(value * TIER_GRID / extent))) : 0;

/** The virtual zone a point falls in. Points on or past an edge clamp into the outer zone; a map without extent is all column 0, middle row. */
export function virtualZone(map: Pick<GameMap, 'width' | 'height'>, point: Vec2): VirtualZone {
  return { col: band(point.x, map.width), row: map.height > 0 ? band(point.y, map.height) : MIDDLE };
}

/** Mix 1..5: column + 1, plus 0/1/2 away from the middle row, capped at 5. */
export function spatialMix(zone: VirtualZone): number {
  return Math.min(TIER_GRID, zone.col + 1 + Math.abs(zone.row - MIDDLE));
}

/** The vertical novelty axis, 0 in the middle row to 2 at the top and bottom; separate from quality. */
export function noveltyBand(zone: VirtualZone): number {
  return Math.abs(zone.row - MIDDLE);
}

/** Quality 1..5 drawn from one mix's weights by `u` in [0, 1). */
export function qualityFromWeights(weights: readonly number[], u: number): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let at = u * total;
  for (const [i, w] of weights.entries()) { if (at < w) return i + 1; at -= w; }
  return weights.findLastIndex(w => w > 0) + 1;
}

/**
 * A uniform [0, 1) value from the match seed and an item's id: FNV-1a then a murmur finalizer.
 * Keyed by id rather than drawn from the match RNG, so quality consumes no legacy RNG and an item's
 * roll does not depend on how many items precede it.
 */
export function itemRoll(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** The spawn kit is placed within this distance of a contestant spawn and stays quality 1. */
export const STARTER_RESERVE = 100;

/**
 * Give each map weapon that has no quality one drawn from its spatial mix. Positions, tier metadata
 * and every other item are untouched, so spawn, charger and reach reservations hold as generated.
 */
export function assignWeaponQualities(s: Game): void {
  const mixes = s.content.lootTiers?.mixes;
  if (!mixes) return;
  for (const item of s.map.items) {
    if (item.kind !== 'weapon' || item.quality !== undefined) continue;
    const starter = s.map.spawns.some(spawn => hypot(item.x - spawn.x, item.y - spawn.y) <= STARTER_RESERVE);
    item.quality = starter ? 1 : qualityFromWeights(mixes[spatialMix(virtualZone(s.map, item)) - 1]!, itemRoll(s.seed, item.id));
  }
}

/** The damage multiplier a carried weapon's quality earns; 1 without L1 content. */
export function qualityDamage(content: Pick<MatchContent, 'lootTiers'>, item: Pick<InventoryItem, 'quality'>): number {
  return content.lootTiers?.damage[(item.quality ?? 1) - 1] ?? 1;
}
