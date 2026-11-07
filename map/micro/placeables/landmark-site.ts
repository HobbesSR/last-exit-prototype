import { rect } from '../../../shared/shape.ts';
import { allocateBuilding } from '../building/allocation.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign } from '../building/design.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingRealization } from '../building/realize.ts';
import type { Box, BuildingAppearance } from '../../../shared/types.ts';
import type { Cell } from '../../kernel/cell.ts';
import type { Placeable, PlacedElement } from './placeable.ts';

/*
 * `landmark-site`: a block-scale landmark built as a building design, allocated and realized
 * (56, 11.1 §8, #769). `landmark` sites it. Three silhouettes are authored, each a distinct
 * roof contour rather than a colour: an L-plan roadside gas station with a pump forecourt, a
 * comb-plan collapsed parking deck whose bays open south, and a notched-plan ruined roadside
 * restaurant. Collision and sight are ordinary building geometry: doors, open former
 * storefronts and exterior walls, never a new destruction vocabulary.
 */

/** Wall thickness, in cells. */
const WALL = 0.25;
/** A hunter fits a 2 × 2 block of cells. */
const BODY = 2;

export const LANDMARK_KINDS = ['gas-station', 'collapsed-parking', 'ruined-restaurant'] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

export const GAS_STATION_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'concrete',
  wallMaterial: 'coolConcrete',
  roofPaint: 'motelTurquoise',
  roofRim: 'electricTurquoise',
  interiorTrim: 'motelTurquoise',
  roofSign: { color: 'electricTurquoise', backing: 'structuralVoid', stripe: 'sodiumAmber', dx: 16, dy: 14, w: 176, h: 22 },
  neglect: {
    fadedPanel: { dx: 20, dy: 60, w: 120, h: 44 },
    roofDrainStain: { dx: 120, dy: 40, w: 52, h: 32 },
    floorStain: { dx: 100, dy: 120, w: 72, h: 44 },
  },
});

export const COLLAPSED_PARKING_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'concrete',
  wallMaterial: 'coolConcrete',
  roofPaint: 'coolConcrete',
  roofRim: 'structuralVoid',
  interiorTrim: 'coolConcrete',
  roofSign: { color: 'oldAdvertBlue', backing: 'structuralVoid', stripe: 'dirtyCream', dx: 24, dy: 18, w: 152, h: 22 },
  neglect: {
    scorchMark: { dx: 220, dy: 120, w: 96, h: 64 },
    floorStain: { dx: 160, dy: 200, w: 80, h: 52 },
    roofDrainStain: { dx: 90, dy: 50, w: 48, h: 30 },
  },
});

export const RUINED_RESTAURANT_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'warmMasonry',
  wallMaterial: 'dustyStucco',
  roofPaint: 'oldSignRed',
  roofRim: 'weatheredCoral',
  interiorTrim: 'oldSignRed',
  roofSign: { color: 'oldSignRed', backing: 'structuralVoid', stripe: 'dirtyCream', dx: 24, dy: 18, w: 168, h: 26 },
  neglect: {
    fadedPanel: { dx: 28, dy: 70, w: 104, h: 48 },
    roofDrainStain: { dx: 220, dy: 46, w: 56, h: 34 },
    floorStain: { dx: 120, dy: 150, w: 80, h: 52 },
    scorchMark: { dx: 100, dy: 190, w: 96, h: 64 },
  },
});

const APPEARANCE: Readonly<Record<LandmarkKind, BuildingAppearance>> = Object.freeze({
  'gas-station': GAS_STATION_APPEARANCE,
  'collapsed-parking': COLLAPSED_PARKING_APPEARANCE,
  'ruined-restaurant': RUINED_RESTAURANT_APPEARANCE,
});

const box = (x: number, y: number, w: number, h: number): Cell[] =>
  Array.from({ length: w * h }, (_, i) => ({ x: x + (i % w), y: y + Math.floor(i / w) }));

/** One authored silhouette: its envelope, footprint, design and allocation on a local grid. */
interface LandmarkPlan {
  w: number;
  h: number;
  design: BuildingDesign;
  /** Authored allocation for a plan the guillotine search cannot partition, such as a comb. */
  allocation?: BuildingAllocation;
  /** Extra elements outside the building footprint, in cells local to the envelope. */
  props?: readonly { name: string; x: number; y: number; w: number; h: number }[];
}

/** An L-plan kiosk: a 6 × 4 shop over a 3 × 3 service bay, with two pump islands and a forecourt. */
const GAS_STATION: LandmarkPlan = {
  w: 8,
  h: 7,
  design: {
    spaces: [
      { id: 'shop', area: { min: 9, max: 24 }, outside: 'prefer' },
      { id: 'bay', area: { min: 9, max: 9 }, outside: 'any' },
    ],
    connections: [
      { id: 'shop-door', a: 'shop', b: OUTSIDE, kind: 'door', side: 'N' },
      { id: 'shop-bay', a: 'shop', b: 'bay', kind: 'open' },
      { id: 'bay-mouth', a: 'bay', b: OUTSIDE, kind: 'open', side: 'S' },
    ],
  },
  props: [
    { name: 'pump-n', x: 6.3, y: 1.2, w: 1.2, h: 0.8 },
    { name: 'pump-s', x: 6.3, y: 4.6, w: 1.2, h: 0.8 },
  ],
};

/** A comb-plan deck: an 11 × 3 back span over three 3 × 3 bays that open south. */
const COLLAPSED_PARKING: LandmarkPlan = {
  w: 11,
  h: 6,
  design: {
    spaces: [
      { id: 'deck', area: { min: 9, max: 33 } },
      { id: 'bay-1', area: { min: 9, max: 9 }, outside: 'any' },
      { id: 'bay-2', area: { min: 9, max: 9 }, outside: 'any' },
      { id: 'bay-3', area: { min: 9, max: 9 }, outside: 'any' },
    ],
    connections: [
      { id: 'ramp-1', a: 'deck', b: 'bay-1', kind: 'open' },
      { id: 'ramp-2', a: 'deck', b: 'bay-2', kind: 'open' },
      { id: 'ramp-3', a: 'deck', b: 'bay-3', kind: 'open' },
      { id: 'mouth-1', a: 'bay-1', b: OUTSIDE, kind: 'open', side: 'S' },
      { id: 'mouth-2', a: 'bay-2', b: OUTSIDE, kind: 'open', side: 'S' },
      { id: 'mouth-3', a: 'bay-3', b: OUTSIDE, kind: 'open', side: 'S' },
      { id: 'deck-door', a: 'deck', b: OUTSIDE, kind: 'door', side: 'W' },
    ],
  },
  // The bays are 3 × 3 rooms, but the guillotine search cannot cover a comb; this layout is the
  // allocation, as `compound`'s ring is (56, L5).
  allocation: {
    footprint: [...box(0, 0, 11, 3), ...box(0, 3, 3, 3), ...box(4, 3, 3, 3), ...box(8, 3, 3, 3)],
    spaces: [
      { id: 'deck', cells: box(0, 0, 11, 3) },
      { id: 'bay-1', cells: box(0, 3, 3, 3) },
      { id: 'bay-2', cells: box(4, 3, 3, 3) },
      { id: 'bay-3', cells: box(8, 3, 3, 3) },
    ],
  },
};

/** A 10 × 6 block with its south-west corner missing: a wide former storefront and a kitchen wing. */
const RUINED_RESTAURANT: LandmarkPlan = {
  w: 10,
  h: 6,
  design: {
    spaces: [
      { id: 'dining', area: { min: 9, max: 30 }, outside: 'prefer' },
      { id: 'kitchen', area: { min: 9, max: 32 }, outside: 'prefer' },
    ],
    connections: [
      { id: 'storefront', a: 'dining', b: OUTSIDE, kind: 'open', side: 'S' },
      { id: 'front-door', a: 'dining', b: OUTSIDE, kind: 'door', side: 'E' },
      { id: 'pass', a: 'dining', b: 'kitchen', kind: 'open' },
      { id: 'service-door', a: 'kitchen', b: OUTSIDE, kind: 'door', side: 'N' },
    ],
  },
};

const PLANS: Readonly<Record<LandmarkKind, LandmarkPlan>> = Object.freeze({
  'gas-station': GAS_STATION,
  'collapsed-parking': COLLAPSED_PARKING,
  'ruined-restaurant': RUINED_RESTAURANT,
});

/** Which envelope side a realized outside door stands on, from its run against the footprint bounds. */
function doorSide(door: BuildingRealization['openings'][number], w: number, h: number): 'N' | 'E' | 'S' | 'W' | undefined {
  const { run } = door;
  if (run.axis === 'h') return run.y === 0 ? 'N' : run.y === h ? 'S' : undefined;
  return run.x === 0 ? 'W' : run.x === w ? 'E' : undefined;
}

/** The 2 × 2 doorstep blocks outside every outside door, as boxes outside the envelope. */
function doorsteps(realization: BuildingRealization, w: number, h: number): Box[] {
  const clear: Box[] = [];
  for (const door of realization.openings) {
    if (door.kind !== 'door' || (door.a !== OUTSIDE && door.b !== OUTSIDE)) continue;
    const side = doorSide(door, w, h);
    // A fixed design's door is on the envelope it was authored against.
    if (!side) throw new Error(`A landmark door stands off its envelope: ${door.connectionId}`);
    const start = (door.run.axis === 'h' ? door.run.x : door.run.y) + door.center - BODY / 2;
    clear.push(doorstepBox(side, [...new Set([Math.floor(start), Math.ceil(start)])], w, h));
  }
  return clear;
}

/** The doorstep's cells outside a `w` × `h` envelope's door side, covering every block at `starts`. */
function doorstepBox(side: 'N' | 'E' | 'S' | 'W', starts: readonly number[], w: number, h: number): Box {
  const from = Math.min(...starts), span = Math.max(...starts) - from + BODY;
  return side === 'N' ? { x: from, y: -BODY, w: span, h: BODY } : side === 'S' ? { x: from, y: h, w: span, h: BODY }
    : side === 'W' ? { x: -BODY, y: from, w: BODY, h: span } : { x: w, y: from, w: BODY, h: span };
}

export type LandmarkDetails = {
  kind: LandmarkKind;
  design: BuildingDesign;
  allocation: BuildingAllocation;
  realization: BuildingRealization;
};

export interface LandmarkSiteParams {
  kind: LandmarkKind;
  /** Seeds the allocation of plans the search partitions; a fixed layout ignores it. */
  seed: number;
  /** Optional presentation appearance descriptor (29.4, 41.2, 52). */
  appearance?: BuildingAppearance | undefined;
}

export const LANDMARK_SITE = Object.freeze<Placeable<LandmarkSiteParams, LandmarkDetails>>({
  id: 'landmark-site',
  version: 'landmark-site-1',
  summary: 'A block-scale landmark (gas station, collapsed parking deck or ruined restaurant) built through the building pipeline.',
  params: [
    { name: 'kind', summary: 'Which landmark silhouette.', kind: 'enum', values: LANDMARK_KINDS },
    { name: 'seed', summary: 'Allocation seed.', kind: 'int', min: 0, max: 2 ** 31 - 1 },
  ],
  examples: [
    { kind: 'gas-station', seed: 3 },
    { kind: 'collapsed-parking', seed: 5 },
    { kind: 'ruined-restaurant', seed: 7 },
  ],
  build({ kind, seed, appearance }: LandmarkSiteParams, cellSize: number) {
    const plan = PLANS[kind], cells = plan.allocation?.footprint
      ?? (kind === 'gas-station' ? [...box(0, 0, 6, 4), ...box(0, 4, 3, 3)] : box(0, 0, plan.w, plan.h).filter(c => !(c.x < 2 && c.y >= 4)));
    let design = plan.design, allocation = plan.allocation;
    if (!allocation) {
      const allocated = allocateBuilding(design, cells, { seed });
      if (!allocated.ok) return { refused: `no ${kind} allocation fits its ${plan.w} × ${plan.h} envelope` };
      design = allocated.design;
      allocation = allocated.allocation;
    }
    const realization = realizeBuilding(design, allocation, {
      cellSize,
      thickness: WALL,
      encloses: false,
      roofed: design.spaces.map(space => space.id),
      exteriorOrder: ['N', 'E', 'S', 'W'],
      corners: 'horizontal',
      appearance: appearance ?? APPEARANCE[kind],
    });
    if (!realization.template || realization.issues.length) throw new Error(`${kind} cannot be realized: ${realization.issues.join(' ')}`);
    // A fixed design that loses an asked opening is a defect, not a new fallback.
    if (realization.misses.length) throw new Error(`${kind} missed an opening: ${realization.misses.map(miss => miss.connectionId).join(', ')}`);

    const clear = doorsteps(realization, plan.w, plan.h);

    const elements: PlacedElement[] = [{ x: 0, y: 0, template: realization.template }];
    for (const prop of plan.props ?? []) elements.push({
      name: prop.name, x: prop.x * cellSize, y: prop.y * cellSize,
      template: {
        w: prop.w * cellSize, h: prop.h * cellSize,
        parts: [{ part: 'obstacle' as const, kind: 'container' as const,
          shape: rect(0, 0, prop.w * cellSize, prop.h * cellSize),
          appearance: { material: 'oxidizedMetal', focalRim: { side: 'S' as const, color: 'sodiumAmber' } } }],
      },
    });
    return {
      elements,
      demand: { body: { w: plan.w, h: plan.h }, clear },
      details: { kind, design, allocation, realization },
    };
  },
});
