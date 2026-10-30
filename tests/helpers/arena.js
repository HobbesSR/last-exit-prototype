import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';

// Test arenas (31 "Test arenas", #697): one parameterized builder for hand-made scenes. A new arena is a
// parameter set of this builder unless it needs something the builder can't express, and its PR says so.
// Never served from the main interface; a lab may adapt one.

/**
 * A valid `GameMap` of `cols` × `rows` cells, all playable, so points anywhere stay where they are put
 * (a map without a playable area is a diamond). Everything not given is empty.
 *
 * `corridor` splits it into `gaps.length + 1` regions side by side, each wall leaving one cell-high gap at
 * row `gaps[i]`, and attaches the portal graph across the gaps; `crossings` are the gaps' midpoints.
 * `scatter` puts a `size`-square crate in about `density` of the cells, chosen from `seed` alone, never in a cell
 * beside a corridor's gap.
 * The game mutates its map, so build one per game.
 */
export function arena({ cols, rows, cellSize = 192, seed = 0, corridor, scatter, obstacles = [], gates = [], buildings = [], roofs, decals,
  modules = [], hazards = [], gaps = [], sensors = [], routes = [], nodes = [], streets = [], items = [], traps = [],
  stations = [], chargers = [], physicsProps, spawns = [], hunterSpawns, entry, exit } = {}) {
  const width = cols * cellSize, height = rows * cellSize;
  const playableArea = { cellSize, rows: Array.from({ length: rows }, (_, y) => ({ y, runs: [[0, cols]] })) };
  const map = { seed, width, height, playableArea, modules: [...modules], buildings: [...buildings],
    ...(roofs ? { roofs: [...roofs] } : {}), ...(decals ? { decals: [...decals] } : {}),
    obstacles: [...obstacles], gates: [...gates], hazards: [...hazards], gaps: [...gaps], stations: [...stations],
    chargers: [...chargers], sensors: [...sensors], items: [...items], traps: [...traps], routes: [...routes],
    nodes: [...nodes], streets: [...streets], physicsProps,
    entry: entry ?? { x: cellSize / 2, y: height / 2 }, exit: exit ?? { x: width - cellSize / 2, y: height / 2 }, spawns, hunterSpawns };
  // The cells either side of each gap, which a crate could block.
  const span = corridor ? cols / (corridor.gaps.length + 1) : 0;
  const beside = new Set(corridor?.gaps.flatMap((gap, i) => [(i + 1) * span - 1, (i + 1) * span].map(col => gap * cols + col)));
  if (scatter) map.obstacles.push(...crates(cols, rows, cellSize, scatter).filter(crate => !beside.has(crate.cell)).map(({ cell, ...crate }) => crate));
  const crossings = corridor ? walls(map, cols, rows, cellSize, corridor) : [];
  return { map, crossings };
}

function walls(map, cols, rows, cellSize, { gaps, thickness = 40 }) {
  const count = gaps.length + 1, span = cols / count;
  if (!Number.isInteger(span)) throw new RangeError(`${cols} columns do not split into ${count} regions`);
  for (const gap of gaps) if (!Number.isInteger(gap) || gap < 0 || gap >= rows) throw new RangeError(`no row ${gap} for a gap in ${rows} rows`);
  const joins = gaps.map((gap, i) => {
    const x = (i + 1) * span * cellSize - thickness / 2;
    for (let row = 0; row < rows; row++)
      if (row !== gap) map.obstacles.push({ id: `wall-${i}-${row}`, x, y: row * cellSize, w: thickness, h: cellSize });
    return { a: i, b: i + 1, x: x + thickness / 2, y: gap * cellSize + cellSize / 2 };
  });
  const owner = new Int32Array(cols * rows);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) owner[row * cols + col] = Math.floor(col / span);
  const regions = Array.from({ length: count }, (_, i) => ({ id: `r${i}`, box: { x: i * span * cellSize, y: 0, w: span * cellSize, h: rows * cellSize }, portals: [] }));
  const portals = joins.map(({ a, b, x, y }, node) => ({ id: `p${node}`, x, y, stands: [], regions: [a, b],
    slots: [regions[a].portals.push(node) - 1, regions[b].portals.push(node) - 1] }));
  attachPortalGraph(map, { cellSize, cols, rows, owner, regions, portals });
  return joins.map(({ x, y }) => ({ x, y }));
}

function crates(cols, rows, cellSize, { density, seed = 1, size = 40 }) {
  let state = seed >>> 0 || 1;
  const next = () => (state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 2 ** 32;
  const out = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const pick = next(), dx = next(), dy = next();
    if (pick < density) out.push({ id: `crate-${col}-${row}`, kind: 'crate', cell: row * cols + col, w: size, h: size,
      x: Math.round(col * cellSize + dx * (cellSize - size)), y: Math.round(row * cellSize + dy * (cellSize - size)) });
  }
  return out;
}

// Presets: parameter sets kept because their scenes keep coming up.

/** Open ground `length` long and `rows` cells tall, for trips in a straight line. */
export const openField = (length, { rows = 6, cellSize = 192, ...rest } = {}) => arena({ cols: Math.ceil(length / cellSize), rows, cellSize, ...rest });
