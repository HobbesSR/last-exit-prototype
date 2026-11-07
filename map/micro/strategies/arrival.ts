import { coverAround } from './cover.ts';
import { createAccessMask, createRegionMask } from '../geometry.ts';
import { microMetrics } from '../metrics.ts';
import { spreadPoints } from '../placement.ts';
import { portalStands } from '../portals.ts';
import { createTieredBuildingAppearance, type TieredAppearanceOptions } from '../building/decay.ts';
import type { BuildingAppearance, ElementAppearance, ObstacleAppearance } from '../../../shared/types.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import { builtRegion } from '../result.ts';

/**
 * Authored minimal appearance descriptors for `arrival` civic transit plazas (11.1 §5.2, §5.5, 54).
 * Contrasts civic commuter infrastructure (`storefrontTeal`, `oldAdvertBlue`, `slatePaving`, `dirtyCream`)
 * against imposed competition equipment.
 */
export const ARRIVAL_PLAZA_INTACT: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'coolConcrete',
  roofPaint: 'storefrontTeal',
  roofRim: 'dirtyCream',
  interiorTrim: 'storefrontTeal',
  roofSign: {
    color: 'storefrontTeal',
    backing: 'structuralVoid',
    stripe: 'dirtyCream',
    dx: 18,
    dy: 12,
    w: 72,
    h: 18,
  },
});

export const ARRIVAL_PLAZA_WEATHERED: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'dustyStucco',
  roofPaint: 'oldAdvertBlue',
  roofRim: 'awningsYellow',
  interiorTrim: 'storefrontTeal',
  roofSign: {
    color: 'awningsYellow',
    backing: 'structuralVoid',
    stripe: 'storefrontTeal',
    dx: 18,
    dy: 12,
    w: 68,
    h: 18,
  },
  neglect: {
    fadedPanel: { dx: 20, dy: 30, w: 46, h: 22 },
    roofDrainStain: { dx: 74, dy: 24, w: 28, h: 18 },
  },
});

export const ARRIVAL_PLAZA_DAMAGED: BuildingAppearance = Object.freeze({
  floorMaterial: 'coolConcrete',
  wallMaterial: 'coolConcrete',
  roofPaint: 'dirtyCream',
  roofRim: 'weatheredCoral',
  interiorTrim: 'weatheredCoral',
  roofSign: {
    color: 'weatheredCoral',
    backing: 'structuralVoid',
    stripe: 'dirtyCream',
    dx: 18,
    dy: 12,
    w: 64,
    h: 18,
  },
  neglect: {
    fadedPanel: { dx: 18, dy: 28, w: 42, h: 20 },
    roofDrainStain: { dx: 70, dy: 22, w: 26, h: 18 },
    floorStain: { dx: 48, dy: 40, w: 32, h: 22 },
    scorchMark: { dx: 36, dy: 44, w: 44, h: 28 },
  },
});

export const ARRIVAL_PLAZA_PRESETS: readonly [BuildingAppearance, BuildingAppearance, BuildingAppearance] = Object.freeze([
  ARRIVAL_PLAZA_INTACT,
  ARRIVAL_PLAZA_WEATHERED,
  ARRIVAL_PLAZA_DAMAGED,
]);

export const ARRIVAL_COVER_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'storefrontTeal',
  weathered: true,
  focalRim: { side: 'N' as const, color: 'dirtyCream' },
});

export function createArrivalFacilityAppearance(options: TieredAppearanceOptions = {}): BuildingAppearance {
  return createTieredBuildingAppearance(options, {
    presets: ARRIVAL_PLAZA_PRESETS,
    thresholds: [0.4, 0.75],
    tierChannel: 'arrival-tier',
  });
}

/**
 * The one arrival region owns every contestant spawn (17 M20, 54). It has no decomposer
 * yet, so it takes the region whole where 54 plans one that picks a spawn subregion. The point placement
 * is the reusable SDK's farthest-first spread; cover and loot use the cover strategy
 * after the points claim their ground. Dropping cover cannot break a portal route.
 */
export function buildArrival(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize;
  const metrics = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const radius = metrics.clearance.contestant;
  const spacing = brief.parameters?.spacing;
  if (spacing !== undefined && (typeof spacing !== 'number' || !Number.isFinite(spacing) || spacing <= 0))
    throw new RangeError(`Region ${brief.id}: arrival spacing must be a positive number of cells.`);

  const mask = createRegionMask(brief);
  const accessMask = createAccessMask(brief);
  const root = portalStands(brief).find(portal => portal.points.length)?.points[0];
  const requested = brief.coreElements?.spawn ?? 0;
  const points = spreadPoints(mask, { count: requested, radius, seed: brief.seed, accessMask,
    minimumSpacing: Math.max(radius * 2, (spacing ?? 0) * size), ...(root ? { anchor: root } : {}) }).points;
  const coreElements = points.map(point => ({ kind: 'spawn' as const, ...point }));
  const firstSpawn = points[0];
  const firstElementAppearance = firstSpawn ? (piece: { x: number; y: number }): ElementAppearance => {
    const bounds = {
      x: Math.round(firstSpawn.x - size * 1.5 - piece.x),
      y: Math.round(firstSpawn.y - size * 1.5 - piece.y),
      w: size * 3,
      h: size * 3,
    };
    return {
      surfaces: [{
        id: `${brief.id}:arrival-apron`,
        bounds,
        material: 'slatePaving',
        weathered: true,
        segmentSpan: 120,
      }],
      commercial: [{
        id: `${brief.id}:arrival-stripes`,
        kind: 'parking-stripes',
        bounds,
        color: 'storefrontTeal',
        count: 3,
      }],
      lighting: {
        fields: [{
          id: `${brief.id}:arrival-wash`,
          bounds,
          tint: 'cobaltBlue',
          intensity: 0.4,
        }],
      },
    };
  } : undefined;
  const { elements, loot } = coverAround(brief, points.map(point => ({ ...point, radius })), root, {
    pieceAppearance: () => ARRIVAL_COVER_APPEARANCE,
    ...(firstElementAppearance ? { firstElementAppearance } : {}),
  });

  return builtRegion(brief, elements, loot, coreElements);
}
