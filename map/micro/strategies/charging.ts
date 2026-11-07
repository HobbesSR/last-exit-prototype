import { coverAround, coverNear, type NearCover } from './cover.ts';
import { createAccessMask, createRegionMask, findRegionRoute } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { spreadPoints } from '../placement.ts';
import { portalStands } from '../portals.ts';
import { createTieredBuildingAppearance, type TieredAppearanceOptions } from '../building/decay.ts';
import type { BuildingAppearance, ElementAppearance, ObstacleAppearance } from '../../../shared/types.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { builtRegion } from '../result.ts';

/**
 * Authored minimal appearance descriptors for `charging` competition power rigs (11.1 §5.2, §5.5, 54).
 * Contrasts imposed high-voltage broadcast/competition equipment (`electricTurquoise`, `sodiumAmber`,
 * `oxidizedMetal`, `hotOrange`, scorch marks) with civic transit infrastructure.
 */
export const CHARGING_RIG_INTACT: BuildingAppearance = Object.freeze({
  floorMaterial: 'concrete',
  wallMaterial: 'oxidizedMetal',
  roofPaint: 'slateShadow',
  roofRim: 'electricTurquoise',
  interiorTrim: 'sodiumAmber',
  roofSign: {
    color: 'sodiumAmber',
    backing: 'structuralVoid',
    stripe: 'electricTurquoise',
    dx: 16,
    dy: 12,
    w: 72,
    h: 18,
  },
});

export const CHARGING_RIG_WEATHERED: BuildingAppearance = Object.freeze({
  floorMaterial: 'concrete',
  wallMaterial: 'oxidizedMetal',
  roofPaint: 'slateShadow',
  roofRim: 'sodiumAmber',
  interiorTrim: 'hotOrange',
  neglect: {
    fadedPanel: { dx: 18, dy: 26, w: 46, h: 20 },
    roofDrainStain: { dx: 68, dy: 22, w: 30, h: 18 },
  },
});

export const CHARGING_RIG_DAMAGED: BuildingAppearance = Object.freeze({
  floorMaterial: 'asphalt',
  wallMaterial: 'oxidizedMetal',
  roofPaint: 'structuralVoid',
  roofRim: 'hotOrange',
  interiorTrim: 'oldSignRed',
  neglect: {
    fadedPanel: { dx: 18, dy: 24, w: 44, h: 20 },
    roofDrainStain: { dx: 66, dy: 20, w: 28, h: 18 },
    floorStain: { dx: 48, dy: 38, w: 36, h: 24 },
    scorchMark: { dx: 34, dy: 42, w: 50, h: 32 },
  },
});

export const CHARGING_RIG_PRESETS: readonly [BuildingAppearance, BuildingAppearance, BuildingAppearance] = Object.freeze([
  CHARGING_RIG_INTACT,
  CHARGING_RIG_WEATHERED,
  CHARGING_RIG_DAMAGED,
]);

export const CHARGING_GUARD_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'oxidizedMetal',
  weathered: true,
  focalRim: { side: 'N' as const, color: 'electricTurquoise' },
});

export const CHARGING_COVER_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'oxidizedMetal',
  weathered: true,
  focalRim: { side: 'S' as const, color: 'sodiumAmber' },
});

export function createChargingRigAppearance(options: TieredAppearanceOptions = {}): BuildingAppearance {
  return createTieredBuildingAppearance(options, {
    presets: CHARGING_RIG_PRESETS,
    thresholds: [0.3, 0.65],
    tierChannel: 'charging-tier',
  });
}

/**
 * Proposed (54): cells around the charger kept clear of cover and loot. The live game
 * charges within 70 units, 1.75 cells at 40 units a cell (14).
 */
const STANDING = 2;
/** Proposed (54): some cover stands within this many cells of the standing room, a doorway's width. */
const COVER_REACH = 2;

/**
 * The `charging` region type (54): the power-cell charging station (F-03). It has no
 * decomposer yet, and takes its region whole.
 *
 * The charger stands as near the region's middle as a contestant fits and can walk to
 * from the first portal. Cover and loot keep off the ground within `standing` cells of it,
 * so contestants can stand round it. Then some cover stands within `COVER_REACH` cells of
 * that ground, if the region has room, so the five-second wait (14) is a choice rather than
 * a death. A region with no room for the charger sites none, and the report names the
 * shortfall (51 stage 8).
 */
export function buildCharging(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize, { clearance } = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const standing = brief.parameters?.standing ?? STANDING;
  if (typeof standing !== 'number' || !Number.isFinite(standing) || standing <= 0)
    throw new RangeError(`Region ${brief.id}: charging standing must be a positive number of cells.`);
  const mask = createRegionMask(brief), radius = clearance.contestant, count = brief.coreElements?.charger ?? 0;
  const accessMask = createAccessMask(brief);
  const root = portalStands(brief).find(portal => portal.points.length)?.points[0];

  // The middle first; if a contestant can't walk there from the first portal, the nearest place it can.
  let chargers = spreadPoints(mask, { count, radius, seed: brief.seed }).points;
  if (root && chargers.some(point => !findRegionRoute(accessMask, [], root, point, radius)))
    chargers = spreadPoints(mask, { count, radius, seed: brief.seed, accessMask, anchor: root }).points;

  const sites = chargers.map(point => ({ ...point, radius: Math.max(standing * size, radius), reach: radius }));
  const firstCharger = chargers[0];
  const rigPadAppearance = firstCharger ? (piece: { x: number; y: number }): ElementAppearance => {
    const bounds = {
      x: Math.round(firstCharger.x - size * 1.5 - piece.x),
      y: Math.round(firstCharger.y - size * 1.5 - piece.y),
      w: size * 3,
      h: size * 3,
    };
    return {
      surfaces: [{
        id: `${brief.id}:charging-rig-pad`,
        bounds,
        material: 'coolConcrete',
        weathered: true,
        segmentSpan: 120,
      }],
      commercial: [{
        id: `${brief.id}:charging-rig-stripes`,
        kind: 'parking-stripes',
        bounds,
        color: 'sodiumAmber',
        count: 3,
      }],
      scars: [{
        id: `${brief.id}:charging-rig-scorch`,
        kind: 'scorch-group',
        bounds,
      }],
      lighting: {
        fields: [{
          id: `${brief.id}:charging-rig-wash`,
          bounds,
          tint: 'electricTurquoise',
          intensity: 0.5,
        }],
      },
    };
  } : undefined;
  let cover: NearCover = coverAround(brief, sites, root, {
    pieceAppearance: () => CHARGING_COVER_APPEARANCE,
    ...(rigPadAppearance ? { firstElementAppearance: rigPadAppearance } : {}),
  });
  for (const site of sites) cover = coverNear(brief, cover, site, COVER_REACH * size, root, {
    guardAppearance: CHARGING_GUARD_APPEARANCE,
    ...(!cover.elements.length && rigPadAppearance ? { guardElementAppearance: rigPadAppearance } : {}),
  });
  const { elements, loot } = cover;
  const coreElements = chargers.map(point => ({ kind: 'charger' as const, ...point }));

  return builtRegion(brief, elements, loot, coreElements, cover.guardsSkipped ? { coverGuardsSkipped: cover.guardsSkipped } : {});
}
