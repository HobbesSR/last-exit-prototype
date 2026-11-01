import type { BuildingAppearance, BuildingNeglectAppearance, BuildingRoofSignAppearance } from '../../../shared/types.ts';
import type { Side } from '../port-terms.ts';
import { rng } from '../random.ts';

export interface TieredAppearanceOptions {
  roll?: number | undefined;
  seed?: number | undefined;
  w?: number | undefined;
  h?: number | undefined;
  door?: Side | undefined;
}

export interface TieredAppearanceConfig {
  presets: readonly [BuildingAppearance, BuildingAppearance, BuildingAppearance];
  thresholds?: [number, number] | undefined;
  tierChannel?: string | undefined;
  subRngChannel?: ((bw: number, bh: number, door: Side | undefined) => string) | undefined;
  damagedSignScale?: number | undefined;
  doorAwarePanel?: boolean | undefined;
  weatheredFloorStainChance?: number | undefined;
}

/**
 * Places a building roof sign along the appropriate door frontage or edge, proportional to footprint.
 */
function placeFrontageSign(
  sign: BuildingRoofSignAppearance,
  bw: number,
  bh: number,
  door: Side | undefined,
  subRng: { next(): number },
  scale?: number
): BuildingRoofSignAppearance {
  let signW = Math.max(28, Math.min(bw - 24, Math.round(bw * (0.42 + subRng.next() * 0.18))));
  const signH = sign.h ?? 18;
  let signDx = Math.round(12 + subRng.next() * Math.max(0, bw - signW - 24));
  let signDy = 14;

  if (door === 'S') {
    signDy = Math.max(14, bh - signH - 14);
  } else if (door === 'N') {
    signDy = 14;
  } else if (door === 'W') {
    signDx = 14;
    signDy = Math.round(12 + subRng.next() * Math.max(0, bh - signH - 24));
  } else if (door === 'E') {
    signDx = Math.max(14, bw - signW - 14);
    signDy = Math.round(12 + subRng.next() * Math.max(0, bh - signH - 24));
  }

  if (scale !== undefined) {
    signW = Math.max(28, Math.round(signW * scale));
  }

  return {
    ...sign,
    dx: signDx,
    dy: signDy,
    w: signW,
    h: signH,
  };
}

/**
 * Shared procedural generator for tiered architectural kit appearances (intact, weathered, damaged)
 * across storefront, market stall, and compound perimeter building kits (11.1 §5.5, 41.2 Step 5, #586 / #585).
 * Enforces footprint-bounded, non-repeating wear and scorch placement.
 */
export function createTieredBuildingAppearance(
  options: TieredAppearanceOptions,
  config: TieredAppearanceConfig
): BuildingAppearance {
  const thresholds = config.thresholds ?? [0.33, 0.67];
  const channel = config.tierChannel ?? 'tier';
  const roll = options.roll ?? (options.seed !== undefined ? rng(options.seed, channel).next() : 0);
  const bw = Math.max(40, options.w ?? 160);
  const bh = Math.max(40, options.h ?? 160);
  const door = options.door ?? 'S';
  const subChannel = config.subRngChannel ? config.subRngChannel(bw, bh, door) : `${channel}:${bw}x${bh}`;
  const subRng = rng(options.seed ?? Math.floor(roll * 2 ** 31), subChannel);

  const tierIndex = roll < thresholds[0] ? 0 : roll < thresholds[1] ? 1 : 2;
  const tier = tierIndex === 0 ? 'intact' : tierIndex === 1 ? 'weathered' : 'damaged';
  const base = config.presets[tierIndex];

  if (tier === 'intact') {
    return {
      floorMaterial: base.floorMaterial,
      wallMaterial: base.wallMaterial,
      roofPaint: base.roofPaint,
      roofRim: base.roofRim,
      interiorTrim: base.interiorTrim,
      ...(base.roofSign ? { roofSign: placeFrontageSign(base.roofSign, bw, bh, door, subRng) } : {}),
    };
  }

  // Weathered / Damaged: scale and jitter neglect marks strictly within footprint bounds:
  const neglect: BuildingNeglectAppearance = {};

  if (base.neglect?.fadedPanel) {
    const maxW = Math.max(16, bw - 20);
    const maxH = Math.max(12, bh - 20);
    const panelW = Math.max(14, Math.min(maxW, Math.round(bw * (0.24 + subRng.next() * 0.16))));
    const panelH = Math.max(10, Math.min(maxH, Math.round(bh * (0.15 + subRng.next() * 0.12))));
    const panelDx = Math.round(8 + subRng.next() * Math.max(0, bw - panelW - 16));
    let panelDy = Math.round(8 + subRng.next() * Math.max(0, bh - panelH - 16));
    if (config.doorAwarePanel && door === 'S') {
      panelDy = Math.round(12 + subRng.next() * Math.max(0, bh * 0.45 - 12));
    }
    neglect.fadedPanel = {
      ...base.neglect.fadedPanel,
      dx: panelDx,
      dy: panelDy,
      w: panelW,
      h: panelH,
    };
  }

  if (base.neglect?.roofDrainStain) {
    const drainW = Math.max(14, Math.min(Math.round(bw * 0.3), base.neglect.roofDrainStain.w ?? 28));
    const drainH = Math.max(10, Math.min(Math.round(bh * 0.25), base.neglect.roofDrainStain.h ?? 18));
    const minX = Math.ceil(drainW / 2) + 6;
    const maxX = Math.max(minX, bw - Math.ceil(drainW / 2) - 6);
    const minY = Math.ceil(drainH / 2) + 6;
    const maxY = Math.max(minY, bh - Math.ceil(drainH / 2) - 6);
    neglect.roofDrainStain = {
      ...base.neglect.roofDrainStain,
      dx: Math.round(minX + subRng.next() * (maxX - minX)),
      dy: Math.round(minY + subRng.next() * (maxY - minY)),
      w: drainW,
      h: drainH,
    };
  }

  const shouldHaveFloorStain = base.neglect?.floorStain
    || (tier === 'weathered' && config.weatheredFloorStainChance !== undefined && subRng.next() < config.weatheredFloorStainChance);

  if (shouldHaveFloorStain) {
    const stainW = Math.max(16, Math.min(Math.round(bw * 0.28), base.neglect?.floorStain?.w ?? 32));
    const stainH = Math.max(12, Math.min(Math.round(bh * 0.22), base.neglect?.floorStain?.h ?? 22));
    const minX = Math.ceil(stainW / 2) + 8;
    const maxX = Math.max(minX, bw - Math.ceil(stainW / 2) - 8);
    const minY = Math.ceil(stainH / 2) + 8;
    const maxY = Math.max(minY, bh - Math.ceil(stainH / 2) - 8);
    neglect.floorStain = {
      ...(base.neglect?.floorStain ?? { dx: 0, dy: 0, w: stainW, h: stainH }),
      dx: Math.round(minX + subRng.next() * (maxX - minX)),
      dy: Math.round(minY + subRng.next() * (maxY - minY)),
      w: stainW,
      h: stainH,
    };
  }

  if (base.neglect?.scorchMark) {
    const scorchW = Math.max(20, Math.min(Math.round(bw * 0.35), base.neglect.scorchMark.w ?? 48));
    const scorchH = Math.max(14, Math.min(Math.round(bh * 0.25), base.neglect.scorchMark.h ?? 32));
    const minX = Math.ceil(scorchW / 2) + 8;
    const maxX = Math.max(minX, bw - Math.ceil(scorchW / 2) - 8);
    const minY = Math.ceil(scorchH / 2) + 8;
    const maxY = Math.max(minY, bh - Math.ceil(scorchH / 2) - 8);
    neglect.scorchMark = {
      ...base.neglect.scorchMark,
      dx: Math.round(minX + subRng.next() * (maxX - minX)),
      dy: Math.round(minY + subRng.next() * (maxY - minY)),
      w: scorchW,
      h: scorchH,
    };
  }

  if (base.neglect?.impactCrater) {
    const craterW = Math.max(16, Math.min(Math.round(bw * 0.28), base.neglect.impactCrater.w ?? 38));
    const craterH = Math.max(12, Math.min(Math.round(bh * 0.22), base.neglect.impactCrater.h ?? 28));
    const minX = Math.ceil(craterW / 2) + 8;
    const maxX = Math.max(minX, bw - Math.ceil(craterW / 2) - 8);
    const minY = Math.ceil(craterH / 2) + 8;
    const maxY = Math.max(minY, bh - Math.ceil(craterH / 2) - 8);
    neglect.impactCrater = {
      ...base.neglect.impactCrater,
      dx: Math.round(minX + subRng.next() * (maxX - minX)),
      dy: Math.round(minY + subRng.next() * (maxY - minY)),
      w: craterW,
      h: craterH,
    };
  }

  if (base.neglect?.vegetationEdge) {
    const vegW = Math.max(16, Math.min(Math.round(bw * 0.35), base.neglect.vegetationEdge.w ?? 44));
    const vegH = Math.max(10, Math.min(Math.round(bh * 0.16), base.neglect.vegetationEdge.h ?? 16));
    const minX = Math.ceil(vegW / 2) + 8;
    const maxX = Math.max(minX, bw - Math.ceil(vegW / 2) - 8);
    const minY = Math.ceil(vegH / 2) + 8;
    const maxY = Math.max(minY, bh - Math.ceil(vegH / 2) - 8);
    neglect.vegetationEdge = {
      ...base.neglect.vegetationEdge,
      dx: Math.round(minX + subRng.next() * (maxX - minX)),
      dy: Math.round(minY + subRng.next() * (maxY - minY)),
      w: vegW,
      h: vegH,
    };
  }

  const signScale = tier === 'damaged' ? config.damagedSignScale : undefined;

  return {
    floorMaterial: base.floorMaterial,
    wallMaterial: base.wallMaterial,
    roofPaint: base.roofPaint,
    roofRim: base.roofRim,
    interiorTrim: base.interiorTrim,
    ...(base.roofSign ? { roofSign: placeFrontageSign(base.roofSign, bw, bh, door, subRng, signScale) } : {}),
    ...(Object.keys(neglect).length > 0 ? { neglect } : {}),
  };
}
