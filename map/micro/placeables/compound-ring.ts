import { OPPOSITE, type Side } from '../port-terms.ts';
import { draw } from '../random.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign } from '../building/design.ts';
import { splitBuilding } from '../building/pieces.ts';
import { reachableRoofGroups } from '../building/groups.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingRealization } from '../building/realize.ts';
import type { Placeable } from './placeable.ts';

/*
 * `compound-ring`: roofed rooms around a walled court with passages through selected sides.
 * `compound` sites one ring and grants its gate approaches.
 */

const DEPTH = 3, MIN_ROOM = 3, MAX_ROOM = 5, WALL = 0.25;
const PASSAGE = CELL_SCALE.doorway;
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const CHANNEL = { gateAt: 3, room: 4 };
interface Box { x: number; y: number; w: number; h: number }
type Space = { id: string; box: Box; side?: Side };
type Passage = { id: string; box: Box; side: Side };

export interface CompoundRingParams {
  w: number;
  h: number;
  /** Bits N=1, E=2, S=4, W=8, selected by the builder. */
  gates: number;
  seed: number;
}

export interface CompoundRingDetails {
  design: BuildingDesign;
  allocation: BuildingAllocation;
  realization: BuildingRealization;
  rooms: number;
  passages: Passage[];
  /** Door stands in local cells, in passage order. */
  steps: { x: number; y: number }[];
}

export const COMPOUND_RING = Object.freeze<Placeable<CompoundRingParams, CompoundRingDetails>>({
  id: 'compound-ring',
  version: 'compound-ring-1',
  summary: 'A roofed ring of rooms around a court, with gates on selected sides.',
  params: [
    { name: 'w', summary: 'Ring width in cells.', kind: 'int', min: 10, max: 24 },
    { name: 'h', summary: 'Ring height in cells.', kind: 'int', min: 10, max: 24 },
    { name: 'gates', summary: 'Gate sides as N/E/S/W bits.', kind: 'int', min: 1, max: 15 },
    { name: 'seed', summary: 'Room and gate passage choices.', kind: 'int', min: 0, max: 2 ** 31 - 1 },
  ],
  examples: [
    { w: 10, h: 10, gates: 1, seed: 1 },
    { w: 18, h: 16, gates: 5, seed: 9 },
    { w: 24, h: 24, gates: 15, seed: 4217 },
  ],
  build({ w: W, h: H, gates, seed }: CompoundRingParams, size: number) {
    // The ring in the box's own cells. A side's middle runs between the corner rooms.
    const strip = (side: Side, t: number, length: number): Box => {
      switch (side) {
        case 'N': return { x: DEPTH + t, y: 0, w: length, h: DEPTH };
        case 'S': return { x: DEPTH + t, y: H - DEPTH, w: length, h: DEPTH };
        case 'W': return { x: 0, y: DEPTH + t, w: DEPTH, h: length };
        case 'E': return { x: W - DEPTH, y: DEPTH + t, w: DEPTH, h: length };
      }
    };
    const rooms: Space[] = [
      { id: 'room-1', box: { x: 0, y: 0, w: DEPTH, h: DEPTH } }, { id: 'room-2', box: { x: W - DEPTH, y: 0, w: DEPTH, h: DEPTH } },
      { id: 'room-3', box: { x: 0, y: H - DEPTH, w: DEPTH, h: DEPTH } }, { id: 'room-4', box: { x: W - DEPTH, y: H - DEPTH, w: DEPTH, h: DEPTH } },
    ];
    const passages: Passage[] = [];
    for (const [i, side] of SIDES.entries()) {
      const middle = (side === 'N' || side === 'S' ? W : H) - 2 * DEPTH;
      let segments: [number, number][] = [[0, middle]];
      if (gates & (1 << i)) {
        let a = Math.floor(draw(seed, i, 1, CHANNEL.gateAt) * (middle - PASSAGE + 1)), b = a + PASSAGE;
        if (a < MIN_ROOM) a = 0;
        if (middle - b < MIN_ROOM) b = middle;
        passages.push({ id: `gate-${side}`, box: strip(side, a, b - a), side });
        segments = [[0, a], [b, middle]];
      }
      const aim = MIN_ROOM + Math.floor(draw(seed, i, 2, CHANNEL.room) * (MAX_ROOM - MIN_ROOM + 1));
      for (const [from, to] of segments) {
        const span = to - from;
        if (!span) continue;
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
        ...rooms.filter(room => room.side).map(room => ({ id: `${room.id}-court`, a: room.id, b: OUTSIDE, kind: 'door' as const, side: OPPOSITE[room.side!] })),
        { id: 'room-1-door', a: 'room-1', b: at(DEPTH, 0), kind: 'door' }, { id: 'room-2-door', a: 'room-2', b: at(W - DEPTH - 1, 0), kind: 'door' },
        { id: 'room-3-door', a: 'room-3', b: at(DEPTH, H - 1), kind: 'door' }, { id: 'room-4-door', a: 'room-4', b: at(W - DEPTH - 1, H - 1), kind: 'door' },
        ...passages.flatMap(({ id, box, side }) => {
          widths[`${id}-court`] = side === 'N' || side === 'S' ? box.w : box.h;
          return [{ id, a: id, b: OUTSIDE, kind: 'door' as const, side }, { id: `${id}-court`, a: id, b: OUTSIDE, kind: 'open' as const, side: OPPOSITE[side] }];
        }),
      ],
    };
    const realization = realizeBuilding(design, allocation, { cellSize: size, thickness: WALL, encloses: false, exteriorOrder: SIDES, corners: 'horizontal', clear: passages.map(passage => passage.id), widths, decalTheme: 'compound' });
    // A leading hyphen is the local suffix; the builder supplies its region ID after siting.
    const split = realization.template && splitBuilding(realization, allocation, { cellSize: size, roofed: rooms.map(room => room.id),
      groupId: reachableRoofGroups(realization, allocation, '') });
    if (!split || realization.issues.length || realization.misses.length || split.issues.length) throw new Error('The compound ring could not be realized.');
    const steps: { x: number; y: number }[] = [];
    const clear: Box[] = [];
    for (const passage of passages) {
      const opening = realization.openings.find(o => o.connectionId === passage.id)!;
      const along = (opening.run.axis === 'h' ? opening.run.x : opening.run.y) + opening.center - 1;
      const starts = [...new Set([Math.floor(along), Math.ceil(along)])];
      for (const t of starts) steps.push({ x: passage.side === 'W' ? -2 : passage.side === 'E' ? W : t,
        y: passage.side === 'N' ? -2 : passage.side === 'S' ? H : t });
      const from = Math.min(...starts), span = Math.max(...starts) - from + 2;
      clear.push(passage.side === 'N' ? { x: from, y: -2, w: span, h: 2 }
        : passage.side === 'S' ? { x: from, y: H, w: span, h: 2 }
          : passage.side === 'W' ? { x: -2, y: from, w: 2, h: span } : { x: W, y: from, w: 2, h: span });
    }
    return {
      elements: split.pieces.map(piece => ({ name: piece.space, x: piece.origin.x, y: piece.origin.y, template: piece.template })),
      demand: { body: { w: W, h: H }, clear },
      details: { design, allocation, realization, rooms: rooms.length, passages, steps },
    };
  },
});
