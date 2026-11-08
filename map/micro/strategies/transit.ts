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
 * Authored minimal appearance descriptors for `transit` civic rail/commuter stations with imposed
 * hunter warp apparatus (11.1 §5.2, §5.5, 54).
 * Contrasts civic station masonry/signage (`oldAdvertBlue`, `slatePaving`, `storefrontTeal`) with
 * imposed hunter warp coils (`cobaltBlue`, `showtimeMagenta`).
 */
export const TRANSIT_STATION_INTACT: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'warmMasonry',
  roofPaint: 'oldAdvertBlue',
  roofRim: 'storefrontTeal',
  interiorTrim: 'storefrontTeal',
  roofSign: {
    color: 'storefrontTeal',
    backing: 'structuralVoid',
    stripe: 'dirtyCream',
    dx: 18,
    dy: 12,
    w: 76,
    h: 18,
  },
});

export const TRANSIT_STATION_WEATHERED: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'dustyStucco',
  roofPaint: 'oldAdvertBlue',
  roofRim: 'weatheredCoral',
  interiorTrim: 'storefrontTeal',
  neglect: {
    fadedPanel: { dx: 20, dy: 28, w: 48, h: 22 },
    roofDrainStain: { dx: 74, dy: 22, w: 30, h: 18 },
  },
});

export const TRANSIT_STATION_DAMAGED: BuildingAppearance = Object.freeze({
  floorMaterial: 'coolConcrete',
  wallMaterial: 'coolConcrete',
  roofPaint: 'dirtyCream',
  roofRim: 'oldSignRed',
  interiorTrim: 'oldSignRed',
  neglect: {
    fadedPanel: { dx: 18, dy: 26, w: 44, h: 20 },
    roofDrainStain: { dx: 70, dy: 20, w: 28, h: 18 },
    floorStain: { dx: 50, dy: 40, w: 34, h: 22 },
    scorchMark: { dx: 38, dy: 44, w: 48, h: 30 },
  },
});

export const TRANSIT_STATION_PRESETS: readonly [BuildingAppearance, BuildingAppearance, BuildingAppearance] = Object.freeze([
  TRANSIT_STATION_INTACT,
  TRANSIT_STATION_WEATHERED,
  TRANSIT_STATION_DAMAGED,
]);

export const TRANSIT_CIVIC_COVER_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'oldAdvertBlue',
  weathered: true,
  focalRim: { side: 'N' as const, color: 'storefrontTeal' },
});

export const TRANSIT_WARP_GUARD_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'oxidizedMetal',
  weathered: true,
  focalRim: { side: 'N' as const, color: 'showtimeMagenta' },
});

export function createTransitStationAppearance(options: TieredAppearanceOptions = {}): BuildingAppearance {
  return createTieredBuildingAppearance(options, {
    presets: TRANSIT_STATION_PRESETS,
    thresholds: [0.35, 0.7],
    tierChannel: 'transit-tier',
  });
}

/** Clear ground around a hunter transit station, measured in cells. */
const STANDING = 2;
const COVER_REACH = 2;

/** A transit region sites the warp promised by its set piece class. */
export function buildTransit(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize, { clearance } = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const standing = brief.parameters?.standing ?? STANDING;
  if (typeof standing !== 'number' || !Number.isFinite(standing) || standing <= 0)
    throw new RangeError(`Region ${brief.id}: transit standing must be a positive number of cells.`);
  const mask = createRegionMask(brief), radius = clearance.hunter, count = brief.coreElements?.warp ?? 0;
  const accessMask = createAccessMask(brief);
  const root = portalStands(brief).find(portal => portal.points.length)?.points[0];

  let warps = spreadPoints(mask, { count, radius, seed: brief.seed }).points;
  if (root && warps.some(point => !findRegionRoute(accessMask, [], root, point, radius)))
    warps = spreadPoints(mask, { count, radius, seed: brief.seed, accessMask, anchor: root }).points;

  const sites = warps.map(point => ({ ...point, radius: Math.max(standing * size, radius), reach: radius }));
  const firstWarp = warps[0];
  const transitPlatformAppearance = firstWarp ? (piece: { x: number; y: number }): ElementAppearance => {
    const bounds = {
      x: Math.round(firstWarp.x - size * 1.5 - piece.x),
      y: Math.round(firstWarp.y - size * 1.5 - piece.y),
      w: size * 3,
      h: size * 3,
    };
    return {
      surfaces: [{
        id: `${brief.id}:transit-platform`,
        bounds,
        material: 'slatePaving',
        weathered: true,
        segmentSpan: 120,
      }],
      commercial: [{
        id: `${brief.id}:transit-stripes`,
        kind: 'parking-stripes',
        bounds,
        color: 'oldAdvertBlue',
        count: 3,
      }],
      scars: [{
        id: `${brief.id}:transit-warp-scorch`,
        kind: 'scorch-group',
        bounds,
      }],
      lighting: {
        fields: [{
          id: `${brief.id}:transit-warp-wash`,
          bounds,
          tint: 'cobaltBlue',
          intensity: 0.45,
        }],
      },
    };
  } : undefined;
  let cover: NearCover = coverAround(brief, sites, root, {
    pieceAppearance: () => TRANSIT_CIVIC_COVER_APPEARANCE,
    ...(transitPlatformAppearance ? { firstElementAppearance: transitPlatformAppearance } : {}),
  });
  for (const site of sites) cover = coverNear(brief, cover, site, COVER_REACH * size, root, {
    guardAppearance: TRANSIT_WARP_GUARD_APPEARANCE,
    ...(!cover.elements.length && transitPlatformAppearance ? { guardElementAppearance: transitPlatformAppearance } : {}),
  });
  const { elements, loot } = cover;
  const coreElements = warps.map(point => ({ kind: 'warp' as const, ...point }));

  return builtRegion(brief, elements, loot, coreElements, cover.guardsSkipped ? { coverGuardsSkipped: cover.guardsSkipped } : {});
}
