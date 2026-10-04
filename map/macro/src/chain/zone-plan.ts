/**
 * Zone plans (55): the one statement of a map's macro shape. A plan owns the zone grid,
 * which of its zones are occupied, each zone's tier and bonus, the zone sizes it is
 * authored at, and where each set piece placement rule may anchor. Libraries own what
 * fills it: designs, set pieces, class membership and quotas, authored per size.
 *
 * "Layout" already names placement's output (51 stage 1), so the shape is a plan.
 */
import type { PlacementRule } from "./library.ts";
import type { ChainParams } from "./types.ts";

/** A zone size, in tiles. */
export interface ZoneSize {
  width: number;
  height: number;
}

/** Where an instance's anchor slot may go, in tile units, given the piece's extent. */
export type PlacementFilter = (anchor: { x: number; y: number }, width: number) => boolean;

export interface ZonePlan {
  id: string;
  /** The zone grid, in zones. */
  columns: number;
  rows: number;
  occupied(col: number, row: number): boolean;
  /** Horizontal progression, from 1. */
  tier(col: number, row: number): number;
  /** The vertical novelty axis, from 0. */
  bonus(col: number, row: number): number;
  /** The size the game and the tools start from. */
  defaultZone: ZoneSize;
  /**
   * The sizes game mode accepts: those a library is authored for. Playground mode
   * accepts any size (51).
   */
  authoredZones: readonly ZoneSize[];
  /** Where the `nth` of `quota` instances of a rule may anchor, on a map `columns` by `rows` tiles. */
  placementFilter(rule: PlacementRule, nth: number, quota: number, columns: number, rows: number): PlacementFilter;
}

/**
 * The diamond (55). Five columns give the five horizontal tiers; five rows give the
 * bonus axis, rising away from the middle. A zone is occupied when it lies within two
 * steps of the centre by Manhattan distance, which is the diamond the design notes draw:
 *
 *     X X 5 X X
 *     X 3 4 3 X
 *     1 2 3 4 5
 *     X 3 4 3 X
 *     X X 5 X X
 *
 * The drawing sums tier and bonus. How the two combine is open (17 M16), so they stay
 * separate here. Entry is the western tip and exit the eastern, so the map widens through the middle
 * tiers and funnels toward the exits.
 */
const CENTRE = 2, REACH = 2;
export const DIAMOND: ZonePlan = Object.freeze({
  id: "diamond",
  columns: 5,
  rows: 5,
  occupied: (col: number, row: number) => Math.abs(col - CENTRE) + Math.abs(row - CENTRE) <= REACH,
  tier: (col: number) => col + 1,
  bonus: (_col: number, row: number) => Math.abs(row - CENTRE),
  defaultZone: Object.freeze({ width: 12, height: 6 }),
  authoredZones: Object.freeze([Object.freeze({ width: 12, height: 6 })]),
  placementFilter(rule: PlacementRule, nth: number, quota: number, columns: number, rows: number): PlacementFilter {
    switch (rule) {
      case "start": return (c) => c.x === 0;
      case "end": return (c, w) => c.x + w >= columns;
      case "enormous": {
        // The middle band, one instance per vertical third.
        const third = nth % 3;
        return (c, w) => c.x > columns / 4 && c.x + w < columns * 3 / 4 &&
          c.y >= rows * third / 3 && c.y < rows * (third + 1) / 3;
      }
      case "medium": return (c, w) => c.x < columns / 3 || c.x + w > columns * 2 / 3;
      case "transit": {
        // Partition the central 76% into one band per instance. Inset each band's
        // anchors by a tile so neighboring transit regions cannot join into one.
        const start = columns * 0.12, span = columns * 0.76;
        const left = Math.floor(start + nth * span / quota) + 1;
        const right = Math.floor(start + (nth + 1) * span / quota) - 1;
        return (c, w) => c.x >= left && c.x + w <= right;
      }
      case "small":
      case "charger": return () => true;
    }
  },
});

/** The plan a map's params use. The diamond is the only plan so far. */
export function zonePlan(_params?: Pick<ChainParams, "zoneWidth" | "zoneHeight">): ZonePlan {
  return DIAMOND;
}

/** The plan's whole grid in tiles: occupied or not, every zone is `zoneWidth` by `zoneHeight`. */
export function planTiles(plan: ZonePlan, p: Pick<ChainParams, "zoneWidth" | "zoneHeight">): { columns: number; rows: number } {
  return { columns: plan.columns * p.zoneWidth, rows: plan.rows * p.zoneHeight };
}

/** Whether game mode accepts this zone size under the plan. */
export const isAuthoredZone = (plan: ZonePlan, p: Pick<ChainParams, "zoneWidth" | "zoneHeight">): boolean =>
  plan.authoredZones.some((z) => z.width === p.zoneWidth && z.height === p.zoneHeight);
