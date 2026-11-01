import { rect } from '../../../shared/shape.ts';
import type { ElementPart } from '../../../shared/map/element.ts';
import type { BuildingAppearance } from '../../../shared/types.ts';
import type { Placeable } from './placeable.ts';

/*
 * `landmark-collapsed-parking`: a multi-bay concrete parking structure footprint with perimeter
 * barriers, interior columns, and a central collapsed roof void (11.1 §3.3, §8).
 */

export interface LandmarkCollapsedParkingParams {
  w: number;
  h: number;
  appearance?: BuildingAppearance | undefined;
}

export const COLLAPSED_PARKING_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'concrete',
  wallMaterial: 'coolConcrete',
  roofPaint: 'coolConcrete',
  roofRim: 'structuralVoid',
  interiorTrim: 'coolConcrete',
  roofSign: {
    color: 'oldAdvertBlue',
    backing: 'structuralVoid',
    stripe: 'dirtyCream',
    dx: 24,
    dy: 14,
    w: 72,
    h: 18,
  },
  neglect: {
    scorchMark: { dx: 140, dy: 140, w: 72, h: 48 },
    floorStain: { dx: 120, dy: 160, w: 56, h: 36 },
    roofDrainStain: { dx: 60, dy: 40, w: 32, h: 22 },
  },
});

export const LANDMARK_COLLAPSED_PARKING = Object.freeze<Placeable<LandmarkCollapsedParkingParams>>({
  id: 'landmark-collapsed-parking',
  version: 'landmark-collapsed-parking-1',
  summary: 'A collapsed multi-bay parking deck with central void.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'int', min: 6, max: 16 },
    { name: 'h', summary: 'Height in cells.', kind: 'int', min: 6, max: 16 },
  ],
  examples: [
    { w: 8, h: 8 },
    { w: 10, h: 8 },
  ],
  build({ w, h, appearance = COLLAPSED_PARKING_APPEARANCE }: LandmarkCollapsedParkingParams, cellSize: number) {
    const wallThick = 0.25 * cellSize;
    const parts: ElementPart[] = [
      // North wall (with ramp opening on east)
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(0, 0, (w - 2) * cellSize, wallThick) },
      // South wall
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(0, h * cellSize - wallThick, w * cellSize, wallThick) },
      // West wall
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(0, 0, wallThick, h * cellSize) },
      // East wall (with ramp opening on north)
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(w * cellSize - wallThick, 2 * cellSize, wallThick, (h - 2) * cellSize) },
      // Structural column 1
      { part: 'obstacle' as const, kind: 'container' as const, shape: rect(2 * cellSize, 2 * cellSize, 0.8 * cellSize, 0.8 * cellSize), appearance: { material: 'coolConcrete' } },
      // Structural column 2
      { part: 'obstacle' as const, kind: 'container' as const, shape: rect((w - 2.8) * cellSize, 2 * cellSize, 0.8 * cellSize, 0.8 * cellSize), appearance: { material: 'coolConcrete' } },
      // Structural column 3
      { part: 'obstacle' as const, kind: 'container' as const, shape: rect(2 * cellSize, (h - 2.8) * cellSize, 0.8 * cellSize, 0.8 * cellSize), appearance: { material: 'coolConcrete' } },
      // Structural column 4
      { part: 'obstacle' as const, kind: 'container' as const, shape: rect((w - 2.8) * cellSize, (h - 2.8) * cellSize, 0.8 * cellSize, 0.8 * cellSize), appearance: { material: 'coolConcrete' } },
    ];

    // Collapsed roof: perimeter ring of cells only, leaving the central cells as a collapsed void
    const roofCells = [];
    const minCenter = 2;
    const maxCenterX = w - 2;
    const maxCenterY = h - 2;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const isCentralVoid = x >= minCenter && x < maxCenterX && y >= minCenter && y < maxCenterY;
        if (!isCentralVoid) {
          roofCells.push({ x, y });
        }
      }
    }

    const roofs = [
      { id: 'parking-deck-roof', cellSize, cells: roofCells, bounds: { x: 0, y: 0, w: w * cellSize, h: h * cellSize }, appearance },
    ];

    const commercial = [
      {
        id: 'parking-stalls-west',
        kind: 'parking-stripes' as const,
        bounds: { x: 0.5 * cellSize, y: 0.5 * cellSize, w: 1.5 * cellSize, h: (h - 1) * cellSize },
        color: 'awningsYellow',
        count: 4,
      },
      {
        id: 'parking-stalls-east',
        kind: 'parking-stripes' as const,
        bounds: { x: (w - 2) * cellSize, y: 2.5 * cellSize, w: 1.5 * cellSize, h: (h - 3) * cellSize },
        color: 'awningsYellow',
        count: 3,
      },
    ];

    const scars = [
      {
        id: 'collapse-scorch',
        kind: 'scorch-group' as const,
        bounds: { x: minCenter * cellSize, y: minCenter * cellSize, w: (maxCenterX - minCenter) * cellSize, h: (maxCenterY - minCenter) * cellSize },
      },
    ];

    return {
      elements: [
        {
          x: 0,
          y: 0,
          template: {
            w: w * cellSize,
            h: h * cellSize,
            encloses: true,
            parts,
            roofs,
            appearance: {
              building: appearance,
              commercial,
              scars,
            },
          },
        },
      ],
      demand: { body: { w, h }, clear: [] },
      details: undefined,
    };
  },
});
