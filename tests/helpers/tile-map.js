// A constant-density synthetic map for scaling measurements (#637): a real generated map repeated on a
// columns x rows grid, so content grows with area while its density stays that of a real map. Only the
// first copy keeps the entry, exit and spawns, so actors stay as many and start where they would. Copies
// meet edge to edge; nothing joins them on purpose, so routes across copies are whatever the edges allow
// and are not real topology. Never served: the room protocol accepts only generated sizes.
const shift = (dx, dy) => v => ({ ...v, x: v.x + dx, y: v.y + dy });

export function tileMap(map, columns, rows) {
  const cell = map.playableArea.cellSize;
  if (map.width % cell || map.height % cell) throw new RangeError('map extents must be whole playable cells');
  if (map.nodes.length || map.modules.length || map.routes.length || map.streets.length) throw new RangeError('tileMap handles chain-live maps only');
  const copies = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) copies.push({ column, row });
  const across = (pick) => copies.flatMap(({ column, row }) => {
    const dx = column * map.width, dy = row * map.height, tag = column || row ? `t${column}.${row}-` : '';
    const id = value => value === undefined ? value : `${tag}${value}`;
    return pick({ move: shift(dx, dy), id, dx, dy, columnCells: column * map.width / cell, rowCells: row * map.height / cell });
  });
  const rowsByY = new Map();
  across(({ rowCells, columnCells }) => map.playableArea.rows.map(r => ({ y: r.y + rowCells, runs: r.runs.map(([a, b]) => [a + columnCells, b + columnCells]) })))
    .forEach(r => rowsByY.set(r.y, [...rowsByY.get(r.y) ?? [], ...r.runs]));
  const playableRows = [...rowsByY].sort(([a], [b]) => a - b).map(([y, runs]) => ({ y, runs: mergeRuns(runs) }));
  return {
    ...structuredClone(map),
    width: map.width * columns, height: map.height * rows,
    playableArea: { cellSize: cell, rows: playableRows },
    buildings: across(({ move, id }) => map.buildings.map(b => ({ ...move(b), id: id(b.id), nodeId: id(b.nodeId) }))),
    obstacles: across(({ move, id }) => map.obstacles.map(o => structuredClone({ ...move(o), id: id(o.id), ...(o.buildingId ? { buildingId: id(o.buildingId) } : {}) }))),
    gates: across(({ move, id }) => map.gates.map(g => ({ ...move(g), id: id(g.id), ...(g.buildingId ? { buildingId: id(g.buildingId) } : {}) }))),
    hazards: across(({ move }) => map.hazards.map(move)),
    gaps: across(({ move }) => map.gaps.map(move)),
    stations: across(({ move, id }) => map.stations.map(s => ({ ...move(s), id: id(s.id), nodeId: id(s.nodeId) }))),
    chargers: across(({ move, id }) => map.chargers.map(c => ({ ...move(c), id: id(c.id), nodeId: id(c.nodeId) }))),
    sensors: across(({ move, id }) => map.sensors.map(s => ({ ...move(s), id: id(s.id) }))),
    items: across(({ move, id }) => map.items.map(item => structuredClone({ ...move(item), id: id(item.id),
      ...(item.buildingId ? { buildingId: id(item.buildingId) } : {}), ...(item.nodeId ? { nodeId: id(item.nodeId) } : {}),
      ...(item.instanceId ? { instanceId: id(item.instanceId) } : {}), ...(item.lineageId ? { lineageId: id(item.lineageId) } : {}) }))),
    traps: across(({ move, id, dx, dy }) => map.traps.map(t => ({ ...move(t), id: id(t.id), homeX: t.homeX + dx, homeY: t.homeY + dy }))),
    roofs: map.roofs && across(({ move, id }) => map.roofs.map(r => ({ ...structuredClone(r), id: id(r.id), groupId: id(r.groupId), bounds: move(r.bounds), origin: move(r.origin),
      ...(r.buildingId ? { buildingId: id(r.buildingId) } : {}) }))),
    decals: map.decals && across(({ move }) => map.decals.map(move)),
    physicsProps: map.physicsProps && across(({ move, id }) => map.physicsProps.map(p => ({ ...move(p), id: id(p.id) }))),
    motorSurfaces: map.motorSurfaces && across(({ move, id }) => map.motorSurfaces.map(m => ({ ...move(m), id: id(m.id) }))),
  };
}

function mergeRuns(runs) {
  const out = [];
  for (const [a, b] of runs.sort((p, q) => p[0] - q[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
