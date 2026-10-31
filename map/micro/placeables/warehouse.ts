import { allocateBuilding } from '../building/allocation.ts';
import { realizeBuilding } from '../building/realize.ts';
import type { BuildingRealization } from '../building/realize.ts';
import { OUTSIDE } from '../building/design.ts';
import type { BuildingAllocation, BuildingDesign, BuildingSide } from '../building/design.ts';
import type { ElementTemplate } from '../../../shared/map/element.ts';
import type { Box, BuildingAppearance } from '../../../shared/types.ts';
import { oriented } from './frame.ts';
import type { Placeable } from './placeable.ts';

/*
 * `warehouse`: a roofed building design (56) with shelf islands on its floor. `depot` builds its
 * warehouses with it, `plant` its shed and `checkpoint` its post.
 */

/** Wall thickness, in cells, as `hut`'s are. */
const WALL = 0.25;
/** Cells across a shelf island, and how far its container stands inside them. */
const SHELF_INSET = 0.2;

/**
 * Shelf islands a cell across down a floor `length` cells along u from `u0`, spanning v from
 * `v0` to `v1`. Each island keeps 2 cells from the floor's walls and from the next island, so
 * every aisle is open to a contestant and the doors open onto clear ends. A floor shorter than
 * 5 cells has none.
 */
function shelves(size: number, alongX: boolean, u0: number, length: number, v0: number, v1: number): ElementTemplate['parts'] {
  const box = oriented(size, alongX), parts: ElementTemplate['parts'] = [];
  if (length < 5) return parts;
  for (let k = v0 + 2; k + 3 <= v1; k += 3)
    parts.push({ part: 'obstacle', shape: box(u0 + 2, k + SHELF_INSET, length - 4, 1 - 2 * SHELF_INSET), kind: 'container' });
  return parts;
}

type Design = ReadonlyArray<{ id: string; share: readonly [number, number] }>;
/**
 * The warehouse designs with several spaces, with each space's share of the box (56). The
 * floor takes at least half; an office and a store, each at least 3 × 3, take the rest.
 * Labels and shares are guidance (17.2.8 M28).
 */
const DESIGNS: ReadonlyArray<Design> = [
  [{ id: 'floor', share: [0.5, 1] }, { id: 'office', share: [0, 0.25] }, { id: 'store', share: [0, 0.25] }],
  [{ id: 'floor', share: [0.5, 1] }, { id: 'office', share: [0, 0.4] }],
];
/** The last resort: the whole box is the floor, with a door centred on each end. */
const ONE_ROOM: Design = [{ id: 'floor', share: [1, 1] }];

export type Warehouse = { design: BuildingDesign; allocation: BuildingAllocation; realization: BuildingRealization;
  template: ElementTemplate; rejected: { design: string; reason: string }[] };

/**
 * A warehouse `w` × `h` cells from the first design that fits: the designs with several spaces
 * in a seeded order, then one room. The floor is asked for a door on each end; the office for
 * a door into the floor, a door out on the far end, where it can front the warehouse, and a
 * window; the store for a door into the floor. A design is kept only if at least two doors
 * lead outside, so the warehouse stays a way through, and every space is reached through a
 * door from outside. Each design passed over is named in `rejected` with why. Missed openings
 * are guidance and stay as misses (M29). Shelves stand on the floor.
 */
function warehouse(size: number, w: number, h: number, alongX: boolean, seed: number, appearance?: BuildingAppearance): Warehouse {
  const area = w * h, cells = Array.from({ length: area }, (_, i) => ({ x: i % w, y: Math.floor(i / w) }));
  const ends: readonly BuildingSide[] = alongX ? ['W', 'E'] : ['N', 'S'];
  const rejected: Warehouse['rejected'] = [];
  for (const spaces of [...seed % 2 ? [...DESIGNS].reverse() : DESIGNS, ONE_ROOM]) {
    const ids = spaces.map(space => space.id), name = ids.join('+');
    const reject = (reason: string) => { rejected.push({ design: name, reason }); };
    const asked: BuildingDesign = {
      spaces: spaces.map(({ id, share: [min, max] }) => ({ id, area: { min: Math.max(9, Math.ceil(min * area)), max: Math.floor(max * area) },
        outside: 'prefer' as const, tags: [id] })),
      connections: [
        ...ends.map((side, i) => ({ id: `door-${i + 1}`, a: 'floor', b: OUTSIDE, kind: 'door' as const, side })),
        ...ids.slice(1).map(id => ({ id: `${id}-door`, a: 'floor', b: id, kind: 'door' as const })),
        ...ids.includes('office') ? [
          { id: 'office-entrance', a: 'office', b: OUTSIDE, kind: 'door' as const, side: ends[1] },
          { id: 'office-window', a: 'office', b: OUTSIDE, kind: 'window' as const },
        ] : [],
      ],
    };
    const allocated = allocateBuilding(asked, cells, { seed });
    if (!allocated.ok) { reject(allocated.reason); continue; }
    const { design, allocation } = allocated;
    const realization = realizeBuilding(design, allocation, { cellSize: size, thickness: WALL, encloses: true, corners: 'horizontal', decalTheme: 'depot', ...(appearance ? { appearance } : {}) });
    if (!realization.template || realization.issues.length) { reject(realization.issues.join(' ') || 'it could not be realized'); continue; }
    const exits = realization.openings.filter(({ kind, a, b }) => kind === 'door' && (a === OUTSIDE || b === OUTSIDE));
    if (exits.length < 2) { reject(`${exits.length} door${exits.length === 1 ? '' : 's'} out, fewer than two`); continue; }
    const reached = new Set([OUTSIDE]);
    for (let grown = true; grown;) {
      grown = false;
      for (const { kind, a, b } of realization.openings) {
        if (kind === 'window' || reached.has(a) === reached.has(b)) continue;
        reached.add(a); reached.add(b); grown = true;
      }
    }
    const unreached = ids.filter(id => !reached.has(id));
    if (unreached.length) { reject(`no door reaches ${unreached.join(', ')}`); continue; }
    const floor = allocation.spaces.find(space => space.id === 'floor')!.cells;
    const us = floor.map(c => alongX ? c.x : c.y), vs = floor.map(c => alongX ? c.y : c.x), u0 = Math.min(...us);
    const template = { ...realization.template, parts: [...realization.template.parts,
      ...shelves(size, alongX, u0, Math.max(...us) + 1 - u0, Math.min(...vs), Math.max(...vs) + 1)] };
    return { design, allocation, realization, template, rejected };
  }
  // One room with a door on each end always fits a box at least 5 cells a side. A miss here is a defect, not a new fallback.
  throw new Error(`A ${w} × ${h} warehouse could not be built as one room: ${rejected.at(-1)?.reason}`);
}

export interface WarehouseParams {
  /** The box in cells. */
  w: number;
  h: number;
  /** Whether its ends, with their doors, face west and east rather than north and south. */
  alongX: boolean;
  /** Orders the designs and seeds their allocation. */
  seed: number;
  /** Optional presentation appearance descriptor (29.4, 41.2, 52). */
  appearance?: BuildingAppearance | undefined;
}

/** What a warehouse's build reports beyond its geometry, for tools: its design and the designs passed over. */
export type WarehouseDetails = Omit<Warehouse, 'template'>;

/** Two-cell-deep stands outside every exterior door; coalesce overlapping stands on an end. */
function doorsteps(realization: BuildingRealization, w: number, h: number): Box[] {
  const ends = new Map<BuildingSide, { from: number; to: number }[]>();
  for (const opening of realization.openings) {
    if (opening.kind !== 'door' || opening.a !== OUTSIDE && opening.b !== OUTSIDE) continue;
    const { run, center } = opening;
    const side: BuildingSide = run.axis === 'h' ? (run.y === 0 ? 'N' : 'S') : (run.x === 0 ? 'W' : 'E');
    const start = (run.axis === 'h' ? run.x : run.y) + center - 1;
    const intervals = ends.get(side) ?? [];
    intervals.push({ from: Math.floor(start), to: Math.ceil(start) + 2 });
    ends.set(side, intervals);
  }
  const clear: Box[] = [];
  for (const [side, intervals] of ends) {
    const merged: { from: number; to: number }[] = [];
    for (const interval of intervals.sort((a, b) => a.from - b.from)) {
      const last = merged.at(-1);
      if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
      else merged.push({ ...interval });
    }
    for (const { from, to } of merged) clear.push(side === 'N' ? { x: from, y: -2, w: to - from, h: 2 }
      : side === 'S' ? { x: from, y: h, w: to - from, h: 2 }
        : side === 'W' ? { x: -2, y: from, w: 2, h: to - from } : { x: w, y: from, w: 2, h: to - from });
  }
  return clear;
}

export const WAREHOUSE = Object.freeze<Placeable<WarehouseParams, WarehouseDetails>>({
  id: 'warehouse',
  version: 'warehouse-2',
  summary: 'A roofed warehouse with two doors out, an office and store where they fit, and shelf islands on its floor.',
  params: [
    { name: 'w', summary: 'Width in cells.', kind: 'int', min: 5, max: 32 },
    { name: 'h', summary: 'Height in cells.', kind: 'int', min: 5, max: 32 },
    { name: 'alongX', summary: 'Ends face west and east rather than north and south.', kind: 'boolean' },
    { name: 'seed', summary: 'Design order and allocation seed.', kind: 'int', min: 0, max: 2 ** 31 - 1 },
  ],
  examples: [
    { w: 8, h: 6, alongX: true, seed: 1 },
    { w: 6, h: 8, alongX: false, seed: 2 },
    { w: 10, h: 8, alongX: true, seed: 7 },
    { w: 5, h: 5, alongX: false, seed: 0 },
  ],
  build({ w, h, alongX, seed, appearance }: WarehouseParams, cellSize: number) {
    const { template, ...details } = warehouse(cellSize, w, h, alongX, seed, appearance);
    return { elements: [{ x: 0, y: 0, template }], demand: { body: { w, h }, clear: doorsteps(details.realization, w, h) }, details };
  },
});
