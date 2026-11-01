import { rect } from '../../../shared/shape.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { createBuilderCanvas } from '../canvas.ts';
import { createRegionMask, elementShapes } from '../geometry.ts';
import { MARKET_STALL } from '../placeables/market-stall.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { draw, rng } from '../random.ts';
import { builtRegion } from '../result.ts';
import type { BuiltRegion, RegionBrief } from '../types.ts';
import type { BuildingAppearance } from '../../../shared/types.ts';
import { cellLoot, protectedRoutes, unfilledRegion } from './scatter.ts';

const AISLE = CELL_SCALE.doorway;
const DEPTH = 2;
const CHANNEL = { cross: 1, loot: 2 };

/**
 * Authored minimal appearance descriptors for civic market stalls (11.1 §5.2, §5.5, 41.2 Step 5).
 * Three visual decay tiers:
 * - `MARKET_STALL_INTACT`: Vibrant awnings-yellow fabric awning, oxidized metal counter, clean plaza paving.
 * - `MARKET_STALL_WEATHERED`: Weathered coral fabric awning, storefront-teal rim, dusty stucco counter, drainage stains.
 * - `MARKET_STALL_DAMAGED`: Dirty cream torn awning, old sign red rim, cool concrete counter, drainage stain and scorch marks.
 */
export const MARKET_STALL_INTACT: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'oxidizedMetal',
  roofPaint: 'awningsYellow',
  roofRim: 'weatheredCoral',
  interiorTrim: 'awningsYellow',
});

export const MARKET_STALL_WEATHERED: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'dustyStucco',
  roofPaint: 'weatheredCoral',
  roofRim: 'storefrontTeal',
  interiorTrim: 'weatheredCoral',
  neglect: {
    roofDrainStain: { dx: 18, dy: 10, w: 22, h: 14 },
  },
});

export const MARKET_STALL_DAMAGED: BuildingAppearance = Object.freeze({
  floorMaterial: 'slatePaving',
  wallMaterial: 'coolConcrete',
  roofPaint: 'dirtyCream',
  roofRim: 'oldSignRed',
  interiorTrim: 'oldSignRed',
  neglect: {
    roofDrainStain: { dx: 18, dy: 10, w: 24, h: 14 },
    scorchMark: { dx: 22, dy: 12, w: 30, h: 18 },
  },
});

export const MARKET_STALL_PRESETS: readonly BuildingAppearance[] = Object.freeze([
  MARKET_STALL_INTACT,
  MARKET_STALL_WEATHERED,
  MARKET_STALL_DAMAGED,
]);

export interface MarketStallAppearanceOptions {
  seed?: number | undefined;
  roll?: number | undefined;
  length?: number | undefined;
  alongX?: boolean | undefined;
}

/**
 * Procedural appearance generator for civic market stalls across intact, weathered, and
 * competition-damaged visual decay tiers (11.1 §5.5, 41.2 Step 5).
 */
export function createMarketStallAppearance(options: MarketStallAppearanceOptions = {}): BuildingAppearance {
  const roll = options.roll ?? (options.seed !== undefined ? rng(options.seed, 'stall-tier').next() : 0);
  const tier = roll < 0.4 ? 'intact' : roll < 0.75 ? 'weathered' : 'damaged';
  const base = tier === 'intact'
    ? MARKET_STALL_INTACT
    : tier === 'weathered'
      ? MARKET_STALL_WEATHERED
      : MARKET_STALL_DAMAGED;

  if (tier === 'intact') {
    return {
      floorMaterial: base.floorMaterial,
      wallMaterial: base.wallMaterial,
      roofPaint: base.roofPaint,
      roofRim: base.roofRim,
      interiorTrim: base.interiorTrim,
    };
  }

  const subRng = rng(options.seed ?? Math.floor(roll * 2 ** 31), 'stall-wear');
  if (tier === 'weathered') {
    return {
      floorMaterial: base.floorMaterial,
      wallMaterial: base.wallMaterial,
      roofPaint: base.roofPaint,
      roofRim: base.roofRim,
      interiorTrim: base.interiorTrim,
      neglect: {
        roofDrainStain: {
          dx: Math.round(14 + subRng.next() * 12),
          dy: Math.round(8 + subRng.next() * 8),
          w: Math.round(20 + subRng.next() * 8),
          h: Math.round(12 + subRng.next() * 6),
        },
      },
    };
  }

  return {
    floorMaterial: base.floorMaterial,
    wallMaterial: base.wallMaterial,
    roofPaint: base.roofPaint,
    roofRim: base.roofRim,
    interiorTrim: base.interiorTrim,
    neglect: {
      roofDrainStain: {
        dx: Math.round(14 + subRng.next() * 12),
        dy: Math.round(8 + subRng.next() * 8),
        w: Math.round(22 + subRng.next() * 8),
        h: Math.round(12 + subRng.next() * 6),
      },
      scorchMark: {
        dx: Math.round(18 + subRng.next() * 14),
        dy: Math.round(10 + subRng.next() * 8),
        w: Math.round(26 + subRng.next() * 10),
        h: Math.round(16 + subRng.next() * 8),
      },
    },
  };
}

/** Market rows cover the whole mask, leaving two-cell lanes and periodic wider cross-lanes. */
export function buildMarket(brief: RegionBrief): BuiltRegion {
  const spacing = brief.parameters?.spacing ?? 6;
  if (typeof spacing !== 'number' || !Number.isInteger(spacing) || spacing < 4)
    throw new RangeError('Market spacing must be a whole number of cells, at least 4.');
  const roofed = brief.parameters?.roofed ?? true;
  if (typeof roofed !== 'boolean') throw new TypeError('Market roofed must be true or false.');
  const canvas = createBuilderCanvas(brief, protectedRoutes(brief, 'Market', 'nearby'));
  if (!canvas.fill.cells.length) return unfilledRegion(brief, CHANNEL.loot);
  const size = brief.cellSize, bounds = createRegionMask(brief).bounds;
  const alongX = bounds.w >= bounds.h, length = Math.min(4, spacing - AISLE);
  const [u0, v0, width, height] = alongX
    ? [bounds.x / size, bounds.y / size, bounds.w / size, bounds.h / size]
    : [bounds.y / size, bounds.x / size, bounds.h / size, bounds.w / size];
  // Center complete slots inside the bypass band, rather than wasting the outer
  // row on candidates that cannot possibly retain their ring at the boundary.
  const columns = Math.max(0, Math.floor((width - 2 * AISLE - length) / spacing) + 1);
  const rows = Math.max(0, Math.floor((height - 2 * AISLE - DEPTH) / (DEPTH + AISLE)) + 1);
  const startU = u0 + Math.floor((width - (columns - 1) * spacing - length) / 2);
  const startV = v0 + Math.floor((height - (rows - 1) * (DEPTH + AISLE) - DEPTH) / 2);
  const cross = Math.floor(draw(brief.seed, 0, 0, CHANNEL.cross) * 4);
  let stalls = 0;
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    // The same skipped column across all rows makes a cross-lane, rather than isolated holes.
    if (columns >= 4 && (col + cross) % 4 === 3) continue;
    const u = startU + col * spacing, v = startV + row * (DEPTH + AISLE);
    const [x, y, w, h] = alongX ? [u, v, length, DEPTH] : [v, u, DEPTH, length];
    const footprint = rect(x * size, y * size, w * size, h * size);
    // The full bypass ring prevents a stall closing a neck or trapping a side pocket,
    // including one-portal markets where a portal tree alone protects no local circulation.
    if (!canvas.access.contains(rect((x - AISLE) * size, (y - AISLE) * size,
      (w + 2 * AISLE) * size, (h + 2 * AISLE) * size))
      || !canvas.fits(footprint) || !canvas.spaced(footprint, AISLE * size)) continue;
    const stallSeed = Math.floor(rng(brief.seed, `${brief.id}:stall-appearance:${col}:${row}`).next() * 2 ** 31);
    const stallApp = createMarketStallAppearance({ seed: stallSeed, length, alongX });
    const stall = expectPlaced(MARKET_STALL.build({ length, alongX, flipped: row % 2 === 1, roofed, appearance: stallApp }, size));
    if (!canvas.commit({ elements: placedElements(stall, `market-stall-${++stalls}`, x, y, size) }))
      throw new Error('Market stall failed its canvas commit.');
  }
  if (!stalls) return unfilledRegion(brief, CHANNEL.loot);
  const elements = [...canvas.elements];

  // Civic market entries and plaza pavers (11.1 §5.5, 41.2 Step 5):
  const first = elements[0];
  if (first) {
    const entryW = Math.max(36, Math.min(100, bounds.w * 0.4));
    const entryH = 20;
    const entryX = bounds.x + Math.round((bounds.w - entryW) / 2);
    const entryY = bounds.y + 8;
    first.template.appearance = {
      ...first.template.appearance,
      surfaces: [
        {
          id: `${brief.id}:plaza-pavers`,
          bounds: { x: bounds.x - first.x, y: bounds.y - first.y, w: bounds.w, h: bounds.h },
          material: 'slatePaving',
          weathered: true,
          segmentSpan: 160,
        },
      ],
      commercial: [
        {
          id: `${brief.id}:market-entry`,
          kind: 'sign-panel',
          bounds: { x: entryX - first.x, y: entryY - first.y, w: entryW, h: entryH },
          color: 'storefrontTeal',
        },
      ],
    };
  }

  const loot = cellLoot(brief, createRegionMask(brief), elements.flatMap(e => elementShapes(e, true)), CHANNEL.loot);
  return builtRegion(brief, elements, loot, [], { stalls, awnings: roofed ? stalls : 0 });
}
