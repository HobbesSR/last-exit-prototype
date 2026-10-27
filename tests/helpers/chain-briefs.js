import { applyClearConstraints, clearFootprint } from '../../map/kernel/margins.ts';
import { cellsOf } from './cells.js';

export const SIZE = 40;

/**
 * The map around a region: its owned cells' bounding box, `pad` cells out. A chain region
 * sits among other owners' cells, so a hole in its mask is playable and so is a margin past
 * its portals; a hand-built brief that clips to its own cells never sees either (20.6).
 */
export function playableAround(owned, pad = 1) {
  const xs = owned.map(c => c.x), ys = owned.map(c => c.y);
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return cellsOf(Math.max(...xs) + pad - x0 + 1, Math.max(...ys) + pad - y0 + 1).map(c => ({ x: c.x + x0, y: c.y + y0 }));
}

/**
 * A brief as the chain hands a builder (51 stage 5, 20.6): the owned cells and portals, the
 * clear margin around every guaranteed run clipped to the playable cells and split off the
 * fill, and any internal runs, hints, parameters and core requests. A builder never meets
 * cleared cells inside its owned area from a bare rectangle with portals, where the fill and
 * access masks coincide, so internal runs are what make a brief chain-like.
 *
 * - `internal` are runs inside the region that must stay passable (`internalGuaranteed`);
 * - `playable` is the map's playable cells, by default the owned cells padded by `pad`;
 * - `zones` default to one tier 3 zone with a loot chance, so loot is exercised too.
 */
export function chainBrief({ id = 'chain', seed = 1, type = 'open', cells, portals = [], internal = [], hints, parameters,
  coreElements, pad = 1, playable = playableAround(cells, pad), zones, cellSize = SIZE }) {
  return {
    id, seed, type, cellSize, cells, portals,
    zones: zones ?? [{ tier: 3, bonus: 0, lootChance: 0.4, cells }],
    ...applyClearConstraints(cells, clearFootprint([...portals, ...internal], playable)),
    ...internal.length ? { internalGuaranteed: internal } : {},
    ...hints ? { hints } : {},
    ...parameters ? { parameters } : {},
    ...coreElements ? { coreElements } : {},
  };
}

/** A seeded shuffle of a copy of `list`: the same seed gives the same order. */
function shuffled(list, seed) {
  const out = list.slice();
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The same brief with every list of cells in another order: owned, fill, clear and each
 * zone's. The cells and portals are unchanged, so a builder that reads them as a set builds
 * the same region. Portal order stays: the first portal is meaningful to some builders.
 */
export function reorderedBrief(brief, seed = 1) {
  return { ...brief, cells: shuffled(brief.cells, seed), fillCells: shuffled(brief.fillCells, seed + 1),
    clearCells: shuffled(brief.clearCells, seed + 2), zones: brief.zones.map((zone, i) => ({ ...zone, cells: shuffled(zone.cells, seed + 3 + i) })) };
}

const edges = (w, h) => [{ id: 'west', axis: 'v', x: 0, y: 3, length: 3 }, { id: 'east', axis: 'v', x: w, y: h - 6, length: 3 },
  { id: 'north', axis: 'h', x: w - 10, y: 0, length: 5 }];

/**
 * Chain-like region inputs, each a `{ name, cells, portals, internal, hints? }` for `chainBrief`.
 * Together they give a builder the shapes a map hands it and a rectangle with portals does not:
 *
 * - three 30 × 22 fields crossed by cleared strips, a full-width one and a short one at
 *   three offsets, so a strip meets a different part of any lattice or aisle. They are
 *   `roomy`: each leaves the contiguous 10 × 10 of fill that `compound`, `depot` and `plant`
 *   ask for, so every type but `open` builds geometry on them. Each has a hinted stretch of
 *   its south edge;
 * - an L, concave, with a strip across its elbow;
 * - a ring around a hole, with a strip across one bar and a portal onto the hole;
 * - a yard with four portals, internal strips and hinted stretches of its perimeter.
 *
 * Sizes keep the whole set cheap for every region type. A builder test that needs another
 * scale builds its own mask and passes it to `chainBrief` the same way.
 */
export function chainFixtures() {
  const field = (name, horizontal, vertical) => ({ name, roomy: true, cells: cellsOf(30, 22), portals: edges(30, 22),
    internal: [{ axis: 'h', x: 0, y: horizontal, length: 30 }, { axis: 'v', x: vertical, y: 2, length: 12 }],
    hints: [{ axis: 'h', x: 2, y: 22, length: 20 }] });
  return [
    field('field-strips-a', 5, 12),
    field('field-strips-b', 9, 20),
    field('field-strips-c', 16, 7),
    { name: 'ell-strip', cells: cellsOf(20, 20, (x, y) => y < 10 || x < 10),
      portals: [{ id: 'east', axis: 'v', x: 20, y: 2, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 20, length: 4 },
        { id: 'corner', axis: 'h', x: 12, y: 10, length: 5 }],
      internal: [{ axis: 'v', x: 5, y: 4, length: 14 }] },
    { name: 'ring-strip', cells: cellsOf(24, 24, (x, y) => x < 8 || x >= 16 || y < 8 || y >= 16),
      portals: [{ id: 'north', axis: 'h', x: 10, y: 0, length: 4 }, { id: 'hole', axis: 'v', x: 16, y: 10, length: 3 },
        { id: 'west', axis: 'v', x: 0, y: 17, length: 3 }],
      internal: [{ axis: 'h', x: 0, y: 4, length: 24 }] },
    { name: 'yard-hinted', cells: cellsOf(16, 14),
      portals: [{ id: 'north', axis: 'h', x: 1, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 16, y: 2, length: 4 },
        { id: 'south', axis: 'h', x: 7, y: 14, length: 2 }, { id: 'west', axis: 'v', x: 0, y: 8, length: 2 }],
      internal: [{ axis: 'v', x: 8, y: 2, length: 6 }],
      hints: [{ axis: 'h', x: 6, y: 0, length: 8 }, { axis: 'v', x: 16, y: 8, length: 5 }] },
  ];
}
