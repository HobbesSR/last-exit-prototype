import { rect } from '../../../shared/shape.ts';
import { rng } from '../index.ts';
import type { ObstacleKind } from '../../../shared/types.ts';
import type { BuiltRegion, LootSite, RegionBrief, RegionElement } from '../types.ts';

/** Cells between slots, one tile, so pieces read as sited rather than strewn. */
const PERIOD = 6;
/**
 * Clear cells around every cluster's box, from every other cluster and from the region's
 * edge. A doorway is 2 (52); the third lets the sampled route search see each aisle (20).
 */
const AISLE = 3;
const DENSITY = 0.55;
/** The most pieces in one slot's cluster. */
const CLUSTER = 3;

/** A piece of cover: its footprint in cells, and how to draw it inside that footprint. */
interface Piece { kind: ObstacleKind; name: string; w: number; h: number; weight: number }
const PIECES: Piece[] = [
  { kind: 'crate', name: 'crate', w: 1, h: 1, weight: 0.5 },
  { kind: 'ruin-wall', name: 'barrier', w: 2, h: 1, weight: 0.35 },
  { kind: 'container', name: 'container', w: 2, h: 1, weight: 0.15 },
];

function densityOf(brief: RegionBrief): number {
  const density = brief.parameters?.density ?? DENSITY;
  if (typeof density !== 'number' || !(density >= 0 && density <= 1)) throw new Error(`Region ${brief.id}: cover's density must be a number from 0 to 1.`);
  return density;
}

/**
 * The `cover` region type (54): small cover scattered on open ground, with no decomposer.
 *
 * Slots lie on a lattice `PERIOD` cells apart. A slot is taken with chance `density`, by a
 * cluster of up to `CLUSTER` crates, barriers and the odd container, at jittered spots in it.
 * Every cluster's bounding box keeps `AISLE` clear cells from the next slot's and from any
 * cell the region doesn't own, so no route search is needed. Each box is convex with a clear
 * ring wider than a hunter around it, and such boxes can't divide the ground a hunter can
 * reach outside them, where every portal is. So, like `open`, the region keeps the portal
 * promise exactly when its shape does. A region too small for one piece stays clear.
 *
 * Loot rolls each cell's chance and takes the cell's tier (52, "Tier zones"). It lands at a
 * cell whose neighbours are all owned and free of cover, so it has standing room. Cover sites
 * no core elements; any the brief lists are left for the report to name (51 stage 8).
 */
export function buildCover(brief: RegionBrief): BuiltRegion {
  const density = densityOf(brief), size = brief.cellSize;
  const owned = new Set(brief.cells.map(c => `${c.x},${c.y}`)), footprints = new Set<string>();
  const cells = [...brief.cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const slots = rng(brief.seed, `${brief.id}:cover-slots`), phase = { x: slots.int(0, PERIOD - 1), y: slots.int(0, PERIOD - 1) };
  const onLattice = (value: number, offset: number) => ((value - offset) % PERIOD + PERIOD) % PERIOD === 0;
  const clear = (x: number, y: number, w: number, h: number) => {
    for (let j = y - AISLE; j < y + h + AISLE; j++) for (let i = x - AISLE; i < x + w + AISLE; i++) if (!owned.has(`${i},${j}`)) return false;
    return true;
  };
  const occupied = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (footprints.has(`${i},${j}`)) return true;
    return false;
  };

  const elements: RegionElement[] = [];
  for (const slot of cells) {
    if (!onLattice(slot.x, phase.x) || !onLattice(slot.y, phase.y)) continue;
    // Every slot draws the same numbers whether or not it is taken, so one slot's fate never shifts another's.
    const taken = slots.next() < density, wanted = 1 + Math.floor(slots.next() * CLUSTER);
    const draws = Array.from({ length: CLUSTER }, () => ({ pick: slots.next(), turned: slots.next() < 0.5, jx: slots.next(), jy: slots.next(), length: slots.next(), offset: slots.next() }));
    if (!taken) continue;
    // A cluster stays inside the slot's first PERIOD - AISLE cells, so neighbouring clusters keep the aisle.
    // Its bounding box, which is convex, keeps the aisle from the region's edge as it grows.
    let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
    for (const { pick, turned, jx, jy, length, offset } of draws.slice(0, wanted)) {
      let piece = PIECES[0]!;
      for (let sum = 0, i = 0; i < PIECES.length; i++) if (pick < (sum += PIECES[i]!.weight)) { piece = PIECES[i]!; break; }
      const w = turned ? piece.h : piece.w, h = turned ? piece.w : piece.h;
      const x = slot.x + Math.floor(jx * (PERIOD - AISLE - w + 1)), y = slot.y + Math.floor(jy * (PERIOD - AISLE - h + 1));
      const grown = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x + w), y1: Math.max(box.y1, y + h) } : { x0: x, y0: y, x1: x + w, y1: y + h };
      if (occupied(x, y, w, h) || !clear(grown.x0, grown.y0, grown.x1 - grown.x0, grown.y1 - grown.y0)) continue;
      box = grown;
      const shape = drawn(piece, w * size, h * size, length, offset);
      elements.push({ label: `cover-${piece.name}-${elements.length + 1}`, x: x * size, y: y * size, template: { w: w * size, h: h * size, parts: [{ part: 'obstacle', shape, kind: piece.kind }] } });
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) footprints.add(`${i},${j}`);
    }
  }

  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(c => [`${c.x},${c.y}`, zone] as const)));
  const lootRandom = rng(brief.seed, `${brief.id}:cover-loot`), loot: LootSite[] = [];
  const standing = (x: number, y: number) => {
    for (let j = y - 1; j <= y + 1; j++) for (let i = x - 1; i <= x + 1; i++) if (!owned.has(`${i},${j}`) || footprints.has(`${i},${j}`)) return false;
    return true;
  };
  for (const cell of cells) {
    const zone = zones.get(`${cell.x},${cell.y}`)!, roll = lootRandom.next(), jx = lootRandom.next(), jy = lootRandom.next();
    if (roll < zone.lootChance && standing(cell.x, cell.y)) loot.push({ x: (cell.x + 0.35 + jx * 0.3) * size, y: (cell.y + 0.35 + jy * 0.3) * size, tier: zone.tier });
  }

  return { version: 'region-2', brief: structuredClone(brief), elements, coreElements: [], loot,
    manifest: { cells: brief.cells.length, structures: 0, obstacles: elements.length, gates: 0, loot: loot.length, coreElements: 0 } };
}

/** A piece's shape inside its footprint of `w` × `h` world units, along the footprint's long axis. */
function drawn(piece: Piece, w: number, h: number, length: number, offset: number) {
  const along = w >= h, long = Math.max(w, h), short = Math.min(w, h);
  const [l, t] = piece.name === 'crate' ? [long * (0.6 + length * 0.25), long * (0.6 + length * 0.25)]
    : piece.name === 'barrier' ? [long * (0.7 + length * 0.25), short * 0.3] : [long * 0.95, short * 0.9];
  const a = (long - l) * offset, b = (short - t) / 2;
  return along ? rect(Math.round(a), Math.round(b), Math.round(l), Math.round(t)) : rect(Math.round(b), Math.round(a), Math.round(t), Math.round(l));
}
