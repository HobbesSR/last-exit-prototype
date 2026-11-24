import { discoveryGrid } from '../shared/discovery.ts';
import { navigationClearance } from '../shared/map/navigation.ts';
import { CLIP_SCALE } from '../shared/shape-construction.ts';

// Read the directory once; views are recreated when WebAssembly grows its memory.
export function readRuntimeNavigation(map, getBytes, graphIds, singleRole) {
  const fail = () => { throw new RangeError('Invalid runtime navigation'); };
  const bytes = getBytes();
  if (!(bytes instanceof Uint8Array) || bytes.byteOffset % 8 || bytes.byteLength < 8) fail();
  const byteLength = bytes.byteLength;
  const head = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
  const version = head.getUint32(0, true), count = head.getUint32(4, true);
  if (![1, 2].includes(version) || (singleRole && version !== 2) || count > (bytes.byteLength - 8) / 8) fail();
  const compact = version === 2, Points = compact ? Uint16Array : Float64Array;
  const sections = [], directoryEnd = 8 + count * 8;
  let end = directoryEnd;
  for (let i = 0; i < count; i++) {
    const offset = head.getUint32(8 + i * 8, true), length = head.getUint32(12 + i * 8, true);
    if (offset !== Math.ceil(end / 8) * 8 || offset > bytes.byteLength || length > bytes.byteLength - offset) fail();
    sections.push({ offset, length }); end = offset + length;
  }
  if (end !== bytes.byteLength) fail();
  let buffer, base, views;
  function section(i, Type) {
    const current = getBytes();
    if (!(current instanceof Uint8Array) || current.byteOffset % 8 || current.byteLength !== byteLength) fail();
    if (buffer !== current.buffer || base !== current.byteOffset) { buffer = current.buffer; base = current.byteOffset; views = new Map(); }
    const s = sections[i];
    if (!s || s.length % Type.BYTES_PER_ELEMENT) fail();
    const key = `${i}:${Type.name}`;
    if (!views.has(key)) views.set(key, new Type(buffer, base + s.offset, s.length / Type.BYTES_PER_ELEMENT));
    return views.get(key);
  }
  const header = section(0, Uint32Array);
  const roles = singleRole ? [singleRole] : ['gladiator', 'contestant'];
  const clearances = roles.map(navigationClearance);
  if (header.length !== 2 || header[0] > 1 || header[1] !== roles.length || count !== 1 + roles.length * 8 + header[0] * 5) fail();
  const finite = values => { for (const value of values) if (!Number.isFinite(value)) fail(); };
  const within = (offset, length, total) => { if (offset > total || length > total - offset) fail(); };
  let graph;
  if (header[0]) {
    const geom = section(1, Float64Array), rows = section(2, Uint32Array), owner = section(3, Int32Array);
    const adjacency = section(4, Uint32Array), stands = section(5, Float64Array);
    if (rows.length < 4 || !graphIds || !Array.isArray(graphIds.regions) || !Array.isArray(graphIds.portals)) fail();
    const [cols, down, nr, np] = rows;
    if (!cols || !down || owner.length !== cols * down || geom.length !== 1 + nr * 4 + np * 2 || rows.length !== 4 + nr * 2 + np * 6 || stands.length % 2 || graphIds.regions.length !== nr || graphIds.portals.length !== np || geom[0] <= 0) fail();
    finite(geom); finite(stands);
    if ([...graphIds.regions, ...graphIds.portals].some(id => typeof id !== 'string')) fail();
    for (const n of owner) if (n < -1 || n >= nr) fail();
    const regions = [];
    for (let i = 0; i < nr; i++) {
      const g = 1 + i * 4, r = 4 + i * 2, start = rows[r], length = rows[r + 1];
      within(start, length, adjacency.length);
      if (geom[g + 2] < 0 || geom[g + 3] < 0) fail();
      const portals = Array.from(adjacency.subarray(start, start + length));
      if (portals.some(p => p >= np)) fail();
      regions.push({ id: graphIds.regions[i], box: { x: geom[g], y: geom[g + 1], w: geom[g + 2], h: geom[g + 3] }, portals });
    }
    const portals = [];
    for (let i = 0; i < np; i++) {
      const r = 4 + nr * 2 + i * 6, g = 1 + nr * 4 + i * 2;
      const region = [rows[r], rows[r + 1]], slots = [rows[r + 2], rows[r + 3]], start = rows[r + 4], length = rows[r + 5];
      within(start, length, stands.length / 2);
      for (let side = 0; side < 2; side++) if (region[side] >= nr || regions[region[side]].portals[slots[side]] !== i) fail();
      const points = Array.from({ length }, (_, j) => ({ x: stands[(start + j) * 2], y: stands[(start + j) * 2 + 1] }));
      portals.push({ id: graphIds.portals[i], x: geom[g], y: geom[g + 1], regions: region, slots, stands: points });
    }
    for (let i = 0; i < nr; i++) for (const p of regions[i].portals) if (!portals[p].regions.includes(i)) fail();
    graph = { cellSize: geom[0], cols, rows: down, regions, portals, get owner() { return section(3, Int32Array); } };
  } else if (graphIds != null) fail();
  const grid = discoveryGrid(map), layers = [];
  for (let layer = 0; layer < header[1]; layer++) {
    const s = 1 + header[0] * 5 + layer * 8;
    const config = section(s, Float64Array), dims = section(s + 1, Uint32Array), rows = section(s + 2, Uint32Array), geometry = section(s + 3, Float64Array);
    const points = section(s + 4, Points), ints = section(s + 5, Int32Array), sets = section(s + 6, Uint32Array), members = section(s + 7, Uint32Array);
    if (config.length !== 2 || dims.length !== 2 || !clearances.includes(config[0]) || layers.some(l => l.clearance === config[0]) || config[1] !== grid.size || dims[0] !== grid.cols || dims[1] !== grid.cols * grid.rows || rows.length !== dims[1] * 10 || geometry.length !== dims[1] * 8 || sets.length % 2) fail();
    finite(geometry);
    if (!compact) finite(points);
    for (const slot of members) if (slot >= map.gates.length) fail();
    for (let i = 0; i < sets.length; i += 2) within(sets[i], sets[i + 1], members.length);
    let pointsEnd = 0, intsEnd = 0, setsEnd = 0;
    for (let i = 0; i < dims[1]; i++) {
      const r = i * 10, g = i * 8, [fp, fl, ip, tl, sl, il, lc, lr, setAt, setCount] = rows.subarray(r, r + 10);
      const intCount = tl * 2 + sl + il + tl / 3;
      const x = (i % grid.cols) * grid.size, y = Math.floor(i / grid.cols) * grid.size;
      if (fp !== pointsEnd || ip !== intsEnd || setAt !== setsEnd) fail();
      within(fp, fl, points.length); within(ip, intCount, ints.length); within(setAt, setCount, sets.length / 2);
      pointsEnd += fl; intsEnd += intCount; setsEnd += setCount;
      if (fl % 2 || tl % 3 || sl !== lc * lr + 1 || geometry[g + 2] <= 0 || geometry[g + 7] < 0
          || geometry[g + 3] !== x || geometry[g + 4] !== y
          || geometry[g + 5] !== Math.min(grid.size, map.width - x) || geometry[g + 6] !== Math.min(grid.size, map.height - y)) fail();
      if (compact) {
        const maxX = Math.round(geometry[g + 5] * CLIP_SCALE), maxY = Math.round(geometry[g + 6] * CLIP_SCALE);
        for (let j = fp; j < fp + fl; j += 2) if (points[j] > maxX || points[j + 1] > maxY) fail();
      }
      for (let j = 0; j < tl; j++) {
        const v = ints[ip + j], twin = ints[ip + tl + j];
        if (v < 0 || v >= fl / 2 || twin < -1 || twin >= tl || (twin >= 0 && ints[ip + tl + twin] !== j)) fail();
      }
      const startsAt = ip + tl * 2, itemsAt = startsAt + sl, gateAt = itemsAt + il;
      if (ints[startsAt] !== 0 || ints[startsAt + sl - 1] !== il) fail();
      for (let j = 1; j < sl; j++) if (ints[startsAt + j] < ints[startsAt + j - 1] || ints[startsAt + j] > il) fail();
      for (let j = 0; j < il; j++) if (ints[itemsAt + j] < 0 || ints[itemsAt + j] >= tl / 3) fail();
      for (let j = 0; j < tl / 3; j++) if (ints[gateAt + j] < -1 || ints[gateAt + j] >= setCount) fail();
    }
    if (pointsEnd !== points.length || intsEnd !== ints.length || setsEnd * 2 !== sets.length) fail();
    layers.push({ clearance: config[0], size: config[1], cols: dims[0], count: dims[1], s });
  }
  return { graph, tile(box, clearance) {
    const layer = layers.find(l => l.clearance === clearance);
    if (!layer) return undefined;
    const { x, y } = box;
    const col = x / layer.size, row = y / layer.size, index = row * layer.cols + col;
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= layer.cols || index >= layer.count) return undefined;
    const { s } = layer, rows = section(s + 2, Uint32Array), geo = section(s + 3, Float64Array), r = index * 10, g = index * 8;
    if (geo[g + 3] !== x || geo[g + 4] !== y || geo[g + 5] !== box.w || geo[g + 6] !== box.h) return undefined;
    const [fp, fl, ip, tl, sl, il, lc, lr, setAt, setCount] = rows.subarray(r, r + 10);
    const ints = (start, length) => section(s + 5, Int32Array).subarray(start, start + length);
    const startsAt = ip + tl * 2, itemsAt = startsAt + sl, gateAt = itemsAt + il;
    const sets = section(s + 6, Uint32Array), members = section(s + 7, Uint32Array);
    const gateSets = Array.from({ length: setCount }, (_, i) => Array.from(members.subarray(sets[(setAt + i) * 2], sets[(setAt + i) * 2] + sets[(setAt + i) * 2 + 1]), slot => map.gates[slot].id));
    let prior, cached, decodedPoints;
    function arrays() {
      const current = getBytes();
      if (!prior || prior.buffer !== current.buffer || prior.byteOffset !== current.byteOffset) {
        prior = current;
        const points = section(s + 4, Points).subarray(fp, fp + fl);
        if (compact) decodedPoints ??= Float64Array.from(points, (offset, i) => (i % 2 ? y : x) + offset / CLIP_SCALE);
        cached = { points: decodedPoints ?? points, triangles: ints(ip, tl), twins: ints(ip + tl, tl), starts: ints(startsAt, sl), items: ints(itemsAt, il), gateSet: ints(gateAt, tl / 3) };
      }
      return cached;
    }
    return { clearance, box: { ...box }, reach: geo[g + 7], gateSets,
      get points() { return arrays().points; }, get triangles() { return arrays().triangles; }, get twins() { return arrays().twins; }, get gateSet() { return arrays().gateSet; },
      locator: { x: geo[g], y: geo[g + 1], size: geo[g + 2], cols: lc, rows: lr, get starts() { return arrays().starts; }, get items() { return arrays().items; } } };
  } };
}
