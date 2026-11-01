import { rect } from '../../../shared/shape.ts';
import type { ElementPart } from '../../../shared/map/element.ts';
import type { BuildingAppearance } from '../../../shared/types.ts';
import type { Placeable } from './placeable.ts';

/*
 * `landmark-ruined-restaurant`: a roadside diner footprint with a front dining room, rear service
 * kitchen, drive-thru lane apron, and competition scars (11.1 §8).
 */

export interface LandmarkRuinedRestaurantParams {
  w: number;
  h: number;
  appearance?: BuildingAppearance | undefined;
}

export const RUINED_RESTAURANT_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'warmMasonry',
  wallMaterial: 'dustyStucco',
  roofPaint: 'oldSignRed',
  roofRim: 'weatheredCoral',
  interiorTrim: 'oldSignRed',
  roofSign: {
    color: 'oldSignRed',
    backing: 'structuralVoid',
    stripe: 'dirtyCream',
    dx: 20,
    dy: 12,
    w: 80,
    h: 22,
  },
  neglect: {
    fadedPanel: { dx: 24, dy: 36, w: 52, h: 24 },
    roofDrainStain: { dx: 110, dy: 30, w: 32, h: 20 },
    floorStain: { dx: 80, dy: 70, w: 40, h: 26 },
    scorchMark: { dx: 50, dy: 90, w: 48, h: 32 },
  },
});

export const LANDMARK_RUINED_RESTAURANT = Object.freeze<Placeable<LandmarkRuinedRestaurantParams>>({
  id: 'landmark-ruined-restaurant',
  version: 'landmark-ruined-restaurant-1',
  summary: 'A roadside diner with front dining room and rear service kitchen.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'int', min: 6, max: 14 },
    { name: 'h', summary: 'Height in cells.', kind: 'int', min: 4, max: 10 },
  ],
  examples: [
    { w: 8, h: 5 },
    { w: 10, h: 6 },
  ],
  build({ w, h, appearance = RUINED_RESTAURANT_APPEARANCE }: LandmarkRuinedRestaurantParams, cellSize: number) {
    const wallThick = 0.25 * cellSize;
    const splitX = Math.floor(w * 0.55);

    const parts: ElementPart[] = [
      // Outer North wall
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(0, 0, w * cellSize, wallThick) },
      // Outer South wall with front entrance gap in dining room (x: 1.5..3.5)
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(0, h * cellSize - wallThick, 1.5 * cellSize, wallThick) },
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(3.5 * cellSize, h * cellSize - wallThick, (w - 3.5) * cellSize, wallThick) },
      // Outer West wall
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(0, 0, wallThick, h * cellSize) },
      // Outer East wall with rear kitchen door gap (y: 1..2.5)
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(w * cellSize - wallThick, 0, wallThick, 1 * cellSize) },
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(w * cellSize - wallThick, 2.5 * cellSize, wallThick, (h - 2.5) * cellSize) },
      // Interior dividing wall between dining room and kitchen (with interior doorway at y: 1.5..3)
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(splitX * cellSize - wallThick / 2, 0, wallThick, 1.5 * cellSize) },
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(splitX * cellSize - wallThick / 2, 3 * cellSize, wallThick, (h - 3) * cellSize) },
      // Dining room front storefront window
      { part: 'obstacle' as const, kind: 'window' as const, shape: rect(0.4 * cellSize, h * cellSize - wallThick, (splitX - 0.8) * cellSize, wallThick) },
      // Service counter obstacle
      { part: 'obstacle' as const, kind: 'crate' as const, shape: rect((splitX - 1.2) * cellSize, 1 * cellSize, 0.8 * cellSize, (h - 2) * cellSize), appearance: { material: 'oxidizedMetal' } },
    ];

    const roofCells = [];
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) roofCells.push({ x, y });

    const roofs = [
      { id: 'restaurant-roof', cellSize, cells: roofCells, bounds: { x: 0, y: 0, w: w * cellSize, h: h * cellSize }, appearance },
    ];

    const surfaces = [
      {
        id: 'diner-drive-thru',
        bounds: { x: -0.5 * cellSize, y: -0.5 * cellSize, w: (w + 1) * cellSize, h: (h + 1) * cellSize },
        material: 'slatePaving',
        weathered: true,
      },
    ];

    const commercial = [
      {
        id: 'diner-awning',
        kind: 'awning' as const,
        bounds: { x: 0.5 * cellSize, y: h * cellSize - 4, w: (splitX - 1) * cellSize, h: 18 },
        color: 'weatheredCoral',
        stripeColor: 'dirtyCream',
      },
    ];

    const wear = [
      {
        id: 'diner-drain',
        kind: 'drain-stain' as const,
        bounds: { x: (w - 2) * cellSize, y: 0.5 * cellSize, w: 28, h: 20 },
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
              surfaces,
              commercial,
              wear,
            },
          },
        },
      ],
      demand: { body: { w, h }, clear: [] },
      details: undefined,
    };
  },
});
