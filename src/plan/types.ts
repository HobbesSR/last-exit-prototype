/**
 * The macro plan: what generation decides before any region is filled in.
 *
 * This is a second, coherent generation path built beside the legacy one in
 * `core.ts`, which is untouched and still works. The difference is where
 * connectivity is decided.
 *
 * The legacy path composes authored tiles, discovers regions from the cell
 * classes that fall out, and only then finds out what it built. Nothing knows
 * whether the map is walkable until the whole thing exists, so keeping it
 * walkable while micro generation is free to obstruct it needs `planStreets`:
 * a reserved route network threaded through the finished geometry, plus a
 * repair pass for what still goes wrong. That works and it is a stopgap. It
 * costs a third of the map in reserved ground, and it only exists because macro
 * has no way to say what it needs.
 *
 * Here macro says what it needs. It partitions the map into regions, and for
 * each shared boundary it states a `PerimeterPort`: a floor for what must be
 * able to cross, and a ceiling for what may. Reachability is then proved on the
 * region graph from the floors alone -- a graph of a few hundred nodes, not a
 * lattice of a quarter million -- and the proof holds whatever micro builds,
 * because micro is required to honour the floors. Macro never needs to know
 * what a region did inside itself, and micro never needs to know what the map
 * looks like outside its own area.
 *
 * So there is no reserved corridor network here, and nothing to repair.
 */
import type {
  LootCriteria,
  PerimeterPort,
  SegmentRef,
} from "../micro/types.ts";
import type { Box, FeatureKind, MapParams, MapZone } from "../types.ts";

export type { LootCriteria, PerimeterPort, SegmentRef };

/**
 * One planned region: an area, who fills it, what it owes, and the contract it
 * must honour at its edges.
 *
 * `cells` may be any shape. The shipped planner grows regions out of whole
 * tiles, so their borders land on tile seams and their ports are runs along
 * one -- which is what the design notes encourage at a region border and
 * require nowhere. A planner that wants ragged regions is free to produce them;
 * nothing downstream assumes otherwise.
 */
export interface RegionPlan {
  id: string;
  /** Catalogue id of the builder that fills it. */
  type: string;
  /** Deterministic in the map seed and this region's own identity. */
  seed: number;
  /** Cells this region covers, ascending. Disjoint from every other region. */
  cells: number[];
  /** Inclusive cell bounds, for a consumer that wants them without a scan. */
  bounds: Box;
  /** The perimeter contract, one port per neighbour boundary run. */
  ports: PerimeterPort[];
  /** What macro decided this region owes in loot. */
  loot: LootCriteria;
  /** Progression in force here, from the zone covering the region's centre. */
  tier: number;
  bonus: number;
}

/** A macro feature, attached to the region responsible for siting it. */
export interface PlannedFeature {
  kind: FeatureKind;
  regionId: string;
}

/**
 * The whole plan. Everything here is decided before micro generation runs, and
 * nothing here is geometry: it is a statement of intent the micro pass has to
 * satisfy.
 */
export interface MapPlan {
  version: 1;
  seed: string;
  params: MapParams;
  /** Cell grid dimensions. */
  width: number;
  height: number;
  /** Derived from params, as on the legacy path. Not stored in an artifact. */
  zones: MapZone[];
  regions: RegionPlan[];
  features: PlannedFeature[];
  /** Where a run starts and ends, by region. */
  spawnRegion: string;
  hunterSpawnRegion: string;
  exitRegions: string[];
}

/** Ordering on the passage band, so a floor and a ceiling can be compared. */
export const PASSAGE_RANK = Object.freeze({
  none: 0,
  contestant: 1,
  hunter: 2,
});

/** True when `have` satisfies a requirement of `want`. */
export function admitsPassage(
  have: keyof typeof PASSAGE_RANK,
  want: keyof typeof PASSAGE_RANK,
): boolean {
  return PASSAGE_RANK[have] >= PASSAGE_RANK[want];
}
