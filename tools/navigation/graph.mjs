import { createClearance } from './clearance.mjs';

// Opposite bits are paired so every edge can be traversed in either direction.
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const FORWARD = [0, 1, 2, 3];

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
}

function point(graph, id) {
  return { x: ((id % graph.cols) + 0.5) * graph.spacing,
    y: (Math.floor(id / graph.cols) + 0.5) * graph.spacing };
}

function supportIds(graph, a, b) {
  const left = Math.max(0, Math.floor((Math.min(a.x, b.x) - graph.radius) / graph.chunkSize));
  const right = Math.min(graph.chunkCols - 1, Math.floor((Math.max(a.x, b.x) + graph.radius) / graph.chunkSize));
  const top = Math.max(0, Math.floor((Math.min(a.y, b.y) - graph.radius) / graph.chunkSize));
  const bottom = Math.min(graph.chunkRows - 1, Math.floor((Math.max(a.y, b.y) + graph.radius) / graph.chunkSize));
  const ids = [];
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) ids.push(y * graph.chunkCols + x);
  return ids;
}

function supported(graph, a, b, allowed) {
  if (!allowed) return true;
  for (const id of supportIds(graph, a, b)) {
    if (!(typeof allowed === 'function' ? allowed(id) : allowed.has(id))) return false;
  }
  return true;
}

/** Read-only sampled experiment graph. No game or generation state is mutated. */
export function bakeGraph(map, { spacing = 24, radius = 14, chunkSize = 192 } = {}) {
  positive(map.width, 'map.width'); positive(map.height, 'map.height');
  positive(spacing, 'spacing'); positive(radius, 'radius'); positive(chunkSize, 'chunkSize');
  const cols = Math.floor(map.width / spacing);
  const rows = Math.floor(map.height / spacing);
  const size = cols * rows;
  const passable = new Uint8Array(size);
  const edges = new Uint8Array(size);
  const clear = createClearance(map, radius);
  const graph = {
    width: map.width, height: map.height, spacing, radius, chunkSize, cols, rows,
    chunkCols: Math.ceil(map.width / chunkSize), chunkRows: Math.ceil(map.height / chunkSize),
    passable, edges, clear,
    point(id) { return point(this, id); },
    support(a, b = a) { return supportIds(this, a, b); },
    chunkSupport(a, b = a) { return supportIds(this, a, b); },
  };
  let nodeCount = 0, edgeCount = 0, boundaryEdges = 0;
  const boundary = new Uint8Array(size);
  for (let id = 0; id < size; id++) {
    const p = point(graph, id);
    if (clear(p, p)) { passable[id] = 1; nodeCount++; }
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const id = y * cols + x;
    if (!passable[id]) continue;
    const a = point(graph, id);
    for (const d of FORWARD) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const next = ny * cols + nx;
      if (!passable[next] || !clear(a, point(graph, next))) continue;
      edges[id] |= 1 << d;
      edges[next] |= 1 << (d + 4);
      edgeCount++;
      const b = point(graph, next);
      if (Math.floor(a.x / chunkSize) !== Math.floor(b.x / chunkSize) ||
          Math.floor(a.y / chunkSize) !== Math.floor(b.y / chunkSize)) {
        boundaryEdges++; boundary[id] = boundary[next] = 1;
      }
    }
  }
  let boundaryNodes = 0;
  for (const b of boundary) boundaryNodes += b;
  Object.assign(graph, {
    nodeCount, edgeCount, boundaryNodes, boundaryEdges,
    // Binary representation: one occupancy byte and one edge byte per sample.
    artifactBytes: passable.byteLength + edges.byteLength + 64,
    // Additional transient boundary flags are excluded; they are not retained.
    estimatedBytes: passable.byteLength + edges.byteLength + 64,
  });
  return graph;
}

class Heap {
  items = [];
  push(item) {
    const h = this.items; let i = h.length; h.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(h[parent], item) <= 0) break;
      h[i] = h[parent]; i = parent;
    }
    h[i] = item;
  }
  pop() {
    const h = this.items, first = h[0], last = h.pop();
    if (h.length) {
      let i = 0;
      while (2 * i + 1 < h.length) {
        let child = 2 * i + 1;
        if (child + 1 < h.length && compare(h[child + 1], h[child]) < 0) child++;
        if (compare(last, h[child]) <= 0) break;
        h[i] = h[child]; i = child;
      }
      h[i] = last;
    }
    return first;
  }
  peek() { return this.items[0]; }
  get length() { return this.items.length; }
}

function compare(a, b) { return a.f - b.f || a.g - b.g || a.id - b.id; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function connectors(graph, p, support) {
  const range = 2 * graph.spacing;
  const xmin = Math.max(0, Math.ceil((p.x - range) / graph.spacing - 0.5));
  const xmax = Math.min(graph.cols - 1, Math.floor((p.x + range) / graph.spacing - 0.5));
  const ymin = Math.max(0, Math.ceil((p.y - range) / graph.spacing - 0.5));
  const ymax = Math.min(graph.rows - 1, Math.floor((p.y + range) / graph.spacing - 0.5));
  const result = new Map();
  for (let y = ymin; y <= ymax; y++) for (let x = xmin; x <= xmax; x++) {
    const id = y * graph.cols + x;
    if (!graph.passable[id]) continue;
    const q = point(graph, id), cost = distance(p, q);
    if (cost <= range && supported(graph, p, q, support) && graph.clear(p, q)) result.set(id, cost);
  }
  return result;
}

/** Create deterministic, resumable search. `support` is a Set or predicate of known chunk IDs. */
export function beginQuery(graph, from, to, { heuristic = true, support = null, direct = true } = {}) {
  let status = null, bestGoal = Infinity, goalId = -1, expansions = 0;
  const count = graph.passable.length;
  let g, prev, closed;
  const heap = new Heap();
  const h = id => heuristic ? distance(point(graph, id), to) : 0;
  const endpointValid = p => Number.isFinite(p?.x) && Number.isFinite(p?.y) && graph.clear(p, p);
  let ends = new Map();
  if (!endpointValid(from) || !endpointValid(to)) status = 'invalid-endpoint';
  else {
    if (direct && supported(graph, from, to, support) && graph.clear(from, to)) {
      bestGoal = distance(from, to);
      status = 'complete';
    }
  }
  if (!status) {
    g = new Float64Array(count); g.fill(Infinity);
    prev = new Int32Array(count); prev.fill(-1);
    closed = new Uint8Array(count);
    const starts = connectors(graph, from, support);
    ends = connectors(graph, to, support);
    for (const [id, cost] of starts) {
      g[id] = cost;
      heap.push({ id, g: cost, f: cost + h(id) });
    }
    if (!heap.length) status = 'no-known-route';
  }
  const privateBytes = () => (g ? 13 * count : 0) + heap.length * 24;
  function result() {
    if (status !== 'complete') return { status, length: Infinity, expansions, path: [], privateBytes: privateBytes() };
    if (goalId < 0) return { status, length: bestGoal, expansions, path: [from, to], privateBytes: privateBytes() };
    const ids = [];
    for (let id = goalId; id >= 0; id = prev[id]) ids.push(id);
    ids.reverse();
    return { status, length: bestGoal, expansions, path: [from, ...ids.map(id => point(graph, id)), to], privateBytes: privateBytes() };
  }
  return {
    step(budget = Infinity) {
      if (!(budget === Infinity || Number.isInteger(budget) && budget >= 0)) throw new RangeError('budget must be a nonnegative integer or Infinity');
      if (status) return result();
      let work = 0;
      while (heap.length && work < budget) {
        if (heap.peek().f >= bestGoal - 1e-10) { status = 'complete'; break; }
        const current = heap.pop();
        if (closed[current.id] || current.g !== g[current.id]) continue;
        closed[current.id] = 1; expansions++; work++;
        const goalCost = ends.get(current.id);
        if (goalCost !== undefined && current.g + goalCost < bestGoal) {
          bestGoal = current.g + goalCost; goalId = current.id;
        }
        const x = current.id % graph.cols, y = Math.floor(current.id / graph.cols);
        const bits = graph.edges[current.id];
        for (let d = 0; d < 8; d++) {
          if (!(bits & (1 << d))) continue;
          const id = (y + DY[d]) * graph.cols + x + DX[d];
          if (closed[id]) continue;
          if (support && !supported(graph, point(graph, current.id), point(graph, id), support)) continue;
          const cost = current.g + (d & 1 ? Math.SQRT2 : 1) * graph.spacing;
          if (cost >= g[id]) continue;
          g[id] = cost; prev[id] = current.id;
          heap.push({ id, g: cost, f: cost + h(id) });
        }
      }
      if (!status) status = !heap.length ? (bestGoal < Infinity ? 'complete' : 'no-known-route') : 'budget-exhausted';
      const answer = result();
      if (status === 'budget-exhausted') status = null;
      return answer;
    },
    get expansions() { return expansions; },
    get privateBytes() { return privateBytes(); },
  };
}

export function queryGraph(graph, from, to, { budget = Infinity, ...options } = {}) {
  return beginQuery(graph, from, to, options).step(budget);
}
