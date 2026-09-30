import type { Cell } from './cell.ts';
import type { Run } from './run.ts';

/**
 * The macro/micro contract: the brief a region's strategy is handed and the result it
 * returns (docs 51 stages 5 and 6). It belongs to neither level (17 M1), and it imports
 * nothing outside the kernel, so macro can build briefs without the game engine.
 */
export type { Cell };

/** A region type names the strategy that fills a region of its class. The game's registry resolves it. */
export type RegionTypeId = string;

/** A spawn, hunter spawn, exit, charger or warp (51 "Features"). */
export type FeatureKind = 'spawn' | 'hunter-spawn' | 'exit' | 'charger' | 'warp';
export const FEATURE_KINDS: readonly FeatureKind[] = Object.freeze(['spawn', 'hunter-spawn', 'exit', 'charger', 'warp']);

/**
 * A maximal straight stretch of guaranteed-passable segments on the region's perimeter
 * (51 stage 3). It is derived, never authored, and it places no geometry: it states what
 * must stay passable. Its run lies on the region's boundary, with the region's cells on
 * exactly one side of every segment.
 */
export interface Portal extends Run { id: string }

/** One zone's context for the brief cells it covers (51 stage 5). Loot chance is per cell, from 0 to 1. */
export interface ZoneContext { tier: number; bonus: number; lootChance: number; cells: Cell[] }

/**
 * Everything one region's strategy is handed. A brief never mentions another region's
 * contents. Bodies are the kernel's body scale (`scale.ts`) at `cellSize` world units a cell.
 */
export interface RegionBrief {
  id: string;
  seed: number;
  type: RegionTypeId;
  /** The class rule's parameters, passed as stated. */
  parameters?: Record<string, number | string | boolean>;
  cellSize: number;
  cells: Cell[];
  /** Every cell appears in exactly one zone. */
  zones: ZoneContext[];
  /** The features the class rule lists, with every count resolved. */
  features?: Partial<Record<FeatureKind, number>>;
  /**
   * The strategy's one promise: every part of every portal is reachable by a hunter from
   * every other portal, from within the region. One portal carries no requirement.
   */
  portals: Portal[];
}

/** A point in world units, in the frame where cell (x, y) spans [x, x + 1) × [y, y + 1) times `cellSize`. */
export interface Site { x: number; y: number }
export interface FeatureSite extends Site { kind: FeatureKind }
export interface LootSite extends Site { tier: number }

/**
 * What a strategy returns. Geometry is the game's (`Element`), so macro can read the rest,
 * such as feature sites for the report, without the engine. The manifest counts what landed.
 */
export interface RegionResult<Element = unknown> {
  version: 'region-1';
  brief: RegionBrief;
  elements: Element[];
  features: FeatureSite[];
  loot: LootSite[];
  manifest: Record<string, number>;
}
