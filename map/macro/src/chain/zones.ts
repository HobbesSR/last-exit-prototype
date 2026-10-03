/**
 * The zone grid and the tile slots it covers, from the params alone (52, "Tier zones and
 * the mask"). Placement draws its mask from it, and briefs their zone contexts.
 */
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainParams } from "./types.ts";

/**
 * The zone grid. Five columns give the five horizontal tiers; five rows give
 * the bonus axis, rising away from the middle. A zone is occupied when it lies
 * within two steps of the centre by Manhattan distance, which is the diamond
 * the design notes draw:
 *
 *     X X 5 X X
 *     X 3 4 3 X
 *     1 2 3 4 5
 *     X 3 4 3 X
 *     X X 5 X X
 */
export const ZONE_COLUMNS = 5;
export const ZONE_ROWS = 5;
const ZONE_CENTRE_COL = (ZONE_COLUMNS - 1) / 2;
const ZONE_CENTRE_ROW = (ZONE_ROWS - 1) / 2;
const ZONE_REACH = 2;

function zoneOccupied(col: number, row: number): boolean {
  return Math.abs(col - ZONE_CENTRE_COL) + Math.abs(row - ZONE_CENTRE_ROW) <= ZONE_REACH;
}

/** Inclusive bounds: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

/**
 * A tier zone: a macro area with its own extent, carrying the progression
 * parameters for everything inside it. Zones tile the map exactly, so the map
 * boundary is the stair-stepped union of occupied zones rather than a smooth
 * diamond.
 */
export interface MapZone {
  id: string;
  /** Position in the zone grid, not in tiles. */
  col: number;
  row: number;
  /** Horizontal progression, `col + 1`, running 1..5. */
  tier: number;
  /** Distance in zone rows from the middle row, running 0..2. */
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

/** Every occupied zone, with its extent in both tiles and cells. */
export function makeZones(p: ZoneParams): MapZone[] {
  const zones: MapZone[] = [];
  for (let row = 0; row < ZONE_ROWS; row++)
    for (let col = 0; col < ZONE_COLUMNS; col++) {
      if (!zoneOccupied(col, row)) continue;
      const x0 = col * p.zoneWidth, y0 = row * p.zoneHeight;
      const x1 = x0 + p.zoneWidth - 1, y1 = y0 + p.zoneHeight - 1;
      const tier = col + 1;
      zones.push({
        id: `z-${col}-${row}`,
        col,
        row,
        tier,
        bonus: Math.abs(row - ZONE_CENTRE_ROW),
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
export function layoutSlots(p: ZoneParams): MaskCell[] {
  const cells: MaskCell[] = [];
  for (const zone of makeZones(p)) {
    const [x0, y0, x1, y1] = zone.tiles;
    for (let col = x0; col <= x1; col++)
      for (let row = y0; row <= y1; row++)
        cells.push({ x: col, y: row, col, row, id: `t-${col}-${row}`, zoneId: zone.id });
  }
  return cells;
}
