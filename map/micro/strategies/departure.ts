import { circle } from '../../../shared/shape.ts';
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
 * Authored minimal appearance descriptors for `departure` extraction thresholds & hunter launch apparatus (11.1 §5.2, §5.5, 54).
 * Contrasts civic evacuation thresholds (`sodiumAmber`, `coolConcrete`, `dirtyCream`) with imposed
 * hunter insertion rigs (`showtimeMagenta`, `hazardRed`, scorch marks).
 */
export const DEPARTURE_EXIT_INTACT: BuildingAppearance = Object.freeze({
  floorMaterial: 'coolConcrete',
  wallMaterial: 'oxidizedMetal',
  roofPaint: 'oldAdvertBlue',
  roofRim: 'sodiumAmber',
  interiorTrim: 'sodiumAmber',
  roofSign: {
    color: 'sodiumAmber',
    backing: 'structuralVoid',
    stripe: 'dirtyCream',
    dx: 18,
    dy: 12,
    w: 76,
    h: 18,
  },
});

export const DEPARTURE_EXIT_WEATHERED: BuildingAppearance = Object.freeze({
  floorMaterial: 'coolConcrete',
  wallMaterial: 'oxidizedMetal',
  roofPaint: 'slateShadow',
  roofRim: 'weatheredCoral',
  interiorTrim: 'sodiumAmber',
  neglect: {
    fadedPanel: { dx: 20, dy: 28, w: 48, h: 22 },
    roofDrainStain: { dx: 74, dy: 22, w: 30, h: 18 },
  },
});

export const DEPARTURE_EXIT_DAMAGED: BuildingAppearance = Object.freeze({
  floorMaterial: 'asphalt',
  wallMaterial: 'coolConcrete',
  roofPaint: 'dirtyCream',
  roofRim: 'oldSignRed',
  interiorTrim: 'oldSignRed',
  neglect: {
    fadedPanel: { dx: 18, dy: 26, w: 44, h: 20 },
    roofDrainStain: { dx: 70, dy: 22, w: 28, h: 18 },
    floorStain: { dx: 52, dy: 42, w: 34, h: 22 },
    scorchMark: { dx: 40, dy: 48, w: 48, h: 30 },
  },
});

export const DEPARTURE_EXIT_PRESETS: readonly [BuildingAppearance, BuildingAppearance, BuildingAppearance] = Object.freeze([
  DEPARTURE_EXIT_INTACT,
  DEPARTURE_EXIT_WEATHERED,
  DEPARTURE_EXIT_DAMAGED,
]);

export const DEPARTURE_CIVIC_COVER_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'coolConcrete',
  weathered: true,
  focalRim: { side: 'N' as const, color: 'sodiumAmber' },
});

export const DEPARTURE_HUNTER_RIG_APPEARANCE: ObstacleAppearance = Object.freeze({
  material: 'oxidizedMetal',
  weathered: true,
  focalRim: { side: 'S' as const, color: 'showtimeMagenta' },
});

export function createDepartureFacilityAppearance(options: TieredAppearanceOptions = {}): BuildingAppearance {
  return createTieredBuildingAppearance(options, {
    presets: DEPARTURE_EXIT_PRESETS,
    thresholds: [0.3, 0.65],
    tierChannel: 'departure-tier',
  });
}

/** Proposed (54): hunters start at least one tile, 6 cells, from every exit. */
const SET_BACK = 6;

function cellsParameter(brief: RegionBrief, name: string): number | undefined {
  const value = brief.parameters?.[name];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
    throw new RangeError(`Region ${brief.id}: departure ${name} must be a positive number of cells.`);
  return value;
}

/**
 * The `departure` region type (54): where contestants extract and hunters start. It has no
 * decomposer yet, and takes its region whole.
 *
 * Exits are spread first, farthest-first, so they sit as far apart as the region allows;
 * `exitSpacing` (cells) is only a floor. They may share one corridor (17 M13). Then every
 * hunter's spawn is spread over what lies at least `setBack` cells from every exit, so the
 * hunt begins as a pursuit. Each site is reachable from the first portal. A region that can't
 * hold them all sites fewer, and the report names the shortfall (51 stage 8). Cover and loot
 * fill around them as in `arrival`.
 */
export function buildDeparture(brief: RegionBrief): BuiltRegion {
  const size = brief.cellSize, { clearance } = microMetrics({ cellSize: size, bodyProfile: 'cell' });
  const exitSpacing = cellsParameter(brief, 'exitSpacing') ?? 0, setBack = (cellsParameter(brief, 'setBack') ?? SET_BACK) * size;
  const mask = createRegionMask(brief);
  const accessMask = createAccessMask(brief);
  const root = portalStands(brief).find(portal => portal.points.length)?.points[0];
  const anchor = root ? { anchor: root } : {};

  const exits = spreadPoints(mask, { count: brief.coreElements?.exit ?? 0, radius: clearance.contestant, seed: brief.seed, accessMask,
    minimumSpacing: Math.max(clearance.contestant * 2, exitSpacing * size), ...anchor }).points;
  // A hunter's disc touching this ring's disc has its centre exactly `setBack` from the exit.
  // The ring never shrinks below a contestant, so no hunter stands on an exit.
  const ring = Math.max(setBack - clearance.hunter, clearance.contestant);
  const hunters = spreadPoints(mask, { count: brief.coreElements?.['hunter-spawn'] ?? 0, radius: clearance.hunter, seed: brief.seed, accessMask,
    reservations: exits.map(exit => circle(exit.x, exit.y, ring)), ...anchor }).points;

  const coreElements = [
    ...exits.map(point => ({ kind: 'exit' as const, ...point })),
    ...hunters.map(point => ({ kind: 'hunter-spawn' as const, ...point })),
  ];
  const firstExit = exits[0];
  const firstHunter = hunters[0];
  const firstElementAppearance = (firstExit || firstHunter) ? (piece: { x: number; y: number }): ElementAppearance => {
    const exitBounds = firstExit ? {
      x: Math.round(firstExit.x - size * 1.5 - piece.x),
      y: Math.round(firstExit.y - size * 1.5 - piece.y),
      w: size * 3,
      h: size * 3,
    } : undefined;
    const hunterBounds = firstHunter ? {
      x: Math.round(firstHunter.x - size - piece.x),
      y: Math.round(firstHunter.y - size - piece.y),
      w: size * 2,
      h: size * 2,
    } : undefined;
    return {
      ...(exitBounds ? {
        surfaces: [{
          id: `${brief.id}:departure-threshold`,
          bounds: exitBounds,
          material: 'coolConcrete',
          weathered: true,
          segmentSpan: 120,
        }],
        commercial: [{
          id: `${brief.id}:departure-stripes`,
          kind: 'parking-stripes',
          bounds: exitBounds,
          color: 'sodiumAmber',
          count: 3,
        }],
      } : {}),
      ...(hunterBounds ? {
        scars: [{
          id: `${brief.id}:hunter-launch-scorch`,
          kind: 'scorch-group',
          bounds: hunterBounds,
        }],
        lighting: {
          fields: [{
            id: `${brief.id}:hunter-launch-wash`,
            bounds: hunterBounds,
            tint: 'showtimeMagenta',
            intensity: 0.45,
          }],
        },
      } : {}),
    };
  } : undefined;
  const { elements, loot } = coverAround(brief, [
    ...exits.map(point => ({ ...point, radius: clearance.contestant })),
    ...hunters.map(point => ({ ...point, radius: clearance.hunter })),
  ], root, {
    pieceAppearance: (_piece, index) => index % 2 === 0 ? DEPARTURE_CIVIC_COVER_APPEARANCE : DEPARTURE_HUNTER_RIG_APPEARANCE,
    ...(firstElementAppearance ? { firstElementAppearance } : {}),
  });

  return builtRegion(brief, elements, loot, coreElements);
}
