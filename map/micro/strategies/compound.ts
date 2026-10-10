import { largestRectangle } from './hall.ts';
import { unfilledRegion, cellLoot, draw } from './scatter.ts';
import { createAccessMask, createFillMask, createRegionMask, elementShapes } from '../geometry.ts';
import { boxesAgainstHints } from '../hints.ts';
import { portalStands } from '../portals.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign } from '../building/design.ts';
import { splitBuilding } from '../building/pieces.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingObserver } from '../building/trace.ts';
import type { Shape } from '../../../shared/shape.ts';
import type { BuiltRegion, RegionBrief, RegionElement } from '../types.ts';

/** The catalogue's proposed shape need (54): the compound at least this many cells a side, so its court is at least 4. */
const MIN_SIDE = 10;
/** The compound's sides are capped, so an enormous region holds one compound in a wide yard. */
const MAX_SIDE = 24;
/** How deep the ring of rooms is, in cells: a hunter fits inside, between quarter-cell walls. */
const DEPTH = 3;
/** The least length of a room along its side, in cells, and the range a side's rooms aim for. */
const MIN_ROOM = 3, MAX_ROOM = 5;
const MIN_GATES = 1, MAX_GATES = 4, DEFAULT_GATES = 2;
/** Wall thickness, in cells, as `hut`'s are. */
const WALL = 0.25;
/** A gate's passage through the ring: a doorway (52). */
const PASSAGE = CELL_SCALE.doorway;

type Side = 'N' | 'E' | 'S' | 'W';
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Per-side draw channels, so no choice shifts another. */
const CHANNEL = { offset: 1, gateSide: 2, gateAt: 3, room: 4, loot: 5 };

/** A box in the compound's own cells. */
interface Box { x: number; y: number; w: number; h: number }

/** Keep the yard's portal blocks joined and leave a reachable doorstep at each chosen gate. */
function siteCompound(brief: RegionBrief, mask: ReturnType<typeof createRegionMask>, accessMask: ReturnType<typeof createRegionMask>, space: Box, gates: number):
  (Box & { gated: Set<Side> }) | undefined {
  const key = (x: number, y: number) => `${x},${y}`;
  const entrances: { x: number; y: number }[] = [];
  // Each entrance block straddles its portal's seam, in the clear margin on both sides (20.6).
  for (const { portal: { axis, x, y, length } } of portalStands(brief)) {
    for (let i = 0; i + 2 <= length; i++) {
      entrances.push(axis === 'h' ? { x: x + i, y: y - 1 } : { x: x - 1, y: y + i });
    }
  }
  const gateOrder = [...SIDES].map((side, i) => ({ side, order: draw(brief.seed, i, 0, CHANNEL.gateSide) }))
    .sort((a, b) => a.order - b.order).map(v => v.side);
  const sizes: [number, number][] = [];
  // Keep as much of the designed ring as the yard allows. Each step removes one cell
  // from each side, enough to open a new hunter-width route without exhaustive sizes.
  for (let w = Math.min(space.w, MAX_SIDE), h = Math.min(space.h, MAX_SIDE);
    w >= MIN_SIDE && h >= MIN_SIDE; w -= 2, h -= 2) sizes.push([w, h]);
  if (!sizes.some(([w, h]) => w === MIN_SIDE && h === MIN_SIDE)) sizes.push([MIN_SIDE, MIN_SIDE]);
  for (const [w, h] of sizes) {
    if (w < MIN_SIDE || h < MIN_SIDE) continue;
    const seen = new Set<string>(), sites: Box[] = [];
    const add = (x: number, y: number) => {
      if (seen.has(key(x, y))) return;
      seen.add(key(x, y)); sites.push({ x, y, w, h });
    };
    // Hints take priority. A few deterministic interior positions cover a large field without
    // searching every placement; a small yard can afford its complete set of positions.
    const hinted = boxesAgainstHints(brief, w, h)
      .sort((a, b) => draw(brief.seed, a.x, a.y, CHANNEL.offset) - draw(brief.seed, b.x, b.y, CHANNEL.offset))
      .slice(0, 16);
    for (const b of hinted) add(b.x, b.y);
    const nx = space.w - w + 1, ny = space.h - h + 1;
    add(space.x + Math.floor((nx - 1) / 2), space.y + Math.floor((ny - 1) / 2));
    const preferred = sites.length;
    if (nx <= 20 && ny <= 20) {
      for (let y = space.y; y < space.y + ny; y++) for (let x = space.x; x < space.x + nx; x++) add(x, y);
    } else {
      for (let i = 0; i < 12; i++) add(space.x + Math.floor(draw(brief.seed, i, 0, CHANNEL.offset) * nx),
        space.y + Math.floor(draw(brief.seed, i, 1, CHANNEL.offset) * ny));
    }
    // Limit probes on a small yard too; the centered site and the hinted sites
    // precede the seeded alternatives.
    if (nx <= 20 && ny <= 20) {
      sites.splice(preferred, sites.length - preferred, ...sites.slice(preferred).sort((a, b) =>
        draw(brief.seed, a.x, a.y, CHANNEL.offset) - draw(brief.seed, b.x, b.y, CHANNEL.offset)));
      sites.length = Math.min(sites.length, preferred + 64);
    }
    for (const box of sites) {
      const inside = (x: number, y: number) => x >= box.x && x < box.x + w && y >= box.y && y < box.y + h;
      let valid = true;
      for (let y = box.y; y < box.y + h && valid; y++) for (let x = box.x; x < box.x + w; x++)
        if (!mask.has(x, y)) { valid = false; break; }
      if (!valid) continue;
      const fits = (x: number, y: number) => !inside(x, y) && !inside(x + 1, y) && !inside(x, y + 1) && !inside(x + 1, y + 1)
        && accessMask.has(x, y) && accessMask.has(x + 1, y) && accessMask.has(x, y + 1) && accessMask.has(x + 1, y + 1);
      // A gate needs a two-cell yard stand at its actual passage. Reject sites
      // without enough such sides before walking the yard, the costly check.
      const gateSteps = gateOrder.map(side => {
        const middle = (side === 'N' || side === 'S' ? w : h) - 2 * DEPTH;
        let a = Math.floor(draw(brief.seed, SIDES.indexOf(side), 1, CHANNEL.gateAt) * (middle - PASSAGE + 1));
        let b = a + PASSAGE;
        if (a < MIN_ROOM) a = 0;
        if (middle - b < MIN_ROOM) b = middle;
        const steps: string[] = [];
        for (let t = a; t + 2 <= b; t++) {
          const x = side === 'W' ? box.x - 2 : side === 'E' ? box.x + w : box.x + DEPTH + t;
          const y = side === 'N' ? box.y - 2 : side === 'S' ? box.y + h : box.y + DEPTH + t;
          if (fits(x, y)) steps.push(key(x, y));
        }
        return { side, steps };
      }).filter(v => v.steps.length);
      if (gateSteps.length < gates) continue;
      const start = entrances[0] ?? accessMask.cells.find(c => fits(c.x, c.y));
      if (!start || !fits(start.x, start.y)) continue;
      // This flood belongs only to this candidate box: each node is an owned 2x2
      // hunter stand outside it, and adjacent nodes sweep an owned 2x3 rectangle.
      // Sharing that reached set among portals and gate steps is safe while the box
      // is fixed; the next candidate recomputes it instead of reusing yard evidence.
      const reached = new Set([key(start.x, start.y)]), queue = [start];
      for (let head = 0; head < queue.length; head++) {
        const { x, y } = queue[head]!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy, k = key(nx, ny);
          if (reached.has(k) || !fits(nx, ny)) continue;
          reached.add(k); queue.push({ x: nx, y: ny });
        }
      }
      if (entrances.some(e => !reached.has(key(e.x, e.y)))) continue;
      const accessible = gateSteps.filter(v => v.steps.some(step => reached.has(step))).map(v => v.side);
      if (accessible.length >= gates) return { ...box, gated: new Set(accessible.slice(0, gates)) };
    }
  }
  return undefined;
}

/**
 * The `compound` region type (54): rooms in a ring around a walled court, with a few gates.
 * A pocket that rewards a contestant who knows its gates and traps one who doesn't. It has no
 * decomposer.
 *
 * One compound stands in a contained rectangle, capped at `MAX_SIDE`, with a connected yard
 * and accessible gates. Its outer edge is the back wall of a ring of roofed
 * rooms `DEPTH` cells deep, with a square room at each corner. Each side's rooms open
 * onto the court. Each corner room opens only into its neighbour along the north or south
 * side, a room or a passage, so it is a dead end. `gates` sides, drawn from the seed, have a passage through the ring from a gate
 * in the outer wall to the court.
 *
 * The ring is one building design (56 L5): its rooms and passages are spaces over the ring's
 * cells, and the layout above is their allocation, since `allocateBuilding`'s guillotine search
 * can't partition a ring. Walls between spaces are built once. A passage is kept clear, so the
 * walls it shares stand in the rooms and it stays a doorway wide, and it lies open to the court
 * along its whole length. `splitBuilding` makes each space its own element, and each room its
 * own roof. `observe`, when given, sees the ring's design as one `BuildingTrace`, `compound`.
 *
 * Candidate boxes lie in the reduced fill, off every portal's clear margin, and are checked
 * against the hunter's yard blocks.
 * A region with no usable box of `MIN_SIDE` goes to `open` (17 M24).
 *
 * Loot rolls each cell's chance and takes the cell's tier, wherever a loot disc stands clear of
 * every wall and door, in the rooms, the court or the yard. A compound sites no core elements;
 * any the brief lists are left for the report.
 */
export function buildCompound(brief: RegionBrief, observe?: BuildingObserver): BuiltRegion {
  const gates = brief.parameters?.gates ?? DEFAULT_GATES;
  if (typeof gates !== 'number' || !Number.isInteger(gates) || gates < MIN_GATES || gates > MAX_GATES)
    throw new RangeError(`Compound gates must be a whole number from ${MIN_GATES} to ${MAX_GATES}.`);
  const mask = createFillMask(brief), size = brief.cellSize;
  const space = largestRectangle(mask, MIN_SIDE);
  if (!space) return unfilledRegion(brief, CHANNEL.loot);
  const site = siteCompound(brief, mask, createAccessMask(brief), space, gates);
  if (!site) return unfilledRegion(brief, CHANNEL.loot);
  const { x: bx, y: by, w: W, h: H, gated } = site;

  // The ring in the box's own cells. A side's middle runs between the corner rooms; `strip` is the box `length` long from `t` along it, `DEPTH` deep.
  const strip = (side: Side, t: number, length: number): Box => {
    switch (side) {
      case 'N': return { x: DEPTH + t, y: 0, w: length, h: DEPTH };
      case 'S': return { x: DEPTH + t, y: H - DEPTH, w: length, h: DEPTH };
      case 'W': return { x: 0, y: DEPTH + t, w: DEPTH, h: length };
      case 'E': return { x: W - DEPTH, y: DEPTH + t, w: DEPTH, h: length };
    }
  };
  const rooms: { id: string; box: Box; side?: Side }[] = [
    { id: 'room-1', box: { x: 0, y: 0, w: DEPTH, h: DEPTH } }, { id: 'room-2', box: { x: W - DEPTH, y: 0, w: DEPTH, h: DEPTH } },
    { id: 'room-3', box: { x: 0, y: H - DEPTH, w: DEPTH, h: DEPTH } }, { id: 'room-4', box: { x: W - DEPTH, y: H - DEPTH, w: DEPTH, h: DEPTH } },
  ];
  const passages: { id: string; box: Box; side: Side }[] = [];
  for (const [i, side] of SIDES.entries()) {
    const middle = (side === 'N' || side === 'S' ? W : H) - 2 * DEPTH;
    // A gate's passage is PASSAGE wide at a seeded place, widened to the corner where what's left is too short for a room.
    let segments: [number, number][] = [[0, middle]];
    if (gated.has(side)) {
      let a = Math.floor(draw(brief.seed, i, 1, CHANNEL.gateAt) * (middle - PASSAGE + 1)), b = a + PASSAGE;
      if (a < MIN_ROOM) a = 0;
      if (middle - b < MIN_ROOM) b = middle;
      passages.push({ id: `gate-${side}`, box: strip(side, a, b - a), side });
      segments = [[0, a], [b, middle]];
    }
    const aim = MIN_ROOM + Math.floor(draw(brief.seed, i, 2, CHANNEL.room) * (MAX_ROOM - MIN_ROOM + 1));
    for (const [from, to] of segments) {
      const span = to - from;
      if (!span) continue;
      // Lengths as even as whole cells allow, each at least MIN_ROOM.
      const count = Math.max(1, Math.min(Math.floor(span / MIN_ROOM), Math.round(span / aim)));
      for (let k = 0; k < count; k++) {
        const t0 = from + Math.floor(span * k / count), t1 = from + Math.floor(span * (k + 1) / count);
        rooms.push({ id: `room-${rooms.length + 1}`, box: strip(side, t0, t1 - t0), side });
      }
    }
  }
  const cellsOf = ({ x, y, w, h }: Box) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
  const spaces = [...rooms, ...passages];
  const allocation: BuildingAllocation = { footprint: spaces.flatMap(s => cellsOf(s.box)), spaces: spaces.map(s => ({ id: s.id, cells: cellsOf(s.box) })) };
  const at = (x: number, y: number) => spaces.find(({ box }) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)!.id;
  const widths: Record<string, number> = {};
  const design: BuildingDesign = {
    spaces: spaces.map(({ id, box }) => ({ id, area: { min: box.w * box.h, max: box.w * box.h }, outside: 'any',
      tags: [id.startsWith('gate') ? 'passage' : 'room'] })),
    connections: [
      // Each side's rooms open onto the court; each corner room only into its neighbour along the north or south side.
      ...rooms.filter(room => room.side).map(room => ({ id: `${room.id}-court`, a: room.id, b: OUTSIDE, kind: 'door' as const, side: OPPOSITE[room.side!] })),
      { id: 'room-1-door', a: 'room-1', b: at(DEPTH, 0), kind: 'door' }, { id: 'room-2-door', a: 'room-2', b: at(W - DEPTH - 1, 0), kind: 'door' },
      { id: 'room-3-door', a: 'room-3', b: at(DEPTH, H - 1), kind: 'door' }, { id: 'room-4-door', a: 'room-4', b: at(W - DEPTH - 1, H - 1), kind: 'door' },
      // A passage has a door in the outer wall and lies open to the court along its whole length.
      ...passages.flatMap(({ id, box, side }) => {
        widths[`${id}-court`] = side === 'N' || side === 'S' ? box.w : box.h;
        return [{ id, a: id, b: OUTSIDE, kind: 'door' as const, side }, { id: `${id}-court`, a: id, b: OUTSIDE, kind: 'open' as const, side: OPPOSITE[side] }];
      }),
    ],
  };
  const realization = realizeBuilding(design, allocation, { cellSize: size, thickness: WALL, encloses: false, exteriorOrder: SIDES, corners: 'horizontal', clear: passages.map(passage => passage.id), widths });
  const split = realization.template && splitBuilding(realization, allocation, { cellSize: size, roofed: rooms.map(room => room.id) });
  // The ring's design always fits. A miss here is an implementation defect, not a new fallback.
  if (!split || realization.issues.length || realization.misses.length || split.issues.length) throw new Error('The compound ring could not be realized.');
  observe?.({ label: 'compound', origin: { x: bx * size, y: by * size }, cellSize: size, design, allocation, realization });

  const elements: RegionElement[] = split.pieces.map(piece => ({ label: `compound-${piece.space}`,
    x: bx * size + piece.origin.x, y: by * size + piece.origin.y, template: piece.template }));
  const parts = elements.flatMap(element => element.template.parts);
  const pieces: Shape[] = elements.flatMap(element => elementShapes(element, true));
  const loot = cellLoot(brief, createRegionMask(brief), pieces, CHANNEL.loot);
  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: rooms.length, obstacles: parts.filter(p => p.part === 'obstacle').length,
      gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, coreElements: 0, rooms: rooms.length, compoundGates: passages.length } };
}
