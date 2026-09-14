import { rect, polygon } from '../shape.ts';
import type { ElementTemplate } from './element.ts';
import type { ModuleKind, Vec2 } from '../types.ts';

/**
 * The element catalogue. A region generator draws from this rather than writing geometry inline, so
 * adding a structure means adding a template here instead of adding literals to a placement loop.
 *
 * Part order in every template is frozen: see the ordering note in `element.ts`.
 *
 * Two numbers constrain every interior below. A gladiator's body is radius 23 and the navigation
 * grid samples it at radius 25 every `TILE` (40) world units, so an internal opening narrower than
 * about 100 either refuses the larger role or samples as a wall and strands a bot behind it. And a
 * loot spot needs radius-24 clearance or the objectives stage silently drops it, which would leave a
 * building that `playability` requires to hold loot holding none. Openings here are 100; spots are
 * placed clear of every part by at least that margin.
 */

const WALL = 18;

/** The starting shelter: one room, two north windows, a south door. */
export const HUT: ElementTemplate = {
  w: 250,
  h: 250,
  encloses: true,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 65, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(65, 0, 60, WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(125, 0, 60, WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(185, 0, 65, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(0, WALL, WALL, 214), kind: 'building' },
    { part: 'obstacle', shape: rect(232, WALL, WALL, 214), kind: 'building' },
    { part: 'obstacle', shape: rect(0, 232, 75, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(175, 232, 75, WALL), kind: 'building' },
    { part: 'gate', x: 125, y: 241, w: 100, h: WALL },
    { part: 'spot', x: 125, y: 125 },
    { part: 'reserve', x: -30, y: -30, w: 310, h: 350 },
  ],
};

/**
 * Two rooms behind one door. The partition stops short of the south wall, so entering commits you to
 * a side without being able to see the other — the first structure where interior position matters.
 */
const LODGE: ElementTemplate = {
  w: 280,
  h: 250,
  encloses: true,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 55, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(55, 0, 60, WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(115, 0, 50, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(165, 0, 60, WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(225, 0, 55, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(0, WALL, WALL, 214), kind: 'building' },
    { part: 'obstacle', shape: rect(262, WALL, WALL, 214), kind: 'building' },
    { part: 'obstacle', shape: rect(0, 232, 90, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(190, 232, 90, WALL), kind: 'building' },
    // Partition, north wall down to 114 short of the south wall: a 100-unit way through.
    { part: 'obstacle', shape: rect(131, WALL, WALL, 114), kind: 'building' },
    { part: 'gate', x: 140, y: 241, w: 100, h: WALL },
    { part: 'spot', x: 70, y: 90 },
    { part: 'spot', x: 210, y: 90 },
    { part: 'reserve', x: -30, y: -30, w: 340, h: 350 },
  ],
};

/**
 * A depot hall: one wide window, and two interior blocks that break the sightline from the door to
 * the far wall, so the room has to be crossed rather than checked from the threshold.
 */
const WAREHOUSE: ElementTemplate = {
  w: 280,
  h: 260,
  encloses: true,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 80, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(80, 0, 120, WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(200, 0, 80, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(0, WALL, WALL, 224), kind: 'building' },
    { part: 'obstacle', shape: rect(262, WALL, WALL, 224), kind: 'building' },
    { part: 'obstacle', shape: rect(0, 242, 90, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(190, 242, 90, WALL), kind: 'building' },
    // Offset stacks, leaving a 70-unit central lane that both roles and the navigation grid fit.
    { part: 'obstacle', shape: rect(50, 100, 60, 60), kind: 'container' },
    { part: 'obstacle', shape: rect(180, 150, 60, 60), kind: 'container' },
    { part: 'gate', x: 140, y: 251, w: 100, h: WALL },
    { part: 'spot', x: 140, y: 65 },
    { part: 'reserve', x: -30, y: -30, w: 340, h: 360 },
  ],
};

/**
 * A roofless ruin: cover without concealment, and the catalogue's demonstration that a part need not
 * be axis aligned — the collapsed span is a convex polygon, solid to bodies, shots and sight alike.
 */
const RUIN: ElementTemplate = {
  w: 260,
  h: 230,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 200, WALL), kind: 'ruin-wall' },
    { part: 'obstacle', shape: rect(0, WALL, WALL, 120), kind: 'ruin-wall' },
    { part: 'obstacle', shape: polygon(150, 120, [{ x: 0, y: 0 }, { x: 87, y: 50 }, { x: 78, y: 66 }, { x: -9, y: 16 }]), kind: 'ruin-wall' },
    { part: 'obstacle', shape: rect(210, 150, 50, 60), kind: 'crate' },
    { part: 'spot', x: 110, y: 170 },
    { part: 'reserve', x: -20, y: -20, w: 300, h: 270 },
  ],
};

/**
 * A walled yard with a permanent breach rather than a door: loot in the open, but reaching it means
 * entering a space with one way out. Encloses nothing, so no roof hides what is inside it.
 */
const COMPOUND: ElementTemplate = {
  w: 280,
  h: 260,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 280, WALL), kind: 'ruin-wall' },
    { part: 'obstacle', shape: rect(0, WALL, WALL, 224), kind: 'ruin-wall' },
    { part: 'obstacle', shape: rect(262, WALL, WALL, 224), kind: 'ruin-wall' },
    { part: 'obstacle', shape: rect(0, 242, 90, WALL), kind: 'ruin-wall' },
    { part: 'obstacle', shape: rect(190, 242, 90, WALL), kind: 'ruin-wall' },
    { part: 'obstacle', shape: rect(50, 80, 60, 60), kind: 'crate' },
    { part: 'obstacle', shape: rect(180, 150, 60, 50), kind: 'crate' },
    { part: 'spot', x: 200, y: 70 },
    { part: 'reserve', x: -20, y: -20, w: 320, h: 300 },
  ],
};

// Integer points, so a stored map stays exact rather than carrying float noise no one reads.
const hexagon = (radius: number): Vec2[] =>
  Array.from({ length: 6 }, (_, i) => ({ x: Math.round(Math.cos(i * Math.PI / 3) * radius), y: Math.round(Math.sin(i * Math.PI / 3) * radius) }));

/** Yard cover: three stacks offset so none of them covers an approach on its own. */
const CRATE_CLUSTER: ElementTemplate = {
  w: 200,
  h: 170,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 70, 70), kind: 'crate' },
    { part: 'obstacle', shape: rect(95, 25, 60, 60), kind: 'crate' },
    { part: 'obstacle', shape: rect(40, 105, 80, 65), kind: 'crate' },
    { part: 'reserve', x: -10, y: -10, w: 220, h: 190 },
  ],
};

/**
 * Depot cover: two containers with a 40-unit slot between them. A contestant fits and a gladiator
 * does not, so it is one of the few places the size difference decides an engagement rather than a
 * route. Open at one end, so it is a nook and never a trap.
 */
const CONTAINER_ROW: ElementTemplate = {
  w: 220,
  h: 150,
  parts: [
    { part: 'obstacle', shape: rect(0, 0, 220, 55), kind: 'container' },
    { part: 'obstacle', shape: rect(0, 95, 160, 55), kind: 'container' },
    { part: 'reserve', x: -10, y: -10, w: 240, h: 170 },
  ],
};

/** Garden cover: overgrowth, whose rounded stumps are the catalogue's only non-rectangular cover. */
const THICKET: ElementTemplate = {
  w: 190,
  h: 160,
  parts: [
    { part: 'obstacle', shape: polygon(45, 45, hexagon(40)), kind: 'crate' },
    { part: 'obstacle', shape: polygon(140, 62, hexagon(32)), kind: 'crate' },
    { part: 'obstacle', shape: polygon(80, 122, hexagon(35)), kind: 'crate' },
    { part: 'reserve', x: -10, y: -10, w: 210, h: 180 },
  ],
};

/**
 * The cover a region scatters between its structures. Props were a single randomly sized box
 * whatever the region was, so a yard and a garden differed only in the colour of that box.
 */
export const REGION_PROPS: Record<ModuleKind, ElementTemplate> = {
  yard: CRATE_CLUSTER,
  depot: CONTAINER_ROW,
  garden: THICKET,
};

/**
 * What each region type builds from. A block's module kind picks the set and the seeded draw picks
 * the element, so a yard and a depot read as different places rather than the same block reskinned.
 * Every set keeps at least one enclosing structure, because indoor loot is where cells concentrate.
 */
export const REGION_ELEMENTS: Record<ModuleKind, ElementTemplate[]> = {
  yard: [HUT, COMPOUND],
  depot: [WAREHOUSE, HUT],
  garden: [RUIN, LODGE],
};
