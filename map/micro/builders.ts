import { polygon, rect } from '../../shape.ts';
import { microMetrics } from './metrics.ts';
import type { Shape } from '../../shape.ts';
import type { Box, Vec2 } from '../../types.ts';
import type { ElementTemplate } from '../element.ts';
import type { BuilderContext, BuilderId, RegionBuilder, RegionRandom } from './types.ts';

const WALL = 18;

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const densityOf = (context: BuilderContext): number => clamp(context.spec.parameters?.density ?? .55, 0, 1);
const roomCellsOf = (context: BuilderContext): number => clamp(Math.round(context.spec.parameters?.roomCells ?? 6), 4, 12);
const decayOf = (context: BuilderContext): number => clamp(context.spec.parameters?.decay ?? .35, 0, 1);

/** A roofed room with a south doorway wide enough for the navigation grid and both player roles. */
function roomTemplate(w: number, h: number, shelves: boolean, door: number): ElementTemplate {
  const DOOR = door;
  const doorX = Math.round(w / 2);
  const left = Math.round((w - DOOR) / 2);
  const parts: ElementTemplate['parts'] = [
    { part: 'obstacle', shape: rect(0, 0, Math.round(w * .28), WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(Math.round(w * .28), 0, Math.round(w * .3), WALL), kind: 'window' },
    { part: 'obstacle', shape: rect(Math.round(w * .58), 0, w - Math.round(w * .58), WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(0, WALL, WALL, h - WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(w - WALL, WALL, WALL, h - WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(0, h - WALL, left, WALL), kind: 'building' },
    { part: 'obstacle', shape: rect(left + DOOR, h - WALL, w - left - DOOR, WALL), kind: 'building' },
    { part: 'gate', x: doorX, y: h - WALL / 2, w: DOOR, h: WALL },
    { part: 'spot', x: Math.round(w * .28), y: Math.round(h * .35) },
    { part: 'spot', x: Math.round(w * .72), y: Math.round(h * .58) },
  ];
  if (shelves) {
    // Aisles remain at least 105 wide from the walls and doorway approach.
    const leftShelfH = Math.max(36, h - 176), rightShelfH = Math.max(36, h - 206);
    parts.splice(7, 0,
      { part: 'obstacle', shape: rect(58, 82, 46, leftShelfH), kind: 'container' },
      { part: 'obstacle', shape: rect(w - 104, 112, 46, rightShelfH), kind: 'container' });
  }
  return { w, h, encloses: true, parts };
}

const pickAnchors = (context: BuilderContext, widthCells: number, heightCells: number, random: RegionRandom): Box[] =>
  random.shuffle(context.mask.rectangles(widthCells, heightCells));

const randomAnchor = (box: Box, w: number, h: number, random: RegionRandom): Vec2 => ({
  x: box.x + random.int(0, Math.max(0, Math.round(box.w - w))),
  y: box.y + random.int(0, Math.max(0, Math.round(box.h - h))),
});

function offerRoomLoot(context: BuilderContext, x: number, y: number, w: number, h: number): void {
  context.loot(x + Math.round(w * .28), y + Math.round(h * .35));
  context.loot(x + Math.round(w * .72), y + Math.round(h * .58));
}

function placeRooms(context: BuilderContext, label: string, count: number, shelves: boolean, channel: string): number {
  const random = context.random(channel);
  const cells = roomCellsOf(context);
  const w = clamp(cells * context.spec.cellSize + 40, 220, 430);
  const h = clamp(Math.round(w * .78), 200, 330);
  const anchors = pickAnchors(context, Math.ceil(w / context.spec.cellSize), Math.ceil(h / context.spec.cellSize), random);
  let placed = 0;
  for (const box of anchors.slice(0, 100)) {
    if (placed >= count) break;
    const point = randomAnchor(box, w, h, random);
    if (context.element(`${label}-${placed + 1}`, roomTemplate(w, h, shelves, microMetrics(context.spec).doorway), point.x, point.y)) {
      offerRoomLoot(context, point.x, point.y, w, h);
      placed++;
    }
  }
  return placed;
}

function placeCover(context: BuilderContext, label: string, count: number, channel: string): void {
  const random = context.random(channel);
  const cells = roomCellsOf(context);
  const size = clamp(Math.round(context.spec.cellSize * (1.1 + cells / 16)), 48, 92);
  const boxes = pickAnchors(context, 2, 2, random);
  for (let i = 0; i < Math.min(count, 100); i++) {
    const box = boxes[i % Math.max(1, boxes.length)];
    if (!box) return;
    const point = randomAnchor(box, size, size, random);
    context.obstacle(`${label}-${i + 1}`, rect(point.x, point.y, size, Math.round(size * random.int(65, 110) / 100)), i % 3 ? 'crate' : 'container');
  }
}

/** Sparse cover and one or two shelters: sightlines survive while the region is not featureless. */
const open: RegionBuilder = context => {
  const density = densityOf(context);
  const rooms = density < .22 ? 1 : density < .72 ? 2 : 3;
  placeRooms(context, 'open-shelter', rooms, false, 'open-rooms');
  placeCover(context, 'open-cover', Math.max(3, Math.round(4 + density * 10)), 'open-cover');
};

/** Warehouses use interior shelves and exterior container rows, making depot routes read differently from open ground. */
const depot: RegionBuilder = context => {
  const density = densityOf(context);
  const rooms = density < .35 ? 1 : density < .75 ? 2 : 3;
  placeRooms(context, 'depot-warehouse', rooms, true, 'depot-warehouses');
  const random = context.random('depot-aisles');
  const width = clamp(Math.round(context.spec.cellSize * 3.5), 110, 190);
  const boxes = pickAnchors(context, 4, 2, random);
  for (let i = 0; i < Math.min(100, Math.round(3 + density * 8)); i++) {
    const box = boxes[i % Math.max(1, boxes.length)];
    if (!box) break;
    const point = randomAnchor(box, width, 34, random);
    context.obstacle(`depot-shelf-${i + 1}`, rect(point.x, point.y, width, 34), 'container');
  }
};

/** Rooms form a loose ring. The centre is deliberately never proposed as a structure candidate. */
const courtyard: RegionBuilder = context => {
  const density = densityOf(context);
  const random = context.random('courtyard-ring');
  const bounds = context.mask.bounds;
  const centre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  const cells = roomCellsOf(context);
  const w = clamp(cells * context.spec.cellSize + 20, 220, 400);
  const h = clamp(Math.round(w * .74), 200, 310);
  const candidates = pickAnchors(context, Math.ceil(w / context.spec.cellSize), Math.ceil(h / context.spec.cellSize), random)
    .filter(box => {
      const x = box.x + box.w / 2, y = box.y + box.h / 2;
      // Large rooms only have a top or bottom anchor in a 24x18 preview.  Keep those outer bands
      // eligible while still leaving the centre clear for the courtyard and protected cross-route.
      return Math.abs(x - centre.x) > w * .6 || Math.abs(y - centre.y) > h * .55;
    });
  const target = density < .3 ? 2 : density < .7 ? 3 : 4;
  let placed = 0;
  for (const box of candidates.slice(0, 100)) {
    if (placed === target) break;
    const point = randomAnchor(box, w, h, random);
    if (context.element(`courtyard-room-${placed + 1}`, roomTemplate(w, h, false, microMetrics(context.spec).doorway), point.x, point.y)) {
      offerRoomLoot(context, point.x, point.y, w, h);
      placed++;
    }
  }
  // The clear centre gets a little movable-feeling cover only at high density, never a roof or wall ring.
  if (density > .65) placeCover(context, 'courtyard-planter', 2, 'courtyard-planters');
};

const debris = (x: number, y: number, size: number, random: RegionRandom): Shape => {
  const angle = random.next() * Math.PI * 2;
  const long = size * (1.1 + random.next() * .7), wide = size * (.24 + random.next() * .18);
  const points = [{ x: -long / 2, y: -wide / 2 }, { x: long / 2, y: -wide / 2 }, { x: long / 2, y: wide / 2 }, { x: -long / 2, y: wide / 2 }]
    .map(point => ({ x: Math.round(point.x * Math.cos(angle) - point.y * Math.sin(angle)), y: Math.round(point.x * Math.sin(angle) + point.y * Math.cos(angle)) }));
  return polygon(x, y, points);
};

/** Roofless, discontinuous walls and rotated convex collapsed spans leave several ways through every ruin. */
const ruins: RegionBuilder = context => {
  const density = densityOf(context), decay = decayOf(context);
  const random = context.random('ruins-fragments');
  const size = clamp(Math.round(context.spec.cellSize * roomCellsOf(context) * .38), 80, 180);
  const boxes = pickAnchors(context, 2, 2, random);
  // Decay deliberately changes the composition, rather than merely tinting the same
  // arrangement: intact spans become smaller rotated rubble and collapsed sites add scatter.
  const total = Math.min(100, Math.max(5, Math.round(7 + density * 12 + decay * 5)));
  for (let i = 0; i < total; i++) {
    const box = boxes[i % Math.max(1, boxes.length)];
    if (!box) break;
    const point = randomAnchor(box, size, size, random);
    const broken = i < Math.round(total * decay);
    const shape = broken ? debris(point.x + size / 2, point.y + size / 2, size * (.5 + random.next() * .35), random) : rect(point.x, point.y, size, WALL);
    if (context.obstacle(`ruin-${broken ? 'debris' : 'wall'}-${i + 1}`, shape, 'ruin-wall') && i % 3 === 0) {
      context.loot(point.x + size / 2, point.y + size / 2 + 42);
    }
  }
};

// Entry areas use the shared spacing primitive after geometry has been resolved.
export const BUILDERS: Record<BuilderId, RegionBuilder> = { open, depot, courtyard, ruins, entry: () => {} };
