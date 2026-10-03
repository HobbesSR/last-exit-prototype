/**
 * The zones a plan gives and the tile slots they cover, from the params alone (55).
 * Placement draws its mask from them, and briefs their zone contexts.
 */
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainParams } from "./types.ts";
import { zonePlan } from "./zone-plan.ts";
import type { ZonePlan } from "./zone-plan.ts";

/** Inclusive bounds: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

/**
 * A tier zone: a macro area with its own extent, carrying the progression
 * parameters for everything inside it. Zones tile the map exactly, so the map
 * boundary is the stair-stepped union of occupied zones rather than the plan's
 * smooth outline.
 */
export interface MapZone {
  id: string;
  /** Position in the zone grid, not in tiles. */
  col: number;
  row: number;
  /** Horizontal progression, from the plan. */
  tier: number;
  /** The novelty axis, from the plan. */
  bonus: number;
  /** Chance that a spaced slot inside this zone carries loot. Rises with tier. */
  lootChance: number;
  /** Inclusive bounds in tile units. */
  tiles: Box;
  /** Inclusive bounds in cell units. */
  cells: Box;
}

/** One tile slot of the mask, in tile units, and the zone that covers it. */
export interface MaskCell {
  x: number;
  y: number;
  col: number;
  row: number;
  id: string;
  zoneId: string;
}

/** What zones are made from. */
export type ZoneParams = Pick<ChainParams, "zoneWidth" | "zoneHeight" | "lootChance" | "lootTierStep">;

/** Every occupied zone of the plan, with its extent in both tiles and cells. */
export function makeZones(p: ZoneParams, plan: ZonePlan = zonePlan(p)): MapZone[] {
  const zones: MapZone[] = [];
  for (let row = 0; row < plan.rows; row++)
    for (let col = 0; col < plan.columns; col++) {
      if (!plan.occupied(col, row)) continue;
      const x0 = col * p.zoneWidth, y0 = row * p.zoneHeight;
      const x1 = x0 + p.zoneWidth - 1, y1 = y0 + p.zoneHeight - 1;
      const tier = plan.tier(col, row);
      zones.push({
        id: `z-${col}-${row}`,
        col,
        row,
        tier,
        bonus: plan.bonus(col, row),
        // Loot rises with horizontal progress. The bonus axis is deliberately
        // not folded in until the diagram's combination rule is settled.
        lootChance: Math.min(1, Math.max(0, p.lootChance + (tier - 1) * p.lootTierStep)),
        tiles: [x0, y0, x1, y1],
        cells: [x0 * CHAIN_TILE_SIZE, y0 * CHAIN_TILE_SIZE, (x1 + 1) * CHAIN_TILE_SIZE - 1, (y1 + 1) * CHAIN_TILE_SIZE - 1],
      });
    }
  return zones;
}

/**
 * The tile slots the occupied zones cover, zone by zone. A layout's slots are in this
 * order, so a slot's position is never stored.
 */
export function layoutSlots(p: ZoneParams, plan: ZonePlan = zonePlan(p)): MaskCell[] {
  const cells: MaskCell[] = [];
  for (const zone of makeZones(p, plan)) {
    const [x0, y0, x1, y1] = zone.tiles;
    for (let col = x0; col <= x1; col++)
      for (let row = y0; row <= y1; row++)
        cells.push({ x: col, y: row, col, row, id: `t-${col}-${row}`, zoneId: zone.id });
  }
  return cells;
}
