/**
 * Service frontage / corner shop building adopter and step-2 appearance descriptors (41.2 Step 3 / #584).
 * Adopts the minimal optional appearance descriptor on a retail frontage and service building,
 * keeping collision geometry, portals, sight, navigation, and simulation RNG/IDs 100% unchanged.
 */

import { OUTSIDE } from './design.ts';
import type { BuildingAllocation, BuildingDesign, BuildingSide } from './design.ts';
import { realizeBuilding } from './realize.ts';
import type { BuildingRealization } from './realize.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type {
  Box,
  BuildingAppearance,
  MapAppearance,
} from '../../../shared/types.ts';

const WALL = 0.25;
const SIDES: readonly BuildingSide[] = ['N', 'E', 'S', 'W'];

/**
 * Authored minimal appearance descriptor for the corner retail shop / service frontage (41.2 step 2/3).
 * Uses documented swatches:
 * - warm masonry floor & walls (`warmMasonry`)
 * - legacy-teal painted roof (`storefrontTeal`) with weathered coral rim (`weatheredCoral`)
 * - storefront interior trim (`storefrontTeal`)
 * - commercial roof signage (`weatheredCoral` on `structuralVoid` with `dirtyCream` stripe)
 * - long-term neglect (`fadedPanel`, `roofDrainStain`, `floorStain`)
 */
export const RETAIL_FRONTAGE_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'warmMasonry',
  wallMaterial: 'warmMasonry',
  roofPaint: 'storefrontTeal',
  roofRim: 'weatheredCoral',
  interiorTrim: 'storefrontTeal',
  roofSign: {
    color: 'weatheredCoral',
    backing: 'structuralVoid',
    stripe: 'dirtyCream',
    dx: 28,
    dy: 16,
    w: 120,
    h: 24,
  },
  neglect: {
    fadedPanel: { dx: 30, dy: 52, w: 88, h: 42 },
    roofDrainStain: { dx: 170, dy: 42, w: 44, h: 28 },
    floorStain: { x: 965, y: 650, w: 46, h: 28 },
  },
});

/**
 * Minimal optional appearance descriptor for the complete step-2 retail frontage & service lane slice.
 * Contains only the seven fields consumed by the presentation resolver:
 * - `surfaces`: slate paving service apron
 * - `buildings`: retail frontage shop appearance
 * - `obstacles`: exposed north wall directional amber focal rim
 * - `commercial`: ochre parking stripes and weathered coral awning
 * - `wear`: lane faded panel and drain stain
 * - `scars`: cosmetic competition scorch group
 * - `lighting`: broad cobalt intersection wash and warm amber focal edge
 */
export const SERVICE_FRONTAGE_SLICE_APPEARANCE: MapAppearance = Object.freeze({
  surfaces: [
    { id: 'service-lane-apron', bounds: { x: 845, y: 495, w: 320, h: 60 }, material: 'slatePaving', weathered: true, curb: true },
  ],
  buildings: {
    'shop-room': RETAIL_FRONTAGE_APPEARANCE,
  },
  obstacles: {
    'shop-wall-n-mid': { focalRim: { side: 'N' as const, color: 'sodiumAmber' } },
    'shop-wall-n-east': { focalRim: { side: 'N' as const, color: 'sodiumAmber' } },
  },
  commercial: [
    { id: 'ochre-parking-stripes', kind: 'parking-stripes' as const, bounds: { x: 855, y: 498, w: 150, h: 36 }, color: 'awningsYellow', count: 3 },
    { id: 'coral-awning', kind: 'awning' as const, bounds: { x: 850, y: 536, w: 90, h: 18 }, color: 'weatheredCoral', stripeColor: 'dirtyCream' },
  ],
  wear: [
    { id: 'lane-faded-panel', kind: 'faded-panel' as const, bounds: { x: 1118, y: 502, w: 36, h: 22 }, color: 'storefrontTeal' },
    { id: 'lane-drain-stain', kind: 'drain-stain' as const, bounds: { x: 1070, y: 528, w: 36, h: 22 } },
  ],
  scars: [
    { id: 'service-scorch-group', kind: 'scorch-group' as const, bounds: { x: 1070, y: 502, w: 36, h: 22 } },
  ],
  lighting: {
    fields: [
      {
        id: 'cobalt-intersection',
        bounds: { x: 850, y: 365, w: 320, h: 185 },
        tint: 'cobaltBlue',
        intensity: 0.42,
        falloff: 0,
      },
      {
        id: 'amber-focal-edge',
        bounds: { x: 810, y: 540, w: 240, h: 48 },
        tint: 'sodiumAmber',
        intensity: 0.45,
        falloff: 0,
        focalEdge: {
          color: 'sodiumAmber',
          x: 810,
          y: 546,
          w: 240,
          h: 12,
          alpha: 0.34,
          rimLine: { x1: 812, y1: 553, x2: 1048, y2: 553, width: 3, alpha: 0.84 },
        },
      },
    ],
  },
});

export interface ServiceFrontageOptions {
  /** Width in cells (defaults to 6). */
  w?: number;
  /** Height in cells (defaults to 4). */
  h?: number;
  /** Primary frontage side with entrance door (defaults to 'N'). */
  door?: BuildingSide;
  /** Allocation seed (defaults to 0). */
  seed?: number;
  /**
   * Optional presentation appearance descriptor.
   * If omitted or undefined, uses neutral unstyled building presentation.
   */
  appearance?: BuildingAppearance | MapAppearance | undefined;
}

export interface ServiceFrontageResult {
  design: BuildingDesign;
  allocation: BuildingAllocation;
  realization: BuildingRealization;
  template: ElementTemplate;
  footprint: Box;
}

/**
 * Builds a service frontage / corner retail shop building using `realizeBuilding`.
 * Supports optional `appearance` parameter (e.g. `RETAIL_FRONTAGE_APPEARANCE` or `SERVICE_FRONTAGE_SLICE_APPEARANCE`).
 * When omitted or unknown values are used, falls back to neutral unstyled building appearance.
 * Leaves collision shapes, door placement, and navigation identical regardless of appearance.
 */
export function buildServiceFrontage(
  options: ServiceFrontageOptions = {},
  cellSize = 40,
): ServiceFrontageResult {
  const w = options.w ?? 6;
  const h = options.h ?? 4;
  const doorSide = options.door ?? 'N';
  const oppositeSide: BuildingSide = doorSide === 'N' ? 'S' : doorSide === 'S' ? 'N' : doorSide === 'W' ? 'E' : 'W';

  const cells = Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
  const design: BuildingDesign = {
    spaces: [
      { id: 'shop-floor', area: { min: w * h, max: w * h }, outside: 'prefer', tags: ['retail', 'frontage'] },
    ],
    connections: [
      { id: 'entrance', a: 'shop-floor', b: OUTSIDE, kind: 'door', side: doorSide },
      { id: 'storefront-window', a: 'shop-floor', b: OUTSIDE, kind: 'window', side: doorSide },
      { id: 'service-door', a: 'shop-floor', b: OUTSIDE, kind: 'door', side: oppositeSide },
    ],
  };

  const allocation: BuildingAllocation = {
    footprint: cells,
    spaces: [{ id: 'shop-floor', cells }],
  };

  const bDesc = options.appearance && 'buildings' in options.appearance
    ? (options.appearance.buildings?.main ?? options.appearance.buildings?.['shop-room'] ?? Object.values(options.appearance.buildings ?? {})[0])
    : (options.appearance as BuildingAppearance | undefined);

  const realization = realizeBuilding(design, allocation, {
    cellSize,
    thickness: WALL,
    encloses: true,
    exteriorOrder: SIDES,
    corners: 'horizontal',
    decalTheme: 'depot',
    ...(bDesc ? { appearance: bDesc } : {}),
  });

  if (!realization.template || realization.issues.length) {
    throw new Error(`Failed to realize service frontage building: ${realization.issues.join('; ')}`);
  }

  // If a full MapAppearance was passed, attach it to template so stamping propagates ground marks and lighting:
  if (options.appearance && 'surfaces' in options.appearance) {
    realization.template.appearance = structuredClone(options.appearance);
  }

  return {
    design,
    allocation,
    realization,
    template: realization.template,
    footprint: { x: 0, y: 0, w: w * cellSize, h: h * cellSize },
  };
}
