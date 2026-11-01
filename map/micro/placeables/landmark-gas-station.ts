import { rect } from '../../../shared/shape.ts';
import type { ElementPart } from '../../../shared/map/element.ts';
import type { BuildingAppearance } from '../../../shared/types.ts';
import type { Placeable } from './placeable.ts';

/*
 * `landmark-gas-station`: a distinctive roadside gas station footprint with a service kiosk,
 * an extended fuel canopy, and pump islands (11.1 §8).
 */

export interface LandmarkGasStationParams {
  w: number;
  h: number;
  appearance?: BuildingAppearance | undefined;
}

export const GAS_STATION_APPEARANCE: BuildingAppearance = Object.freeze({
  floorMaterial: 'concrete',
  wallMaterial: 'coolConcrete',
  roofPaint: 'motelTurquoise',
  roofRim: 'electricTurquoise',
  interiorTrim: 'motelTurquoise',
  roofSign: {
    color: 'electricTurquoise',
    backing: 'structuralVoid',
    stripe: 'sodiumAmber',
    dx: 16,
    dy: 12,
    w: 64,
    h: 18,
  },
  neglect: {
    fadedPanel: { dx: 20, dy: 36, w: 44, h: 20 },
    roofDrainStain: { dx: 60, dy: 24, w: 26, h: 16 },
    floorStain: { dx: 50, dy: 60, w: 36, h: 22 },
  },
});

export const LANDMARK_GAS_STATION = Object.freeze<Placeable<LandmarkGasStationParams>>({
  id: 'landmark-gas-station',
  version: 'landmark-gas-station-1',
  summary: 'A roadside gas station with kiosk mini-mart and fuel pump canopy.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'int', min: 6, max: 16 },
    { name: 'h', summary: 'Height in cells.', kind: 'int', min: 4, max: 12 },
  ],
  examples: [
    { w: 8, h: 6 },
    { w: 10, h: 6 },
  ],
  build({ w, h, appearance = GAS_STATION_APPEARANCE }: LandmarkGasStationParams, cellSize: number) {
    const kw = Math.max(3, Math.floor(w * 0.45));
    const kh = Math.max(3, Math.floor(h * 0.55));
    const kx = 0;
    const ky = 0;
    const wallThick = 0.25 * cellSize;

    // Kiosk room walls, window, door
    const parts: ElementPart[] = [
      // Kiosk North wall
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(kx * cellSize, ky * cellSize, kw * cellSize, wallThick) },
      // Kiosk West wall
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(kx * cellSize, ky * cellSize, wallThick, kh * cellSize) },
      // Kiosk South wall (with doorway)
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect(kx * cellSize, (ky + kh) * cellSize - wallThick, (kw - 2) * cellSize, wallThick) },
      // Kiosk East wall
      { part: 'obstacle' as const, kind: 'building' as const, shape: rect((kx + kw) * cellSize - wallThick, ky * cellSize, wallThick, kh * cellSize) },
      // Front storefront window
      { part: 'obstacle' as const, kind: 'window' as const, shape: rect((kx + 0.6) * cellSize, (ky + kh) * cellSize - wallThick, (kw - 2.8) * cellSize, wallThick) },
      // Fuel pump island 1
      {
        part: 'obstacle' as const,
        kind: 'container' as const,
        shape: rect((kw + 1) * cellSize, 1.5 * cellSize, 2 * cellSize, 0.8 * cellSize),
        appearance: { material: 'oxidizedMetal', focalRim: { side: 'S' as const, color: 'sodiumAmber' } },
      },
      // Fuel pump island 2
      {
        part: 'obstacle' as const,
        kind: 'container' as const,
        shape: rect((kw + 1) * cellSize, (h - 2.3) * cellSize, 2 * cellSize, 0.8 * cellSize),
        appearance: { material: 'oxidizedMetal', focalRim: { side: 'S' as const, color: 'sodiumAmber' } },
      },
    ];

    // Roofs: kiosk enclosed roof + extended canopy roof
    const kioskCells = [];
    for (let x = 0; x < kw; x++) for (let y = 0; y < kh; y++) kioskCells.push({ x, y });

    const canopyCells = [];
    for (let x = kw; x < w; x++) for (let y = 1; y < h - 1; y++) canopyCells.push({ x, y });

    const roofs = [
      { id: 'kiosk-roof', cellSize, cells: kioskCells, bounds: { x: 0, y: 0, w: kw * cellSize, h: kh * cellSize }, appearance },
      { id: 'canopy-roof', cellSize, cells: canopyCells, bounds: { x: kw * cellSize, y: cellSize, w: (w - kw) * cellSize, h: (h - 2) * cellSize }, appearance },
    ];

    const surfaces = [
      {
        id: 'station-apron',
        bounds: { x: 0, y: 0, w: w * cellSize, h: h * cellSize },
        material: 'nightAsphalt',
        weathered: true,
      },
    ];

    const commercial = [
      {
        id: 'pump-stripes',
        kind: 'parking-stripes' as const,
        bounds: { x: (kw + 0.5) * cellSize, y: cellSize, w: 3 * cellSize, h: (h - 2) * cellSize },
        color: 'awningsYellow',
        count: 2,
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
            },
          },
        },
      ],
      demand: { body: { w, h }, clear: [] },
      details: undefined,
    };
  },
});
