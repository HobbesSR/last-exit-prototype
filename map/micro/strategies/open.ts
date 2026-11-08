import type { BuildingAppearance } from '../../../shared/types.ts';
import { createTieredBuildingAppearance, type TieredAppearanceOptions } from '../building/decay.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { builtRegion } from '../result.ts';

/**
 * Authored minimal appearance descriptors for open plaza and asphalt parcels (`open`, 11.1 §5.5, 54).
 * Provides reusable three-tier surface and wear descriptors for open civic plazas and cleared parcels
 * while keeping `buildOpen`'s region contract (`elements: []`) intact.
 */
export const OPEN_PARCEL_INTACT: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'coolConcrete',
  roofPaint: 'slateShadow',
  roofRim: 'storefrontTeal',
  interiorTrim: 'storefrontTeal',
});

export const OPEN_PARCEL_WEATHERED: BuildingAppearance = Object.freeze({
  floorMaterial: 'coolConcrete',
  wallMaterial: 'dustyStucco',
  roofPaint: 'slateShadow',
  roofRim: 'weatheredCoral',
  interiorTrim: 'weatheredCoral',
  neglect: {
    floorStain: { dx: 32, dy: 28, w: 36, h: 24 },
  },
});

export const OPEN_PARCEL_DAMAGED: BuildingAppearance = Object.freeze({
  floorMaterial: 'asphalt',
  wallMaterial: 'coolConcrete',
  roofPaint: 'dirtyCream',
  roofRim: 'oldSignRed',
  interiorTrim: 'oldSignRed',
  neglect: {
    floorStain: { dx: 28, dy: 24, w: 40, h: 26 },
    scorchMark: { dx: 36, dy: 30, w: 48, h: 32 },
  },
});

export const OPEN_PARCEL_PRESETS: readonly [BuildingAppearance, BuildingAppearance, BuildingAppearance] = Object.freeze([
  OPEN_PARCEL_INTACT,
  OPEN_PARCEL_WEATHERED,
  OPEN_PARCEL_DAMAGED,
]);

export function createOpenParcelAppearance(options: TieredAppearanceOptions = {}): BuildingAppearance {
  return createTieredBuildingAppearance(options, {
    presets: OPEN_PARCEL_PRESETS,
    thresholds: [0.35, 0.7],
    tierChannel: 'open-parcel-tier',
    weatheredFloorStainChance: 0.7,
  });
}

/**
 * The `open` region type (54): the fill, and every decomposer's last resort (17 M24).
 * For now it builds nothing, so the region is pure open cells (17 M25). Every cell and
 * every inside segment stays passable, and it places no core elements and no loot. A brief
 * that lists core elements gets none, and the shortfall is the report's to name (51 stage 8).
 */
export function buildOpen(brief: RegionBrief): BuiltRegion {
  return builtRegion(brief, [], []);
}
