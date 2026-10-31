import { OPPOSITE, type Side } from '../port-terms.ts';
import { allocateBuilding } from '../building/allocation.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingRealization } from '../building/realize.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign } from '../building/design.ts';
import type { Box, BuildingAppearance } from '../../../shared/types.ts';
import type { Placeable } from './placeable.ts';

/*
 * `house`: a roofed house of one to three spaces behind one outside door (56 L5). `hut` builds
 * its houses with it. It demands its doorstep, the hunter's 2 × 2 blocks outside the door.
 */

/** Wall thickness, in cells. */
const WALL = 0.25;
/** A hunter fits a 2 × 2 block of cells. */
const BODY = 2;
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];

export type HouseDetails = {
  design: BuildingDesign; allocation: BuildingAllocation; realization: BuildingRealization;
  /** Where the doorstep blocks start along the door's side, in the box's cells: one, or two where the door sits between cells. */
  steps: number[];
};

/** Where the doorstep blocks start along the door's side, in the box's cells: one, or two where the door sits between cells. */
function doorsteps(realization: BuildingRealization): number[] | undefined {
  const door = realization.openings.find(opening => opening.connectionId === 'door');
  if (!door) return undefined;
  const start = (door.run.axis === 'h' ? door.run.x : door.run.y) + door.center - BODY / 2;
  return [...new Set([Math.floor(start), Math.ceil(start)])];
}

const realized = (cellSize: number, appearance?: BuildingAppearance) => ({ cellSize, thickness: WALL, encloses: true, exteriorOrder: SIDES, corners: 'horizontal' as const, decalTheme: 'hut', ...(appearance ? { appearance } : {}) });

/**
 * The one-space house in its box's local world units: four walls, a door on `door`, and a
 * window on the opposite wall, each a doorway wide (52's worked case) and centred. It
 * encloses, so it has a roof.
 */
function house(size: number, door: Side, width: number, height: number, appearance?: BuildingAppearance): HouseDetails {
  const cells = Array.from({ length: width * height }, (_, i) => ({ x: i % width, y: Math.floor(i / width) }));
  const design: BuildingDesign = {
    spaces: [{ id: 'room', area: { min: width * height, max: width * height }, outside: 'prefer', tags: ['house'] }],
    connections: [
      { id: 'door', a: 'room', b: OUTSIDE, kind: 'door', side: door },
      { id: 'window', a: 'room', b: OUTSIDE, kind: 'window', side: OPPOSITE[door] },
    ],
  };
  const allocation = { footprint: cells, spaces: [{ id: 'room', cells }] };
  const realization = realizeBuilding(design, allocation, realized(size, appearance));
  // This fixed design always fits. A miss here is an implementation defect, not a new fallback.
  if (!realization.template || realization.issues.length || realization.misses.length) throw new Error('The fixed hut design could not be realized.');
  return { design, allocation, realization, steps: doorsteps(realization)! };
}

/**
 * A house of `spaces` spaces in a `w` × `h` box with its door on `side`, or nothing. The front
 * space holds the door and a window; each other space is asked for a door into the
 * front and a window. The allocation adds interior doors where the asked ones can't join every
 * space. A house whose outside door misses, or whose openings don't join every space, isn't
 * used: each space is reached through the one door. Missed windows and asked doors are
 * guidance, and stay as misses (M29).
 */
function larger(spaces: number, w: number, h: number, side: Side, size: number, seed: number, appearance?: BuildingAppearance): HouseDetails | undefined {
  const cells = Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
  const ids = Array.from({ length: spaces }, (_, i) => i ? `back-${i}` : 'front');
  const asked: BuildingDesign = {
    spaces: ids.map(id => ({ id, area: { min: 9, max: w * h }, outside: 'prefer' as const, tags: [id === 'front' ? 'entry' : 'room'] })),
    connections: [
      { id: 'door', a: 'front', b: OUTSIDE, kind: 'door', side },
      { id: 'window', a: 'front', b: OUTSIDE, kind: 'window' },
      ...ids.slice(1).flatMap((id, i) => [
        { id: `link-${i + 1}`, a: 'front', b: id, kind: 'door' as const },
        { id: `window-${i + 1}`, a: id, b: OUTSIDE, kind: 'window' as const },
      ]),
    ],
  };
  const allocated = allocateBuilding(asked, cells, { seed });
  if (!allocated.ok) return undefined;
  const { design, allocation } = allocated, realization = realizeBuilding(design, allocation, realized(size, appearance));
  const steps = doorsteps(realization);
  if (!realization.template || realization.issues.length || !steps) return undefined;
  const reached = new Set(['front']);
  for (let grown = true; grown;) {
    grown = false;
    for (const { kind, a, b } of realization.openings) {
      if (kind === 'window' || a === OUTSIDE || b === OUTSIDE || reached.has(a) === reached.has(b)) continue;
      reached.add(a); reached.add(b); grown = true;
    }
  }
  return reached.size === spaces ? { design, allocation, realization, steps } : undefined;
}

/** The doorstep's cells outside a `w` × `h` box's `side`, covering every block that starts at one of `steps`. */
function doorstep(side: Side, steps: readonly number[], w: number, h: number): Box {
  const from = Math.min(...steps), span = Math.max(...steps) - from + BODY;
  return side === 'N' ? { x: from, y: -BODY, w: span, h: BODY } : side === 'S' ? { x: from, y: h, w: span, h: BODY }
    : side === 'W' ? { x: -BODY, y: from, w: BODY, h: span } : { x: w, y: from, w: BODY, h: span };
}

export interface HouseParams {
  /** The box in cells. */
  w: number;
  h: number;
  /** The side its one outside door is on. */
  door: Side;
  /** One to three spaces. One is a single room with a window facing the door. */
  spaces: number;
  /** Seeds the allocation of a house with several spaces. One space ignores it. */
  seed: number;
  /** Optional presentation appearance descriptor (29.4, 41.2, 52). */
  appearance?: BuildingAppearance | undefined;
}

export const HOUSE = Object.freeze<Placeable<HouseParams, HouseDetails>>({
  id: 'house',
  version: 'house-1',
  summary: 'A roofed house of one to three spaces behind one outside door, demanding its doorstep.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'int', min: 3, max: 12 },
    { name: 'h', summary: 'Height in cells.', kind: 'int', min: 3, max: 12 },
    { name: 'door', summary: 'Side of the outside door.', kind: 'enum', values: SIDES },
    { name: 'spaces', summary: 'Number of spaces.', kind: 'int', min: 1, max: 3 },
    { name: 'seed', summary: 'Allocation seed for several spaces.', kind: 'int', min: 0, max: 2 ** 31 - 1 },
  ],
  // Rooms are at least 3 × 3 (56).
  check: ({ w, h, spaces }: HouseParams) => w * h < 9 * spaces ? [`A house of ${spaces} spaces needs at least ${9 * spaces} cells.`] : [],
  examples: [
    { w: 4, h: 4, door: 'S', spaces: 1, seed: 0 },
    { w: 3, h: 3, door: 'E', spaces: 1, seed: 0 },
    { w: 6, h: 4, door: 'N', spaces: 2, seed: 5 },
    { w: 8, h: 6, door: 'W', spaces: 3, seed: 11 },
  ],
  build({ w, h, door, spaces, seed, appearance }: HouseParams, cellSize: number) {
    const details = spaces === 1 ? house(cellSize, door, w, h, appearance) : larger(spaces, w, h, door, cellSize, seed, appearance);
    if (!details) return { refused: `no ${spaces}-space house fits ${w} × ${h} with its door on ${door}` };
    return { elements: [{ x: 0, y: 0, template: details.realization.template! }],
      demand: { body: { w, h }, clear: [doorstep(door, details.steps, w, h)] }, details };
  },
});
